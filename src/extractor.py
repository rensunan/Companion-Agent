import json, logging, re
from src.config import config
from src.llm.client import llm_client

logger = logging.getLogger(__name__)

# 一次调用模式下，助手回复正文与结构化记忆之间的分隔符
META_MARK = '<<<META>>>'

_EMPTY_META = {
    "facts": {}, "events": [], "entities": [],
    "current_emotion": {"emotion": "neutral", "intensity": 5},
    "followups": [], "topics": [],
}


def split_reply_and_meta(text: str):
    """把「角色回复 + 末尾 JSON 记忆」拆开。

    任何解析异常都必须退化成「整段当作回复、记忆为空」——绝不能让提取失败毁掉回复。
    """
    if not text:
        return "", dict(_EMPTY_META)
    if META_MARK not in text:
        return text.strip(), dict(_EMPTY_META)
    reply, _, tail = text.partition(META_MARK)
    reply = reply.strip()
    tail = tail.strip()
    # 模型有时会套代码围栏
    tail = re.sub(r"^```\w*\s*", "", tail)
    tail = re.sub(r"\s*```$", "", tail).strip()
    # 只取第一个完整 JSON 对象，防止后面跟废话
    start = tail.find("{")
    end = tail.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return reply, dict(_EMPTY_META)
    try:
        meta = json.loads(tail[start:end + 1])
    except Exception as e:
        logger.warning(f"记忆 JSON 解析失败（已忽略，回复照常返回）: {e}")
        return reply, dict(_EMPTY_META)
    if not isinstance(meta, dict):
        return reply, dict(_EMPTY_META)
    merged = dict(_EMPTY_META)
    merged.update(meta)
    return reply, merged


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
        """【已退役】旧的独立提取流程：正则 + 第二次 LLM 调用。

        主流程（CompanionAgent.process_message）现在改用「一次调用」模式：
        回复正文末尾附带 <<<META>>> JSON，用 split_reply_and_meta() 拆开。
        这个方法保留给命令行/调试场景，不要再接回聊天主链路（会白烧一次模型调用）。
        """
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
        if not config.llm.extract_with_llm:
            # 免费通道限流严格：跳过 LLM 提取，只用正则，保证主回复能发出去
            return result
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

    def regex_facts(self, message: str) -> dict:
        """零成本的正则事实抽取（姓名字段、手机号等），供一次调用模式复用"""
        return self._regex_extract(message)

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