import logging
from typing import Optional
from src.config import config
from src.llm.client import llm_client
from src.memory.long_term import (
    personal_info, event_store, entity_store, emotion_log,
    topic_profile, followup_store, vector_memory,
)
from src.memory.short_term import short_term_memory
from src.extractor import info_extractor
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

    def process_message(self, user_message: str) -> str:
        extracted = info_extractor.extract(user_message)

        for key, value in extracted.get('facts', {}).items():
            sensitive = key in ('phone', 'address')
            personal_info.set(key, str(value), sensitive=sensitive)

        for event in extracted.get('events', []):
            if event.get('importance', 0) >= config.memory.event_min_importance:
                event_store.add(
                    title=event.get('title', ''),
                    description=event.get('description', ''),
                    event_date=event.get('event_date'),
                    emotion=event.get('emotion', 'neutral'),
                    importance=event.get('importance', 5),
                    entities=event.get('entities', []),
                    category=event.get('category', 'other'),
                )

        for ent in extracted.get('entities', []):
            if ent.get('name'):
                entity_store.upsert(
                    name=ent['name'],
                    relation=ent.get('relation', ''),
                    traits=ent.get('traits', []),
                )

        em = extracted.get('current_emotion', {})
        if em.get('emotion'):
            short_term_memory.set_emotion(em['emotion'])

        for fu in extracted.get('followups', []):
            if fu.get('description'):
                followup_store.add(description=fu['description'], due_date=fu.get('due_date'))

        for topic in extracted.get('topics', []):
            if topic:
                topic_profile.touch(topic, emotion=em.get('emotion', 'neutral'))
                short_term_memory.touch_topic(topic)

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
        )

        short_term_memory.add_user_message(user_message)
        context_messages = short_term_memory.get_context_messages()

        try:
            response = llm_client.chat(
                messages=context_messages,
                system_prompt=system_prompt,
            )
        except Exception as e:
            logger.error(f'生成回复失败: {e}')
            response = "抱歉，我暂时无法回复，请稍后再试..."

        short_term_memory.add_assistant_message(response)
        snippet = f'用户: {user_message}\n小伴: {response}'
        importance = max((e.get('importance', 5) for e in extracted.get('events', [])), default=3)
        vector_memory.add(snippet, metadata={'type': 'conversation_turn'}, importance=importance)
        return response

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