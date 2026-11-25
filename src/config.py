import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
ROOT_DIR = Path(__file__).resolve().parent.parent

def _default_extract_with_llm() -> bool:
    """免费通道限流严格（每 IP 30 秒 1 次），默认跳过 LLM 信息提取，改用正则。
    换成自己的服务后自动启用；也可用 EXTRACT_WITH_LLM=0/1 强制指定。"""
    env = os.getenv('EXTRACT_WITH_LLM')
    if env is not None:
        return env == '1'
    return 'pollinations' not in os.getenv('API_BASE_URL', 'https://text.pollinations.ai/openai')


@dataclass
class LLMConfig:
    ollama_base_url: str = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434/v1')
    ollama_model: str = os.getenv('OLLAMA_MODEL', 'Echo-N1')
    # 默认走免密钥的公开 OpenAI 兼容通道（免费额度、有速率限制）。
    # 想换成自己的服务或本地代理，在 .env 里覆盖这三项即可，无需改代码。
    api_base_url: str = os.getenv('API_BASE_URL', 'https://text.pollinations.ai/openai')
    api_key: str = os.getenv('API_KEY', 'sk-free-channel')
    api_model: str = os.getenv('API_MODEL', 'openai')
    temperature: float = 0.7
    max_tokens: int = 2048
    extract_temperature: float = 0.1
    extract_max_tokens: int = 1024
    extract_with_llm: bool = field(default_factory=_default_extract_with_llm)

@dataclass
class EmbeddingConfig:
    local_model: str = os.getenv('LOCAL_EMBEDDING_MODEL', 'BAAI/bge-small-zh-v1.5')

@dataclass
class MemoryConfig:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv('DATA_DIR', str(ROOT_DIR / 'data'))))
    short_term_max_turns: int = int(os.getenv('SHORT_TERM_MAX_TURNS', '20'))
    summary_trigger_turns: int = int(os.getenv('SUMMARY_TRIGGER_TURNS', '15'))
    retrieval_top_k: int = int(os.getenv('MEMORY_RETRIEVAL_TOP_K', '5'))
    event_min_importance: int = int(os.getenv('EVENT_MIN_IMPORTANCE', '7'))
    top_events_inject: int = int(os.getenv('TOP_EVENTS_INJECT', '5'))
    top_followups_inject: int = int(os.getenv('TOP_FOLLOWUPS_INJECT', '3'))
    decay_days: int = int(os.getenv('MEMORY_DECAY_DAYS', '30'))

    @property
    def chroma_path(self) -> str: return str(self.data_dir / 'chroma')
    @property
    def sqlite_path(self) -> str: return str(self.data_dir / 'companion.db')

@dataclass
class Config:
    llm: LLMConfig = field(default_factory=LLMConfig)
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    memory: MemoryConfig = field(default_factory=MemoryConfig)

config = Config()
