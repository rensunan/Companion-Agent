import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
ROOT_DIR = Path(__file__).resolve().parent.parent

@dataclass
class LLMConfig:
    ollama_base_url: str = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434/v1')
    ollama_model: str = os.getenv('OLLAMA_MODEL', 'Echo-N1')
    api_base_url: str = os.getenv('API_BASE_URL', 'https://api.openai.com/v1')
    api_key: str = os.getenv('API_KEY', '')
    api_model: str = os.getenv('API_MODEL', 'gpt-4o-mini')
    temperature: float = 0.7
    max_tokens: int = 2048
    extract_temperature: float = 0.1
    extract_max_tokens: int = 1024

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
