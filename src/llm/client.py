# ============================================
# 陪伴智能体 - LLM 客户端
# 策略: 本地 Ollama (Echo-N1) -> API 降级
# ============================================

import logging
from typing import Optional

from openai import OpenAI

from src.config import config

logger = logging.getLogger(__name__)


class LLMClient:
    """LLM 客户端，自动降级"""

    def __init__(self):
        self._ollama_client: Optional[OpenAI] = None
        self._api_client: Optional[OpenAI] = None
        self._ollama_available: Optional[bool] = None

    def _get_ollama_client(self) -> Optional[OpenAI]:
        """获取 Ollama 客户端"""
        if self._ollama_client is None and self._ollama_available is not False:
            try:
                self._ollama_client = OpenAI(
                    base_url=config.llm.ollama_base_url,
                    api_key="ollama",  # Ollama 不需要真实 key
                )
                # 快速检查是否可用
                self._ollama_client.models.list()
                self._ollama_available = True
                logger.info(f"Ollama 连接成功: {config.llm.ollama_base_url}")
            except Exception as e:
                self._ollama_available = False
                self._ollama_client = None
                logger.warning(f"Ollama 不可用: {e}")
        return self._ollama_client

    def _get_api_client(self) -> Optional[OpenAI]:
        """获取 API 客户端"""
        if self._api_client is None:
            if not config.llm.api_key or config.llm.api_key.startswith("sk-your-"):
                logger.error("API_KEY 未配置，请在 .env 中设置")
                return None
            self._api_client = OpenAI(
                base_url=config.llm.api_base_url,
                api_key=config.llm.api_key,
            )
        return self._api_client

    @property
    def active_backend(self) -> str:
        """当前活跃的后端"""
        if self._ollama_available:
            return "ollama"
        return "api"

    @property
    def active_model(self) -> str:
        """当前活跃的模型"""
        if self._ollama_available:
            return config.llm.ollama_model
        return config.llm.api_model

    def chat(
        self,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
    ) -> str:
        """
        发送对话请求，自动选择后端。

        Args:
            messages: [{"role": "user/assistant/system", "content": "..."}]
            temperature: 温度参数
            max_tokens: 最大 token 数
            system_prompt: 系统提示词 (追加到消息列表开头)

        Returns:
            模型回复文本
        """
        # 构建完整消息列表
        full_messages = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        full_messages.extend(messages)

        # 尝试 Ollama
        ollama = self._get_ollama_client()
        if ollama:
            try:
                return self._do_chat(
                    ollama,
                    config.llm.ollama_model,
                    full_messages,
                    temperature or config.llm.temperature,
                    max_tokens or config.llm.max_tokens,
                )
            except Exception as e:
                logger.warning(f"Ollama 请求失败: {e}，降级到 API")
                self._ollama_available = False

        # 降级到 API
        api = self._get_api_client()
        if api:
            return self._do_chat(
                api,
                config.llm.api_model,
                full_messages,
                temperature or config.llm.temperature,
                max_tokens or config.llm.max_tokens,
            )

        raise RuntimeError("无可用的 LLM 后端。请检查 Ollama 是否运行或配置 API_KEY。")

    def _do_chat(
        self,
        client: OpenAI,
        model: str,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
    ) -> str:
        """执行实际的聊天请求"""
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content or ""


# 全局单例
llm_client = LLMClient()
