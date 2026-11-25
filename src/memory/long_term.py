import json, logging, sqlite3, threading, difflib, os, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    import chromadb
except ImportError:  # 可选依赖：缺失时向量记忆自动降级，其余功能不受影响
    chromadb = None

try:
    from sentence_transformers import SentenceTransformer
except ImportError:  # 可选依赖：缺失时向量记忆自动降级
    SentenceTransformer = None

from src.config import config

logger = logging.getLogger(__name__)

class _DB:
    _conn = None
    _lock = threading.Lock()

    @classmethod
    def get(cls):
        if cls._conn is None:
            path = config.memory.sqlite_path
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(path, check_same_thread=False)
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                chk = conn.execute("PRAGMA integrity_check").fetchone()
                if not chk or chk[0] != 'ok':
                    raise sqlite3.DatabaseError(f"integrity_check: {chk}")
            except sqlite3.DatabaseError as e:
                # 云端旧 WAL 与新库不匹配会报 malformed，直接重建，别让整个应用起不来
                logger.error(f"数据库损坏（{e}），已备份并重建: {path}")
                try:
                    conn.close()
                except Exception:
                    pass
                try:
                    os.replace(path, f"{path}.corrupt-{int(time.time())}")
                except Exception:
                    pass
                for suf in ('-wal', '-shm'):
                    try:
                        os.remove(path + suf)
                    except Exception:
                        pass
                conn = sqlite3.connect(path, check_same_thread=False)
                conn.execute("PRAGMA journal_mode=WAL")
            cls._conn = conn
        return cls._conn

def _now():
    return datetime.now(timezone.utc).isoformat()


def _norm_entities(ents):
    """把事件关联人统一成 [{'name':..}] 并去重，接受 dict / str 混合输入。"""
    names = []
    for e in ents or []:
        n = e.get('name') if isinstance(e, dict) else str(e)
        n = (n or '').strip()
        if n and n not in names:
            names.append(n)
    return [{'name': n} for n in names]


