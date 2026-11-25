import logging
from typing import Optional
from src.config import config
from src.memory.long_term import vector_memory, emotion_log, _DB, _now

logger = logging.getLogger(__name__)

class ShortTermMemory:
    def __init__(self):
        self._messages = []
        self._summary = ""
        self._last_emotion = "neutral"
        self._topics_touched = set()
        self._ensure_table()
        self._load_recent()

    # ---------- 持久化：刷新页面或重启服务后对话记录不丢 ----------
    def _ensure_table(self):
        try:
            with _DB._lock:
                db = _DB.get()
                db.execute(
                    "CREATE TABLE IF NOT EXISTS chat_messages ("
                    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                    "role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"
                )
                db.commit()
        except Exception as e:
            logger.warning(f'对话历史表初始化失败: {e}')

    def _persist(self, role, content):
        try:
            with _DB._lock:
                db = _DB.get()
                db.execute("INSERT INTO chat_messages (role,content,created_at) VALUES (?,?,?)",
                           (role, content, _now()))
                db.commit()
        except Exception as e:
            logger.warning(f'对话历史写入失败: {e}')

    def _load_recent(self, limit=None):
        limit = limit or max(config.memory.short_term_max_turns * 2, 20)
        try:
            with _DB._lock:
                rows = _DB.get().execute(
                    "SELECT role,content FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
            self._messages = [{"role": r[0], "content": r[1]} for r in reversed(rows)]
        except Exception as e:
            logger.warning(f'对话历史加载失败: {e}')

    def history_for_ui(self, limit=40):
        """给前端聊天组件用的历史（不含 system 摘要）"""
        return [m for m in self._messages if m.get('role') in ('user', 'assistant')][-limit:]

    def add_user_message(self, content):
        self._messages.append({"role": "user", "content": content})
        self._persist("user", content)
        self._maybe_compress()

    def add_assistant_message(self, content):
        self._messages.append({"role": "assistant", "content": content})
        self._persist("assistant", content)

    def set_emotion(self, emotion):
        self._last_emotion = emotion
        emotion_log.record(emotion)

    def touch_topic(self, topic):
        self._topics_touched.add(topic)

    @property
    def turn_count(self) -> int:
        return len(self._messages) // 2

    def _maybe_compress(self):
        turns = len(self._messages) // 2
        if turns >= config.memory.summary_trigger_turns:
            self._compress()

    def _compress(self):
        keep_turns = 5
        keep_count = keep_turns * 2
        if len(self._messages) <= keep_count: return
        old_messages = self._messages[:-keep_count]
        self._messages = self._messages[-keep_count:]
        summary_text = self._build_raw_summary(old_messages)
        if summary_text:
            self._summary = (self._summary + "\n" + summary_text) if self._summary else summary_text
            vector_memory.add(summary_text, metadata={"type": "conversation_summary"})

    @staticmethod
    def _build_raw_summary(messages):
        parts = []
        for msg in messages:
            role = "用户" if msg["role"] == "user" else "小伴"
            parts.append(f"[{role}]: {msg['content']}")
        return "对话记录:\n" + "\n".join(parts)

    def get_context_messages(self):
        result = []
        if self._summary:
            result.append({"role": "system", "content": "[历史对话摘要]\n" + self._summary + "\n\n请基于以上历史摘要和接下来的对话，保持一致的陪伴风格。"})
        result.extend(self._messages)
        return result

    def get_summary(self):
        return self._summary

    def get_last_emotion(self):
        return self._last_emotion

    def get_topics(self):
        return list(self._topics_touched)

    def make_snapshot(self):
        conversation = (self._summary + "\n" + self._build_raw_summary(self._messages)) if self._summary else self._build_raw_summary(self._messages)
        topics = ", ".join(self._topics_touched) if self._topics_touched else "日常聊天"
        return {"summary": conversation[:2000], "last_topic": topics, "emotion": self._last_emotion}

    def reset(self):
        self._messages = []
        self._summary = ""
        self._last_emotion = "neutral"
        self._topics_touched = set()
        try:
            with _DB._lock:
                db = _DB.get()
                db.execute("DELETE FROM chat_messages")
                db.commit()
        except Exception as e:
            logger.warning(f'清空对话历史失败: {e}')

short_term_memory = ShortTermMemory()