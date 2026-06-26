import json, logging, re
from src.config import config
from src.llm.client import llm_client

logger = logging.getLogger(__name__)

EXTRACT_PROMPT = '''你是一个信息分析助手。分析用户的对话消息，做以下事情：

## 1. 事实提取 (facts)
提取明确说出的个人事实，可以覆盖更新：
- name: 姓名/称呼
- age: 年龄
- birthday: 生日
- phone: 手机号
- occupation: 职业
- address: 地址
- 其他明确的事实

## 2. 核心事件识别 (events)
识别用户话语中的人生重要事件，重要性>=7的才算核心事件：

重要性评分标准：
- 9-10: 人生转折点 (遇到伴侣、结婚、生子、亲人离世、重病康复)
- 7-8: 重要节点 (换工作、升职、毕业、搬家、重要决定)
- 5-6: 有意义的事 (旅行、学到新技能、完成挑战)
- 1-4: 日常琐事 (今天吃了什么等，不记录)

事件分类: life_milestone, career, emotional_peak, major_decision, health, other
情绪标签: joy, sadness, anxiety, excited, grateful, anger, fear, neutral

## 3. 实体/人物识别 (entities)
识别用户提到的人物及关系：
- name: 名字或称呼
- relation: 关系 (如: 女朋友、同事、母亲、朋友)
- traits: 特征 (如: ["爱吃火锅", "性格开朗"])

## 4. 当前情绪 (current_emotion)
- emotion: 情绪标签 (joy/sadness/anxiety/excited/grateful/anger/fear/neutral)
- intensity: 强度 1-10

## 5. 待追问 (followups)
如果用户提到未来的计划、担忧、或重要事项，标记为待追问：
- description: 描述 (如: "下周二有面试")
- due_date: 时间 (如: "下周二")

## 6. 话题 (topics)
用户正在聊的话题关键词列表，如: ["工作", "人际关系", "兴趣爱好"]

规则：
1. 只提取用户明确说出的，不推测
2. 没有对应信息时字段为空数组[]或空对象{}
3. events中重要性必须>=7才放入，<7的不记录
4. 严格按JSON格式输出，不要有任何额外文字

输出格式：
{"facts": {"key": "value"}, "events": [{"title": "", "description": "", "event_date": "", "emotion": "", "importance": 0, "entities": [], "category": ""}], "entities": [{"name": "", "relation": "", "traits": []}], "current_emotion": {"emotion": "", "intensity": 0}, "followups": [{"description": "", "due_date": ""}], "topics": []}

用户消息：
{message}

请分析:'''

class InfoExtractor:
    def __init__(self):
        self._regex_patterns = {
            "name": [
                r"我叫\s*([\u4e00-\u9fa5a-zA-Z]{2,20})",
                r"我的名字[是叫]+\s*([\u4e00-\u9fa5a-zA-Z]{2,20})",
                r"称呼我\s*([\u4e00-\u9fa5a-zA-Z]{2,20})",
                r"你可以叫我\s*([\u4e00-\u9fa5a-zA-Z]{2,20})",
            ],
            "phone": [
                r"1[3-9]\d{9}",
                r"电话[是:\uff1a]?\s*(1[3-9]\d{9})",
                r"手机[号]?[是:\uff1a]?\s*(1[3-9]\d{9})",
            ],
            "age": [
                r"(?:我(?:今年)?|今年)\s*(\d{1,3})\s*岁",
                r"年龄[是:\uff1a]?\s*(\d{1,3})",
            ],
        }

    def extract(self, message: str) -> dict:
        result = {
            "facts": {},
            "events": [],
            "entities": [],
            "current_emotion": {"emotion": "neutral", "intensity": 5},
            "followups": [],
            "topics": [],
        }
        regex_facts = self._regex_extract(message)
        result["facts"].update(regex_facts)
        llm_result = self._llm_extract(message)
        if llm_result:
            if "facts" in llm_result:
                result["facts"].update(llm_result["facts"])
            result["events"] = llm_result.get("events", [])
            result["entities"] = llm_result.get("entities", [])
            if "current_emotion" in llm_result and llm_result["current_emotion"].get("emotion"):
                result["current_emotion"] = llm_result["current_emotion"]
            result["followups"] = llm_result.get("followups", [])
            result["topics"] = llm_result.get("topics", [])
        return result

    def _regex_extract(self, message: str) -> dict:
        result = {}
        for key, patterns in self._regex_patterns.items():
            for pattern in patterns:
                match = re.search(pattern, message)
                if match:
                    value = match.group(1) if match.lastindex else match.group(0)
                    result[key] = value.strip()
                    break
        return result

    def _llm_extract(self, message: str) -> dict:
        try:
            response = llm_client.chat(
                messages=[{"role": "user", "content": message}],
                system_prompt=EXTRACT_PROMPT.replace("{message}", message),
                temperature=config.llm.extract_temperature,
                max_tokens=config.llm.extract_max_tokens,
            )
            response = response.strip()
            if response.startswith("```"):
                response = re.sub(r"^```\w*\n?", "", response)
                response = re.sub(r"\n?```$", "", response)
            return json.loads(response)
        except json.JSONDecodeError:
            logger.debug("LLM提取JSON解析失败")
            return {}
        except Exception as e:
            logger.warning(f"LLM提取失败: {e}")
            return {}

info_extractor = InfoExtractor()