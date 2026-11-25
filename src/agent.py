import logging
from typing import Optional
from src.config import config
from src.llm.client import llm_client
from src.memory.long_term import (
    personal_info, event_store, entity_store, emotion_log,
    topic_profile, followup_store, vector_memory,
)
from src.memory.short_term import short_term_memory
from src.extractor import info_extractor, split_reply_and_meta
from src.characters import get_character, CURRENT_CHARACTER_ID, DEFAULT_CHARACTER

logger = logging.getLogger(__name__)

BASE_SYSTEM_PROMPT = '''{character_prompt}

## 关于用户的已知信息
{personal_context}

## 用户最近的经历
{event_context}

## 情绪轨迹
{emotion_context}

## 用户常提到的人
{entity_context}

## 需要关心的待办事项
{followup_context}

## 相关历史记忆
{memory_context}

## 喜欢的话题
{topic_context}
'''

# 单独成常量、且不参与 .format()：里面的 JSON 花括号会被 format 当成占位符
META_OUTPUT_SPEC = '''
## 输出格式（必须严格遵守）
第一步：只写角色回复正文。自然、口语化、贴合人设，不超过 200 字，**不要**输出任何 JSON、不要解释你在做什么。
第二步：正文写完后，另起一行输出分隔符 <<<META>>>，紧跟一行 JSON：

{"facts":{},"events":[],"entities":[],"current_emotion":{"emotion":"neutral","intensity":5},"followups":[],"topics":[],"forget":{}}

字段规则：
- facts：用户本轮**明确说出的**个人信息，如 {"name":"小林","age":"28"}；用户纠正旧信息时直接给新值（会覆盖旧值）；**本轮没提到的字段不要出现在 facts 里**（不要给空字符串，空值会被忽略）；没有就 {}
- events：[{"title":"一句话标题","description":"细节","event_date":"YYYY-MM-DD或空","emotion":"joy|sadness|anxiety|excited|grateful|anger|fear|neutral","importance":1到10整数,"entities":[{"name":"涉及的人"}],"category":"work|life|study|health|other"}]，只收人生/情绪影响较大的事，日常寒暄不记。event_date 要按对话时间把「昨天/上周/下周」换算成具体日期；实在判断不出就留空
- entities：[{"name":"人名或称呼","relation":"关系","traits":["性格标签"]}]
- current_emotion：用户此刻的情绪与强度 1-10
- followups：[{"description":"之后要问用户的事","due_date":"YYYY-MM-DD 或空"}]
- topics：1-2 个归类词（工作/家庭/情绪/健康/兴趣/学习），不要写具体句子、不要用英文短语
- forget：用户明确说「忘掉/删掉/别再提/记错了」某些记忆时填 {"facts":["字段名"],"events":["事件标题"],"followups":["关键词"]}，否则 {}
没有内容的一律给 {} 或 []。JSON 必须是单行、合法、无注释、无代码围栏。正文里禁止出现 <<<META>>>。
'''

