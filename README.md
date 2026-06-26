# 陪伴智能体 — 小伴

一个温暖、善解人意的 AI 陪伴伙伴，具备长期记忆能力，能记住你的个人信息并在对话中自然引用。

## 核心能力

**长期记忆**
- **个人信息库**：自动识别并存储姓名、手机号、年龄、职业、爱好等，支持随时更新
- **向量语义记忆**：所有重要对话自动存入向量数据库，能跨会话检索相关记忆

**短期记忆**
- 滑动窗口保留最近 N 轮对话
- 对话过长时自动摘要压缩，摘要同步存入向量记忆

**智能降级**
- 优先使用本地 Ollama 模型（Echo-N1），低延迟、数据不出本地
- Ollama 不可用时自动降级到 OpenAI 兼容 API

**CLI 交互**
- 美化的终端界面（Rich 库）
- 内置命令：查看状态、个人信息、搜索记忆等

## 快速开始

### 1. 安装依赖

```bash
# 创建虚拟环境
python -m venv venv
venv\Scripts\activate   # Windows
# source venv/bin/activate  # macOS/Linux

# 安装依赖
pip install -r requirements.txt
```

### 2. 配置

```bash
# 复制环境变量模板
copy .env.example .env   # Windows
# cp .env.example .env   # macOS/Linux

# 编辑 .env，填入你的配置
```

**两种运行方式：**

| 方式 | 需要配置 | 说明 |
|------|---------|------|
| 本地 Ollama | 安装 Ollama 并拉取 Echo-N1 模型 | 隐私最佳，无需联网 |
| API 接口 | `API_BASE_URL` + `API_KEY` + `API_MODEL` | 适合没有 GPU 的情况 |

### 3. 运行

```bash
python -m src.main
```

### 4. 运行测试

```bash
python tests/test_smoke.py
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 查看系统状态（模型、记忆等） |
| `/info` | 查看已记住的个人信息 |
| `/reset` | 重置当前对话 |
| `/memory [关键词]` | 搜索历史记忆 |
| `/exit` | 退出 |

## 项目结构

```
陪伴Agent/
├── .env.example          # 环境变量模板
├── .gitignore
├── requirements.txt      # Python 依赖
├── README.md
├── data/                 # 运行时数据 (自动生成)
│   ├── personal_info.db  # SQLite 个人信息
│   └── chroma/           # ChromaDB 向量记忆
├── src/
│   ├── main.py           # CLI 入口
│   ├── agent.py          # 核心 Agent
│   ├── extractor.py      # 信息提取
│   ├── config.py         # 配置管理
│   ├── llm/
│   │   └── client.py     # LLM 客户端 (Ollama + API)
│   └── memory/
│       ├── long_term.py  # 长期记忆 (SQLite + ChromaDB)
│       └── short_term.py # 短期记忆 (窗口 + 摘要)
└── tests/
    └── test_smoke.py     # 烟雾测试
```

## 记忆系统工作原理

```
用户输入 → 信息提取（正则 + LLM）
         ├─ 结构化信息 → SQLite（可更新）
         └─ 对话内容 → ChromaDB 向量库

每次对话：
1. 检索相关历史记忆（向量语义匹配）
2. 加载个人信息上下文
3. 注入 System Prompt
4. 生成回复
5. 新一轮对话存入向量库
```