class PersonalInfoStore:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS personal_info ("
                "key TEXT PRIMARY KEY, value TEXT NOT NULL,"
                "is_sensitive INTEGER DEFAULT 0,"
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            db.commit()

    def set(self, key, value, sensitive=False):
        now = _now()
        with _DB._lock:
            db = _DB.get()
            old = db.execute("SELECT value FROM personal_info WHERE key=?", (key,)).fetchone()
            if old:
                db.execute("UPDATE personal_info SET value=?, updated_at=?, is_sensitive=? WHERE key=?", (value, now, int(sensitive), key))
            else:
                db.execute("INSERT INTO personal_info (key,value,is_sensitive,created_at,updated_at) VALUES (?,?,?,?,?)", (key, value, int(sensitive), now, now))
            db.commit()

    def get(self, key):
        row = _DB.get().execute("SELECT value FROM personal_info WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def get_all(self):
        rows = _DB.get().execute("SELECT key,value FROM personal_info ORDER BY updated_at DESC").fetchall()
        return {r[0]: r[1] for r in rows}

    def delete(self, key):
        """删除一个字段（用户说「忘记我的年龄」时用）"""
        with _DB._lock:
            db = _DB.get()
            cur = db.execute("DELETE FROM personal_info WHERE key=?", (key,))
            db.commit()
            return cur.rowcount > 0

    def keys(self):
        return [r[0] for r in _DB.get().execute("SELECT key FROM personal_info").fetchall()]

    def get_context_text(self):
        all_info = self.get_all()
        if not all_info: return ""
        return "[用户个人信息]\n" + "\n".join(f"- {k}: {v}" for k, v in all_info.items())

class EventStore:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS core_events ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "title TEXT NOT NULL, description TEXT NOT NULL,"
                "event_date TEXT, emotion TEXT DEFAULT 'neutral',"
                "importance INTEGER DEFAULT 5,"
                "entities_json TEXT DEFAULT '[]',"
                "category TEXT DEFAULT 'other',"
                "created_at TEXT NOT NULL)"
            )
            db.execute("CREATE INDEX IF NOT EXISTS idx_events_imp ON core_events(importance DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_events_ca ON core_events(created_at DESC)")
            db.commit()

    def add(self, title, description, event_date=None, emotion="neutral", importance=5, entities=None, category="other"):
        if importance < config.memory.event_min_importance:
            return 0
        title = (title or '').strip()
        if not title:
            return 0
        now = _now()
        ents = _norm_entities(entities)
        with _DB._lock:
            db = _DB.get()
            # 同标题事件不再重复插入：合并描述/重要性/关联人（每轮对话都会重新提取同一件事）
            row = db.execute(
                "SELECT id,description,importance,entities_json,event_date FROM core_events WHERE title=?", (title,)).fetchone()
            if row:
                old_id, old_desc, old_imp, old_ents, old_date = row
                merged = _norm_entities(json.loads(old_ents or '[]') + ents)
                db.execute(
                    "UPDATE core_events SET description=?, importance=?, entities_json=?, emotion=?, event_date=? WHERE id=?",
                    (max(old_desc or '', description or '', key=len), max(old_imp or 0, importance),
                     json.dumps(merged, ensure_ascii=False), emotion, event_date or old_date, old_id))
                db.commit()
                return old_id
            cur = db.execute(
                "INSERT INTO core_events (title,description,event_date,emotion,importance,entities_json,category,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (title, description, event_date, emotion, importance, json.dumps(ents, ensure_ascii=False), category, now))
            db.commit()
            return cur.lastrowid

    def delete(self, event_id=None, title=None):
        with _DB._lock:
            db = _DB.get()
            if event_id:
                cur = db.execute("DELETE FROM core_events WHERE id=?", (int(event_id),))
            elif title:
                cur = db.execute("DELETE FROM core_events WHERE title=?", (title.strip(),))
            else:
                return 0
            db.commit()
            return cur.rowcount

    def merge_duplicates(self):
        """历史脏数据清理：把同名事件合并成一条（保留最长描述与最高重要性）。"""
        merged = 0
        with _DB._lock:
            db = _DB.get()
            rows = db.execute(
                "SELECT title, COUNT(*) c FROM core_events GROUP BY title HAVING c > 1").fetchall()
            for title, _c in rows:
                items = db.execute(
                    "SELECT id,description,importance,entities_json,event_date,emotion FROM core_events WHERE title=? ORDER BY id",
                    (title,)).fetchall()
                keep = items[0]
                desc = max((i[1] or '' for i in items), key=len)
                imp = max((i[2] or 0) for i in items)
                ents = []
                for i in items:
                    ents.extend(json.loads(i[3] or '[]'))
                date = next((i[4] for i in items if i[4]), None)
                emo = next((i[5] for i in items if i[5]), 'neutral')
                db.execute(
                    "UPDATE core_events SET description=?, importance=?, entities_json=?, event_date=?, emotion=? WHERE id=?",
                    (desc, imp, json.dumps(_norm_entities(ents), ensure_ascii=False), date, emo, keep[0]))
                db.execute("DELETE FROM core_events WHERE title=? AND id<>?", (title, keep[0]))
                merged += len(items) - 1
            db.commit()
        return merged

    def get_recent(self, limit=5):
        rows = _DB.get().execute(
            "SELECT id,title,description,event_date,emotion,importance,entities_json,category FROM core_events ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"id": r[0], "title": r[1], "description": r[2], "event_date": r[3], "emotion": r[4], "importance": r[5], "entities": json.loads(r[6]), "category": r[7]} for r in rows]

    def count(self):
        return _DB.get().execute("SELECT COUNT(*) FROM core_events").fetchone()[0]

    def get_context_text(self, limit=None):
        if limit is None: limit = config.memory.top_events_inject
        events = self.get_recent(limit)
        if not events: return ""
        lines = ["[用户的核心事件]"]
        for e in events:
            d = f" ({e['event_date']})" if e.get('event_date') else ""
            # entities 可能是 [{"name":..}] 也可能是 ["老板"]（模型偶发输出），两种都要能读
            raw = e.get("entities", []) or []
            names = []
            for en in raw:
                if isinstance(en, dict):
                    n = en.get("name", "")
                else:
                    n = str(en)
                if n:
                    names.append(n)
            ns = " [" + ", ".join(names) + "]" if names else ""
            lines.append(f"- {e['title']}{d} | 情绪: {e['emotion']}{ns}")
        return "\n".join(lines)

class EntityStore:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS entities ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "name TEXT NOT NULL, relation TEXT DEFAULT '',"
                "traits_json TEXT DEFAULT '[]',"
                "first_mentioned TEXT NOT NULL, last_mentioned TEXT NOT NULL)"
            )
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name)")
            db.commit()

    def upsert(self, name, relation="", traits=None):
        now = _now()
        with _DB._lock:
            db = _DB.get()
            old = db.execute("SELECT id,traits_json FROM entities WHERE name=?", (name,)).fetchone()
            if old:
                old_traits = set(json.loads(old[1]))
                new_traits = set(traits or [])
                merged = list(old_traits | new_traits)
                db.execute("UPDATE entities SET relation=?, traits_json=?, last_mentioned=? WHERE id=?", (relation or "", json.dumps(merged, ensure_ascii=False), now, old[0]))
            else:
                db.execute("INSERT INTO entities (name,relation,traits_json,first_mentioned,last_mentioned) VALUES (?,?,?,?,?)", (name, relation, json.dumps(traits or [], ensure_ascii=False), now, now))
            db.commit()

    def get_all(self):
        rows = _DB.get().execute("SELECT name,relation,traits_json FROM entities ORDER BY last_mentioned DESC").fetchall()
        return [{"name": r[0], "relation": r[1], "traits": json.loads(r[2])} for r in rows]

    def get_context_text(self):
        entities = self.get_all()
        if not entities: return ""
        lines = ["[你常提到的人]"]
        for e in entities:
            t = " | " + ", ".join(e["traits"]) if e.get("traits") else ""
            lines.append(f"- {e['name']} ({e['relation']}){t}")
        return "\n".join(lines)

class EmotionLog:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS emotion_log ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "session_id TEXT NOT NULL, emotion TEXT NOT NULL,"
                "intensity INTEGER DEFAULT 5,"
                "trigger_event_id INTEGER, created_at TEXT NOT NULL)"
            )
            db.execute("CREATE INDEX IF NOT EXISTS idx_emotion_ca ON emotion_log(created_at DESC)")
            db.commit()

    def record(self, emotion, intensity=5, trigger_event_id=None):
        now = _now()
        day = now[:10]
        with _DB._lock:
            db = _DB.get()
            # 同一天同情绪的多次记录合并成一条，避免趋势图被同一情绪刷屏
            row = db.execute(
                "SELECT id FROM emotion_log WHERE substr(created_at,1,10)=? AND emotion=?", (day, emotion)).fetchone()
            if row:
                db.execute("UPDATE emotion_log SET intensity=?, created_at=? WHERE id=?",
                           (intensity, now, row[0]))
            else:
                db.execute(
                    "INSERT INTO emotion_log (session_id,emotion,intensity,trigger_event_id,created_at) VALUES (?,?,?,?,?)",
                    ("default", emotion, intensity, trigger_event_id, now))
            db.commit()

    def get_recent(self, limit=20):
        rows = _DB.get().execute("SELECT emotion,intensity,created_at FROM emotion_log ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"emotion": r[0], "intensity": r[1], "created_at": r[2]} for r in rows]

    def get_trend(self, days=7):
        rows = _DB.get().execute(
            "SELECT emotion, COUNT(*) as cnt FROM emotion_log WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY emotion ORDER BY cnt DESC", (str(days),)).fetchall()
        if not rows: return "最近暂无情绪记录"
        trend_map = {"joy": "整体积极向上", "sadness": "有些低落", "anxiety": "焦虑感较强", "excited": "充满激情", "grateful": "心怀感恩", "anger": "有些愤怒", "fear": "恐惧不安", "neutral": "情绪平稳"}
        dominant = rows[0][0]
        total = sum(r[1] for r in rows)
        return f"最近{days}天情绪: {trend_map.get(dominant, dominant)} (共{total}条记录)"

    def get_context_text(self):
        trend = self.get_trend(7)
        recent = self.get_recent(3)
        if not recent: return ""
        lines = [f"[情绪轨迹] {trend}"]
        for r in recent:
            lines.append(f"- {r['emotion']} (强度:{r['intensity']})")
        return "\n".join(lines)

class TopicProfile:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS topic_profile ("
                "topic TEXT PRIMARY KEY, frequency INTEGER DEFAULT 1,"
                "avg_emotion TEXT DEFAULT 'neutral', last_discussed TEXT NOT NULL,"
                "is_sensitive_topic INTEGER DEFAULT 0)"
            )
            db.commit()

    def touch(self, topic, emotion="neutral"):
        now = _now()
        with _DB._lock:
            db = _DB.get()
            old = db.execute("SELECT frequency FROM topic_profile WHERE topic=?", (topic,)).fetchone()
            if old:
                db.execute("UPDATE topic_profile SET frequency=frequency+1, avg_emotion=?, last_discussed=? WHERE topic=?", (emotion, now, topic))
            else:
                db.execute("INSERT INTO topic_profile (topic,frequency,avg_emotion,last_discussed) VALUES (?,1,?,?)", (topic, emotion, now))
            db.commit()

    def mark_sensitive(self, topic):
        now = _now()
        with _DB._lock:
            db = _DB.get()
            old = db.execute("SELECT frequency FROM topic_profile WHERE topic=?", (topic,)).fetchone()
            if not old:
                db.execute("INSERT INTO topic_profile (topic,frequency,avg_emotion,last_discussed,is_sensitive_topic) VALUES (?,1,?,?,1)", (topic, "neutral", now))
            else:
                db.execute("UPDATE topic_profile SET is_sensitive_topic=1 WHERE topic=?", (topic,))
            db.commit()

    def get_favorites(self, limit=5):
        rows = _DB.get().execute("SELECT topic FROM topic_profile WHERE is_sensitive_topic=0 ORDER BY frequency DESC LIMIT ?", (limit,)).fetchall()
        return [r[0] for r in rows]

    def get_sensitive(self):
        rows = _DB.get().execute("SELECT topic FROM topic_profile WHERE is_sensitive_topic=1").fetchall()
        return [r[0] for r in rows]

    def prune(self, keep_min_freq=2):
        """清掉只出现过一次的词，避免话题表变成碎词垃圾场。敏感话题不动。"""
        with _DB._lock:
            db = _DB.get()
            cur = db.execute(
                "DELETE FROM topic_profile WHERE is_sensitive_topic=0 AND frequency < ?", (keep_min_freq,))
            db.commit()
            return cur.rowcount

    def get_context_text(self):
        fav = self.get_favorites(5)
        sens = self.get_sensitive()
        parts = []
        if fav: parts.append("喜欢的话题: " + ", ".join(fav))
        if sens: parts.append("敏感话题(谨慎): " + ", ".join(sens))
        return "\n".join(parts) if parts else ""

class FollowupStore:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS pending_followups ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "description TEXT NOT NULL, due_date TEXT,"
                "status TEXT DEFAULT 'pending',"
                "created_at TEXT NOT NULL, resolved_at TEXT)"
            )
            db.commit()

    def add(self, description, due_date=None):
        desc = (description or '').strip()
        if not desc:
            return 0
        now = _now()
        with _DB._lock:
            db = _DB.get()
            # 同一件事只保留一条待追问（模型每轮都会重新提一遍）
            row = db.execute(
                "SELECT id FROM pending_followups WHERE status='pending' AND description=?", (desc,)).fetchone()
            if row:
                if due_date:
                    db.execute("UPDATE pending_followups SET due_date=? WHERE id=?", (due_date, row[0]))
                    db.commit()
                return row[0]
            cur = db.execute("INSERT INTO pending_followups (description,due_date,status,created_at) VALUES (?,?,?,?)",
                             (desc, due_date, "pending", now))
            db.commit()
            return cur.lastrowid

    def delete(self, fid=None, keyword=None):
        with _DB._lock:
            db = _DB.get()
            if fid:
                cur = db.execute("DELETE FROM pending_followups WHERE id=?", (int(fid),))
            elif keyword:
                cur = db.execute("DELETE FROM pending_followups WHERE description LIKE ?", (f'%{keyword.strip()}%',))
            else:
                return 0
            db.commit()
            return cur.rowcount

    def dedupe(self, threshold=0.78):
        removed = 0
        with _DB._lock:
            db = _DB.get()
            rows = db.execute(
                "SELECT id,description FROM pending_followups WHERE status='pending' ORDER BY id").fetchall()
            kept = []
            for fid, desc in rows:
                dup = False
                for _kid, kdesc in kept:
                    if difflib.SequenceMatcher(None, desc or '', kdesc or '').ratio() >= threshold:
                        dup = True
                        break
                if dup:
                    db.execute("DELETE FROM pending_followups WHERE id=?", (fid,))
                    removed += 1
                else:
                    kept.append((fid, desc))
            db.commit()
        return removed

    def clear_all(self):
        with _DB._lock:
            db = _DB.get()
            cur = db.execute("DELETE FROM pending_followups")
            db.commit()
            return cur.rowcount

    def get_pending(self, limit=None):
        if limit is None: limit = config.memory.top_followups_inject
        rows = _DB.get().execute(
            "SELECT id,description,due_date FROM pending_followups WHERE status='pending' ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"id": r[0], "description": r[1], "due_date": r[2]} for r in rows]

    def resolve(self, fid):
        with _DB._lock:
            _DB.get().execute("UPDATE pending_followups SET status='resolved', resolved_at=? WHERE id=?", (_now(), fid))
            _DB.get().commit()

    def get_context_text(self):
        items = self.get_pending()
        if not items: return ""
        lines = ["[待追问事项 - 请主动关心]"]
        for item in items:
            d = f" (时间: {item['due_date']})" if item.get('due_date') else ""
            lines.append(f"- {item['description']}{d}")
        return "\n".join(lines)

class SessionSnapshot:
    def __init__(self):
        with _DB._lock:
            db = _DB.get()
            db.execute(
                "CREATE TABLE IF NOT EXISTS session_snapshot ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "summary TEXT NOT NULL, last_topic TEXT DEFAULT '',"
                "emotion_at_end TEXT DEFAULT 'neutral',"
                "event_ids_json TEXT DEFAULT '[]',"
                "followup_ids_json TEXT DEFAULT '[]',"
                "created_at TEXT NOT NULL)"
            )
            db.commit()

    def save(self, summary, last_topic="", emotion="neutral", event_ids=None, followup_ids=None):
        now = _now()
        with _DB._lock:
            _DB.get().execute(
                "INSERT INTO session_snapshot (summary,last_topic,emotion_at_end,event_ids_json,followup_ids_json,created_at) VALUES (?,?,?,?,?,?)",
                (summary, last_topic, emotion, json.dumps(event_ids or []), json.dumps(followup_ids or []), now))
            _DB.get().commit()

    def get_latest(self):
        row = _DB.get().execute(
            "SELECT summary,last_topic,emotion_at_end,event_ids_json,followup_ids_json,created_at FROM session_snapshot ORDER BY created_at DESC LIMIT 1").fetchone()
        if not row: return None
        return {"summary": row[0], "last_topic": row[1], "emotion_at_end": row[2], "event_ids": json.loads(row[3]), "followup_ids": json.loads(row[4]), "created_at": row[5]}

class VectorMemoryStore:
    def __init__(self):
        self._embedding_model = None
        self._client = None
        self._collection = None
        self._initialized = False

    def _ensure_init(self):
        if self._initialized: return
        if chromadb is None or SentenceTransformer is None:
            logger.warning("向量记忆不可用：未安装 chromadb / sentence-transformers，已降级为纯 SQLite 记忆")
            return
        try:
            Path(config.memory.chroma_path).mkdir(parents=True, exist_ok=True)
            self._embedding_model = SentenceTransformer(config.embedding.local_model)
            self._client = chromadb.PersistentClient(path=config.memory.chroma_path)
            self._collection = self._client.get_or_create_collection(name="companion_memory", metadata={"hnsw:space": "cosine"})
            self._initialized = True
        except Exception as e:
            logger.error("向量记忆初始化失败: %s", e)
            self._initialized = False

    def _embed(self, text):
        self._ensure_init()
        return self._embedding_model.encode(text).tolist()

    def add(self, text, metadata=None, importance=5):
        self._ensure_init()
        if not self._collection: return ""
        embedding = self._embed(text)
        mem_id = f"mem_{datetime.now(timezone.utc).timestamp()}"
        meta = metadata or {}
        meta["timestamp"] = _now()
        meta["importance"] = importance
        self._collection.add(ids=[mem_id], embeddings=[embedding], documents=[text], metadatas=[meta])
        return mem_id

    def search(self, query, top_k=None):
        self._ensure_init()
        if not self._collection: return []
        k = top_k or config.memory.retrieval_top_k
        embedding = self._embed(query)
        results = self._collection.query(query_embeddings=[embedding], n_results=k)
        return [doc for doc in results.get("documents", [[]])[0] if doc]

    def clear(self):
        self._ensure_init()
        if self._client and self._collection:
            self._client.delete_collection("companion_memory")
            self._collection = self._client.get_or_create_collection(name="companion_memory", metadata={"hnsw:space": "cosine"})

    def count(self):
        self._ensure_init()
        return self._collection.count() if self._collection else 0


def cleanup_duplicates():
    """一次性清理历史脏数据：同名事件合并、重复待追问删除、碎话题修剪。"""
    stats = {'events': 0, 'followups': 0, 'topics': 0}
    try:
        stats['events'] = event_store.merge_duplicates()
    except Exception as e:
        logger.warning(f'事件去重失败: {e}')
    try:
        stats['followups'] = followup_store.dedupe()
    except Exception as e:
        logger.warning(f'待追问去重失败: {e}')
    try:
        stats['topics'] = topic_profile.prune()
    except Exception as e:
        logger.warning(f'话题修剪失败: {e}')
    return stats


def clear_all_long_term():
    with _DB._lock:
        db = _DB.get()
        tables = ["personal_info", "core_events", "entities", "emotion_log", "topic_profile", "pending_followups", "session_snapshot"]
        for t in tables:
            db.execute(f"DELETE FROM {t}")
        db.commit()
    # Also clear vector memory
    vector_memory.clear()
    return True

personal_info = PersonalInfoStore()
event_store = EventStore()
entity_store = EntityStore()
emotion_log = EmotionLog()
topic_profile = TopicProfile()
followup_store = FollowupStore()
session_snapshot = SessionSnapshot()
vector_memory = VectorMemoryStore()