class CompanionAgent:
    def __init__(self):
        self._character_id = CURRENT_CHARACTER_ID

    @property
    def character_id(self):
        return self._character_id

    def switch_character(self, char_id: str) -> dict:
        char = get_character(char_id)
        self._character_id = char_id
        import src.characters as ch
        ch.CURRENT_CHARACTER_ID = char_id
        return char

    def get_character(self) -> dict:
        return get_character(self._character_id)

    def get_startup_greeting(self) -> str:
        from src.memory.long_term import session_snapshot, followup_store
        snapshot = session_snapshot.get_latest()
        char = self.get_character()
        if not snapshot:
            return char['greeting']
        followups = followup_store.get_pending(2)
        if followups:
            parts = [f"欢迎回来～上次你说到："]
            for fu in followups:
                parts.append(f"- {fu['description']}")
            parts.append('现在怎么样了？')
            return "\n".join(parts)
        return char['greeting']

    def make_exit_snapshot(self):
        snap = short_term_memory.make_snapshot()
        from src.memory.long_term import session_snapshot
        session_snapshot.save(
            summary=snap['summary'],
            last_topic=snap['last_topic'],
            emotion=snap['emotion'],
        )

    def _apply_extraction(self, extracted: dict):
        """把结构化记忆写入各个 store。

        模型不保证字段类型（可能把 current_emotion 写成字符串、events 写成字符串数组），
        所以每一项都做类型校验；任何异常只记日志，绝不影响回复。
        """
        if not isinstance(extracted, dict):
            logger.warning(f'记忆数据不是字典，已忽略: {type(extracted)}')
            return
        try:
            facts = extracted.get('facts')
            if isinstance(facts, dict):
                for key, value in facts.items():
                    k = str(key).strip()
                    if not k:
                        continue
                    v = '' if value is None else str(value).strip()
                    if v == '':
                        # 空值一律跳过。模型没提取到时会返回空串，若当成「删除」，
                        # 会把正则刚写进去的姓名/年龄当场抹掉。
                        # 真正的删除只走 forget 字段。
                        continue
                    personal_info.set(k, v, sensitive=k in ('phone', 'address'))

            # 用户主动要求删除的记忆
            forget = extracted.get('forget')
            if isinstance(forget, dict):
                for k in (forget.get('facts') or []):
                    if isinstance(k, str) and k.strip():
                        personal_info.delete(k.strip())
                for t in (forget.get('events') or []):
                    if isinstance(t, str) and t.strip():
                        event_store.delete(title=t.strip())
                for f in (forget.get('followups') or []):
                    if isinstance(f, str) and f.strip():
                        followup_store.delete(keyword=f.strip())

            for event in (extracted.get('events') or []):
                if not isinstance(event, dict):
                    continue
                if event.get('importance', 0) >= config.memory.event_min_importance:
                    # entities 统一规范成 [{"name":..}]，避免模型给字符串数组污染库
                    raw_ents = event.get('entities') or []
                    ents = []
                    for en in raw_ents:
                        if isinstance(en, dict):
                            if en.get('name'):
                                ents.append(en)
                        elif isinstance(en, str) and en.strip():
                            ents.append({'name': en.strip()})
                    event_store.add(
                        title=event.get('title', ''),
                        description=event.get('description', ''),
                        event_date=event.get('event_date'),
                        emotion=event.get('emotion', 'neutral'),
                        importance=event.get('importance', 5),
                        entities=ents,
                        category=event.get('category', 'other'),
                    )

            for ent in (extracted.get('entities') or []):
                if not isinstance(ent, dict):
                    continue
                if ent.get('name'):
                    entity_store.upsert(
                        name=ent['name'],
                        relation=ent.get('relation', ''),
                        traits=ent.get('traits', []),
                    )

            em = extracted.get('current_emotion')
            if not isinstance(em, dict):
                em = {}
            if em.get('emotion'):
                short_term_memory.set_emotion(em['emotion'])

            for fu in (extracted.get('followups') or []):
                if not isinstance(fu, dict):
                    continue
                if fu.get('description'):
                    followup_store.add(description=fu['description'], due_date=fu.get('due_date'))

            for topic in (extracted.get('topics') or []):
                if not isinstance(topic, str) or not topic:
                    continue
                topic_profile.touch(topic, emotion=em.get('emotion', 'neutral'))
                short_term_memory.touch_topic(topic)
        except Exception as e:
            logger.warning(f'记忆写入失败（不影响回复）: {e}')

    def process_message(self, user_message: str) -> str:
        # 1) 正则先抓显式事实：零模型调用
        try:
            self._apply_extraction({'facts': info_extractor.regex_facts(user_message)})
        except Exception as e:
            logger.warning(f'正则提取失败: {e}')

        personal_context = personal_info.get_context_text() or '暂无已知个人信息'
        event_context = event_store.get_context_text() or '暂无记录的核心事件'
        entity_context = entity_store.get_context_text() or '暂无'
        emotion_context = emotion_log.get_context_text() or '暂无情绪记录'
        followup_context = followup_store.get_context_text() or '暂无待办'
        topic_context = topic_profile.get_context_text() or '暂无偏好数据'
        relevant_memories = self._retrieve_memories(user_message)
        memory_context = '\n'.join(relevant_memories) if relevant_memories else '暂无相关记忆'
        sensitive = topic_profile.get_sensitive()
        sensitive_str = ', '.join(sensitive) if sensitive else '暂无'

        char = self.get_character()
        # Handle custom prompt
        char_prompt = char['system_prompt']
        if char['id'] == 'custom':
            char_prompt = char_prompt.replace('{custom_prompt}', '你是一个由用户自定义的AI陪伴角色。请按照用户设定的性格和行为方式回复。')
        char_prompt = char_prompt.replace('{sensitive_topics}', sensitive_str)

        system_prompt = BASE_SYSTEM_PROMPT.format(
            character_prompt=char_prompt,
            personal_context=personal_context,
            event_context=event_context,
            entity_context=entity_context,
            emotion_context=emotion_context,
            followup_context=followup_context,
            memory_context=memory_context,
            topic_context=topic_context,
            sensitive_topics=sensitive_str,
        ) + META_OUTPUT_SPEC

        short_term_memory.add_user_message(user_message)
        context_messages = short_term_memory.get_context_messages()

        # 2) 一次模型调用同时拿到「回复正文」和「末尾结构化记忆」
        reply, meta = '', {}
        try:
            raw = llm_client.chat(
                messages=context_messages,
                system_prompt=system_prompt,
            )
            reply, meta = split_reply_and_meta(raw)
        except Exception as e:
            logger.error(f'生成回复失败: {e}')
            msg = str(e)
            if 'Free limit' in msg or '402' in msg:
                reply = ("⏳ 免费通道限流了：同一 IP 每 30 秒只能回复 1 次，稍等半分钟再发。\n\n"
                         "想流畅聊天，可在「设置」里把 LLM 后端换成自己的免费 Key"
                         "（例如智谱 GLM-4-Flash，注册即免费且额度高），换个 Key 就没有这个限制。")
            else:
                reply = f"⚠️ 模型调用失败：{msg[:200]}"

        if not reply:
            reply = '……（这次没生成出来，再说一遍？）'

        # 3) 这里拿到的记忆落库；失败只记日志（回归到只影响记忆，不影响聊天）
        self._apply_extraction(meta)

        short_term_memory.add_assistant_message(reply)
        snippet = f'用户: {user_message}\n小伴: {reply}'
        events = meta.get('events') if isinstance(meta, dict) else None
        importance = max((m['importance'] for m in (events or [])
                          if isinstance(m, dict) and isinstance(m.get('importance'), int)), default=3)
        vector_memory.add(snippet, metadata={'type': 'conversation_turn'}, importance=importance)
        return reply

    def _retrieve_memories(self, query: str) -> list:
        try:
            return vector_memory.search(query)
        except Exception as e:
            logger.warning(f'记忆检索失败: {e}')
            return []

    def show_status(self) -> dict:
        return {
            'llm_backend': llm_client.active_backend,
            'llm_model': llm_client.active_model,
            'character': self._character_id,
            'short_term_turns': short_term_memory.turn_count,
            'has_summary': bool(short_term_memory.get_summary()),
            'personal_info_count': len(personal_info.get_all()),
            'event_count': event_store.count(),
            'entity_count': len(entity_store.get_all()),
            'vector_memory_count': vector_memory.count(),
            'pending_followups': len(followup_store.get_pending()),
        }

    def reset_conversation(self):
        short_term_memory.reset()

agent = CompanionAgent()