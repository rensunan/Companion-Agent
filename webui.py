import sys, json, os
from pathlib import Path
from datetime import datetime
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gradio as gr
from src.agent import agent
from src.characters import list_characters, list_by_gender
from src.memory.long_term import personal_info, event_store, entity_store, followup_store, emotion_log, topic_profile, vector_memory
from src.memory.short_term import short_term_memory
from src.memory.long_term import clear_all_long_term, cleanup_duplicates
from src.llm.client import llm_client
from src.config import config

CHAR_LIST = list_characters()
MALE_CHARS = list_by_gender("male")
FEMALE_CHARS = list_by_gender("female")
NEUTRAL_CHARS = list_by_gender("neutral")

def _labels(chars):
    return [f"{c['emoji']} {c['name']}" for c in chars]

def _id_map(chars):
    return {f"{c['emoji']} {c['name']}": c['id'] for c in chars}

MALE_LABELS = _labels(MALE_CHARS)
FEMALE_LABELS = _labels(FEMALE_CHARS)
NEUTRAL_LABELS = _labels(NEUTRAL_CHARS)

MALE_ID_MAP = _id_map(MALE_CHARS)
FEMALE_ID_MAP = _id_map(FEMALE_CHARS)
NEUTRAL_ID_MAP = _id_map(NEUTRAL_CHARS)

# 全部角色
CHAR_LABELS = MALE_LABELS + FEMALE_LABELS + NEUTRAL_LABELS

# 两级选择：性别 → 角色
GENDER_MAP = {
    '🚹 男性': MALE_LABELS,
    '🚺 女性': FEMALE_LABELS,
    '🚻 中性': NEUTRAL_LABELS,
}
GENDER_OPTIONS = list(GENDER_MAP.keys())
CHAR_ID_MAP = {**MALE_ID_MAP, **FEMALE_ID_MAP, **NEUTRAL_ID_MAP}
DATA_DIR = Path(__file__).resolve().parent / 'data'
JOURNAL_FILE = DATA_DIR / 'journal.json'

def get_status_md():
    s = agent.show_status()
    char = agent.get_character()
    info = personal_info.get_all()
    key = (config.llm.api_key or '').strip()
    lines = [f"#### {char['emoji']} {char['name']}"]
    if 'pollinations' in (config.llm.api_base_url or ''):
        lines.append(f"- 模型： 🆓 免费通道 · {s['llm_model']}（无需 Key）")
    elif not key or key.startswith('sk-your-'):
        lines.append('- ⚠️ 未配置 API Key，对话暂不可用')
    else:
        lines.append(f"- LLM： {s['llm_backend']} / {s['llm_model']}")
    lines.append(f"- 对话： {s['short_term_turns']} 轮 · 向量： {s['vector_memory_count']} 条 · 事件： {s['event_count']}")
    if info:
        lines.append('')
        lines.append('**已记住的信息**')
        for k, v in info.items():
            lines.append(f'- {k}: {v}')
    return chr(10).join(lines)

def on_page_load():
    """页面加载/刷新时重新读库：Gradio 组件的初始 value 在服务启动时就固定了，
    必须靠 load 事件回填，否则刷新后聊天记录和仪表盘都是空的。"""
    return (short_term_memory.history_for_ui(), get_hero_html(), get_status_md(), get_dashboard_html())


def save_personal_info(key, value):
    """界面上直接改/删个人信息：值留空即删除该字段"""
    key = (key or '').strip()
    if not key:
        return '⚠️ 请先填字段名（name / age / occupation …）'
    val = (value or '').strip()
    if not val:
        ok = personal_info.delete(key)
        return f'✅ 已删除字段 `{key}`' if ok else f'⚠️ 没有 `{key}` 这个字段'
    personal_info.set(key, val, sensitive=key in ('phone', 'address'))
    return f'✅ 已更新 `{key}` = {val}'


def run_cleanup():
    s = cleanup_duplicates()
    return (f"✅ 清理完成：合并重复事件 {s['events']} 条 · "
            f"删除重复待追问 {s['followups']} 条 · 修剪碎话题 {s['topics']} 个")


def clear_pending_followups():
    n = len(followup_store.get_pending(999))
    followup_store.clear_all()
    return f'✅ 已清空 {n} 条待追问' if n else '本来就没有待追问'


def get_dashboard_html():
    sp = ', '
    parts = []
    if not any([personal_info.get_all(), event_store.get_recent(1), entity_store.get_all(),
                followup_store.get_pending(1), emotion_log.get_recent(1),
                topic_profile.get_favorites(1), topic_profile.get_sensitive(), load_journal()]):
        return ("<div class='xb-empty'>还没有任何记忆数据。<br>"
                "去「💬 聊天」和角色聊几句，<b>个人信息 · 核心事件 · 人物关系 · 情绪轨迹</b> 会自动沉淀到这里。</div>")

    info = personal_info.get_all()
    if info:
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-amber'>📋 个人信息</h3>")
        for k, v in info.items():
            parts.append(f"<div class='xb-row'><span class='xb-key'>{k}：</span>{v}</div>")
        parts.append("<p class='xb-meta'>记错了就在下方「编辑记忆」直接改，不用反复在对话里纠正。</p>")
        parts.append('</div>')

    events = event_store.get_recent(20)
    if events:
        events = sorted(events, key=lambda x: (x.get('event_date') or '', x.get('id') or 0), reverse=True)[:10]
        EM = {'joy': '喜', 'sadness': '悲', 'anxiety': '虑', 'excited': '奋',
              'grateful': '恩', 'anger': '怒', 'fear': '惧', 'neutral': '平'}
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-violet'>📅 核心事件 · 时间线</h3>")
        for e in events:
            d = e.get('event_date') or '日期未记录'
            imp = int(e.get('importance') or 5)
            parts.append("<div class='xb-item'>")
            parts.append(f"<b class='xb-strong'>[{EM.get(e.get('emotion'), '?')}] {e.get('title', '')}</b>")
            parts.append(f"<span class='xb-meta gap'>{d}</span>")
            if e.get('description'):
                parts.append(f"<p class='xb-desc'>{e['description']}</p>")
            parts.append(f"<div class='xb-bar-track'><div class='xb-bar-fill' style='width:{imp * 10}%'></div></div>")
            parts.append(f"<span class='xb-meta'>{imp}/10</span>")
            parts.append('</div>')
        parts.append('</div>')

    ents = entity_store.get_all()
    if ents:
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-pink'>👥 人物关系</h3>")
        for e in ents:
            t = sp.join(e.get('traits', []))
            parts.append("<div class='xb-item'>")
            parts.append(f"<b class='xb-strong'>{e['name']}</b>")
            parts.append(f"<span class='xb-meta gap'>{e.get('relation') or '关系未标注'}</span>")
            if t:
                parts.append(f"<p class='xb-meta'>{t}</p>")
            parts.append('</div>')
        parts.append('</div>')

    fus = followup_store.get_pending(10)
    if fus:
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-red'>⏰ 待追问</h3>")
        for f in fus:
            dd = f.get('due_date')
            ds = f"<span class='xb-meta gap'>{dd}</span>" if dd else ''
            parts.append(f"<div class='xb-row'>· {f['description']}{ds}</div>")
        parts.append('</div>')

    EM2 = {'joy': '喜', 'sadness': '悲', 'anxiety': '虑', 'excited': '奋',
           'grateful': '恩', 'anger': '怒', 'fear': '惧', 'neutral': '平'}
    trend = emotion_log.get_trend(30)
    recent = emotion_log.get_recent(5)
    parts.append("<div class='xb-card'>")
    parts.append("<h3 class='xb-card-title c-green'>📊 情绪趋势</h3>")
    parts.append(f"<p class='xb-row'>{trend}</p>")
    for r in recent:
        it = int(r['intensity'] or 5)
        parts.append(f"<div class='xb-row'>[{EM2.get(r['emotion'], '?')}] {r['emotion']} "
                     f"<div class='xb-bar-track'><div class='xb-bar-fill' style='width:{it * 10}%'></div></div>"
                     f"<span class='xb-meta'>{it}/10</span></div>")
    parts.append('</div>')

    fav = topic_profile.get_favorites(10)
    sens = topic_profile.get_sensitive()
    if fav or sens:
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-cyan'>🏷️ 话题偏好</h3>")
        if fav:
            parts.append(f"<p class='xb-row'>✅ 常聊：{sp.join(fav)}</p>")
        if sens:
            parts.append(f"<p class='xb-row'>⚠️ 敏感：{sp.join(sens)}</p>")
        parts.append('</div>')

    jrn = load_journal()
    if jrn:
        parts.append("<div class='xb-card'>")
        parts.append("<h3 class='xb-card-title c-violet'>📔 情绪日记</h3>")
        for j in jrn[-7:]:
            parts.append("<div class='xb-item'>")
            parts.append(f"<span class='xb-meta'>{j.get('date', '')}</span>")
            parts.append(f"<span class='xb-tag'>{j.get('emotion', '')}</span>")
            parts.append(f"<p class='xb-desc'>{j.get('summary', '')[:200]}</p>")
            parts.append('</div>')
        parts.append('</div>')

    return ''.join(parts)


def load_journal():
    if JOURNAL_FILE.exists():
        return json.loads(JOURNAL_FILE.read_text(encoding='utf-8'))
    return []

def save_journal(summary, emotion):
    jrn = load_journal()
    today = datetime.now().strftime('%Y-%m-%d')
    ex = [j for j in jrn if j['date'] == today]
    if ex:
        ex[0]['summary'] = summary
        ex[0]['emotion'] = emotion
    else:
        jrn.append({'date': today, 'summary': summary, 'emotion': emotion})
    jrn = jrn[-30:]
    JOURNAL_FILE.write_text(json.dumps(jrn, ensure_ascii=False, indent=2), encoding='utf-8')

def make_journal_entry():
    summ = short_term_memory.get_summary()
    em = short_term_memory.get_last_emotion()
    if not summ:
        msgs = short_term_memory._messages
        if msgs:
            summ = chr(10).join([f"{m['role']}: {m['content'][:100]}" for m in msgs[-6:]])
    if summ:
        save_journal(summ[:500], em)
    return get_journal_html()

def get_journal_html():
    jrn = load_journal()
    if not jrn:
        return "<div class='xb-empty'>还没有日记。<br>聊几句后点上方按钮，把当天对话整理成一篇<b>情绪日记</b>。</div>"
    em_cn = {'joy': '开心', 'sadness': '难过', 'anxiety': '焦虑', 'excited': '兴奋',
             'grateful': '感恩', 'anger': '生气', 'fear': '害怕', 'neutral': '平静'}
    parts = ["<div class='xb-card'>", "<h3 class='xb-card-title c-violet'>情绪日记</h3>"]
    for j in reversed(jrn[-14:]):
        parts.append("<div class='xb-item'>")
        parts.append(f"<span class='xb-meta'>{j.get('date', '')}</span>")
        parts.append(f"<span class='xb-tag'>{em_cn.get(j.get('emotion'), j.get('emotion', ''))}</span>")
        parts.append(f"<p class='xb-desc'>{j.get('summary', '')}</p>")
        parts.append('</div>')
    parts.append('</div>')
    return ''.join(parts)


def respond(message, history):
    if not message.strip(): return '', history
    now = datetime.now().strftime('%H:%M')
    history.append({'role': 'user', 'content': f'[{now}] {message}'})
    try:
        resp = agent.process_message(message)
    except Exception as e:
        resp = (f"⚠️ 模型调用失败：{e}\n\n"
                "请确认已配置可用的 LLM：在 .env 中填写 API_BASE_URL / API_KEY / API_MODEL，"
                "或让本地 Ollama 运行起来。")
    now2 = datetime.now().strftime('%H:%M')
    history.append({'role': 'assistant', 'content': f'[{now2}] {resp}'})
    return '', history

def update_char_choices(gender_label):
    """性别下拉联动：切换分组时刷新角色下拉的候选项"""
    opts = GENDER_MAP.get(gender_label, MALE_LABELS)
    return gr.update(choices=opts, value=(opts[0] if opts else None))


def switch_character(choice):
    if not choice or str(choice).startswith('─'):
        return gr.update(), '👆 请先在右侧选择一位角色', gr.update()
    cid = CHAR_ID_MAP.get(choice, 'warm_friend')
    char = agent.switch_character(cid)
    greet = agent.get_startup_greeting()
    # 切换角色不清空已有对话，只追加新角色的开场白
    history = short_term_memory.history_for_ui(40)
    if greet:
        history = history + [{'role': 'assistant', 'content': greet}]
    return history, f"✅ 已切换为 {char['emoji']} **{char['name']}**", get_hero_html()

def do_search(query):
    query = (query or '').strip()
    if not query: return ''
    res = vector_memory.search(query, top_k=5)
    if not res:
        if not getattr(vector_memory, '_collection', None):
            return ("<div class='xb-empty'>当前未启用<b>向量语义检索</b>"
                    "（运行环境缺少 chromadb / sentence-transformers）。<br>"
                    "结构化记忆仍在工作，可到「📊 记忆仪表盘」查看。</div>")
        return f"<div class='xb-empty'>没有找到与「{query}」相关的记忆</div>"
    html = [f"<p class='xb-sec-title'>「{query}」· {len(res)} 条相关记忆</p>"]
    for i, r in enumerate(res, 1):
        html.append("<div class='xb-mem'>")
        html.append(f"<span class='xb-mem-idx'>#{i}</span>")
        html.append(f"<p class='xb-mem-text'>{r}</p>")
        html.append('</div>')
    return ''.join(html)

def do_export():
    return {'personal_info': personal_info.get_all(), 'events': event_store.get_recent(100), 'entities': entity_store.get_all(), 'followups': followup_store.get_pending(100), 'journal': load_journal()}

def apply_settings(backend, model, temperature):
    if 'Ollama' in str(backend): config.llm.ollama_model = model
    else: config.llm.api_model = model
    config.llm.temperature = float(temperature)
    return f'✅ 设置已更新： {backend} / {model} / temp={temperature}'

def handle_clear_memory(confirmed):
    if not confirmed:
        return True, '⚠️ 你确定要清除所有长期记忆吗？\n\n这将**不可恢复**地删除：\n- 所有个人信息\n- 所有核心事件\n- 所有人物关系\n- 所有情绪记录\n- 所有话题偏好\n- 所有待追问\n- 所有向量记忆\n\n**再次点击按钮确认清除**', gr.update(variant='stop', value='⚠️ 再次确认清除全部记忆')
    else:
        clear_all_long_term()
        short_term_memory.reset()
        return [], '✅ 所有长期记忆和当前对话已清除', gr.update(variant='stop', value='🗑️ 清除长期记忆')


CUSTOM_PROMPT = ''
def set_custom_prompt(prompt):
    global CUSTOM_PROMPT
    CUSTOM_PROMPT = prompt
    return '自定义 Prompt 已保存。切换到「自定义角色」即可使用。'

def get_hero_html():
    """顶部 Hero：当前角色 + 运行状态徽章"""
    char = agent.get_character()
    s = agent.show_status()
    color = char.get('color', '#f59e0b')
    key = (config.llm.api_key or '').strip()
    is_free = 'pollinations' in (config.llm.api_base_url or '')
    if is_free:
        llm_badge = "<span class='xb-badge'>🆓 免费通道 · 无需 Key</span>"
    elif not key or key.startswith('sk-your-'):
        llm_badge = "<span class='xb-badge warn'>⚠️ 未配置模型</span>"
    elif s['llm_backend'] == 'ollama':
        llm_badge = f"<span class='xb-badge'>🧠 Ollama · {s['llm_model']}</span>"
    else:
        llm_badge = f"<span class='xb-badge'>🧠 {s['llm_model']}</span>"
    return f"""
<div class='xb-hero' style='--xb-char-color:{color}'>
  <div class='xb-orb'>{char.get('emoji', '💛')}</div>
  <div class='xb-titles'>
    <p class='xb-title'>小伴 · {char.get('name', '陪伴伙伴')}</p>
    <p class='xb-sub'>{char.get('description', '你的陪伴伙伴')}</p>
  </div>
  <div class='xb-badges'>
    {llm_badge}
    <span class='xb-badge b-violet'>💬 {s['short_term_turns']} 轮</span>
    <span class='xb-badge b-cyan'>🗂 {s['vector_memory_count']} 条记忆</span>
    <span class='xb-badge b-pink'>📅 {s['event_count']} 事件</span>
  </div>
</div>"""


# ============================================================
# UI Layout
# ============================================================

CSS = (Path(__file__).parent / 'assets' / 'style.css').read_text(encoding='utf-8')


HEAD = """
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a1220">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💛</text></svg>">
<script>
(function () {
  var KEY = 'xb-theme';
  var root = document.documentElement;

  function paint(t) {
    root.setAttribute('data-theme', t);
    var b = document.getElementById('xb-theme-toggle');
    if (b) {
      b.textContent = (t === 'dark') ? '\\u2600\\uFE0F' : '\\uD83C\\uDF19';
      b.title = (t === 'dark') ? '切换到白天' : '切换到黑夜';
    }
    try { localStorage.setItem(KEY, t); } catch (e) {}
  }

  var saved = 'dark';
  try { saved = localStorage.getItem(KEY) || 'dark'; } catch (e) {}
  paint(saved);

  function mount() {
    var b = document.getElementById('xb-theme-toggle');
    if (!b) {
      b = document.createElement('button');
      b.id = 'xb-theme-toggle';
      b.className = 'xb-theme-toggle';
      b.type = 'button';
      document.body.appendChild(b);
    }
    b.addEventListener('click', function () {
      paint(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    paint(root.getAttribute('data-theme') || 'dark');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

/* Gradio 的下拉面板用 position:fixed 锚在打开那一刻的视口坐标上，页面一滚动就停在原地。
   这里在滚动/缩放时按输入框的实时位置重新摆一遍。 */
function xbRealignDropdowns() {
  var opts = document.querySelectorAll('.xb-dd .options');
  var i, el, wrap, box, r;
  for (i = 0; i < opts.length; i++) {
    el = opts[i];
    if (getComputedStyle(el).display === 'none') continue;
    wrap = el.closest('.xb-dd');
    if (!wrap) continue;
    box = wrap.querySelector('input');
    if (!box) continue;
    r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    el.style.top = (r.bottom + 6) + 'px';
    el.style.left = r.left + 'px';
    el.style.width = Math.max(r.width, 180) + 'px';
  }
}
window.addEventListener('scroll', xbRealignDropdowns, true);
window.addEventListener('resize', xbRealignDropdowns);
</script>
"""

THEME = gr.themes.Soft(
    primary_hue='amber',
    secondary_hue='indigo',
    neutral_hue='slate',
    radius_size='lg',
)

with gr.Blocks(title='小伴 · 陪伴智能体') as demo:
    hero = gr.HTML(get_hero_html())

    with gr.Tabs():
        # TAB 1: Chat
        with gr.TabItem('💬 聊天'):
            with gr.Row(equal_height=False):
                with gr.Column(scale=7, min_width=400):
                    chatbot = gr.Chatbot(label='', height=560, elem_classes='xb-chat', show_label=False,
                                         value=short_term_memory.history_for_ui(),
                                         placeholder='在右侧选一位角色，然后说点什么…')
                    with gr.Row(elem_classes='xb-composer'):
                        msg = gr.Textbox(placeholder='和 TA 说点什么…（Enter 发送 / Shift+Enter 换行）', label='', scale=8, container=False)
                        send_btn = gr.Button('发送', variant='primary', scale=1)
                    with gr.Row():
                        reset_btn = gr.Button('🔄 重置对话', variant='secondary', size='sm')
                        save_btn = gr.Button('💾 保存快照', variant='secondary', size='sm')
                        journal_btn = gr.Button('📔 写日记', variant='secondary', size='sm')

                with gr.Column(scale=3, min_width=300):
                    with gr.Accordion('🎭 角色切换', open=True):
                        gender_dd = gr.Dropdown(choices=GENDER_OPTIONS, value=GENDER_OPTIONS[0],
                                                label='性别分组', interactive=True, elem_classes='xb-dd')
                        char_dd = gr.Dropdown(choices=MALE_LABELS, value=MALE_LABELS[0],
                                              label='角色', interactive=True, elem_classes='xb-dd')
                        char_confirm_btn = gr.Button('✅ 切换选中角色', variant='primary', size='sm')

                    with gr.Accordion('⚙️ 设置', open=False):
                        backend_dd = gr.Dropdown(choices=['Ollama', 'Api'], value=llm_client.active_backend.title(), label='LLM 后端', interactive=True)
                        model_txt = gr.Textbox(value=llm_client.active_model, label='模型名称', interactive=True)
                        gr.Markdown("<div class='xb-hint'>默认走免费通道：同一 IP 每 30 秒 1 次回复。换成自己的 Key（如智谱 GLM-4-Flash）后无此限制。</div>")
                        temp_slider = gr.Slider(minimum=0.0, maximum=2.0, value=config.llm.temperature, step=0.1, label='温度 (Temperature)', interactive=True)
                        settings_btn = gr.Button('✅ 应用设置', variant='secondary', size='sm')
                        settings_msg = gr.Markdown('')
                        gr.Markdown('---')
                        gr.Markdown('### ⚠️ 危险操作')
                        clear_mem_btn = gr.Button('🗑️ 清除长期记忆', variant='stop', size='sm')
                        clear_mem_state = gr.State(False)
                        clear_mem_msg = gr.Markdown('')

                    with gr.Accordion('🎭 自定义角色', open=False):
                        custom_prompt = gr.Textbox(lines=6, placeholder='输入自定义 System Prompt...', label='System Prompt')
                        custom_save_btn = gr.Button('💾 保存 Prompt', variant='secondary', size='sm')
                        custom_msg = gr.Markdown('')

                    with gr.Accordion('📌 当前状态', open=True):
                        status_md = gr.Markdown(get_status_md(), elem_classes='xb-status')
                        refresh_btn = gr.Button('🔄 刷新状态', variant='secondary', size='sm')

        # TAB 2: Dashboard
        with gr.TabItem('📊 记忆仪表盘') as tab_dash:
            with gr.Row(elem_classes='xb-toolbar'):
                refresh_dash_btn = gr.Button('🔄 刷新', variant='primary', size='sm')
                clear_short_btn = gr.Button('🧹 清空短期记忆', variant='secondary', size='sm')
                journal_dash_btn = gr.Button('📔 生成今日日记', variant='secondary', size='sm')
                export_btn = gr.Button('📥 导出 JSON', variant='secondary', size='sm')
            with gr.Accordion('✏️ 编辑记忆（改名 / 改年龄 / 删字段 / 清重复）', open=False):
                with gr.Row():
                    info_key = gr.Textbox(label='字段名', placeholder='name / age / occupation', scale=2, container=True)
                    info_val = gr.Textbox(label='新值（留空＝删除该字段）', placeholder='例如 30', scale=3, container=True)
                    info_save_btn = gr.Button('💾 保存', variant='primary', size='sm')
                with gr.Row():
                    clean_btn = gr.Button('🧹 清理重复记录', variant='secondary', size='sm')
                    clear_fu_btn = gr.Button('🗑️ 清空待追问（不可恢复）', variant='stop', size='sm')
                edit_msg = gr.Markdown('')
            dash_html = gr.HTML(value=get_dashboard_html())
            export_output = gr.JSON(label='导出数据', visible=False)

        # TAB 3: Search
        with gr.TabItem('🔍 搜索记忆'):
            with gr.Row(elem_classes='xb-composer'):
                search_query = gr.Textbox(placeholder='搜索你与 TA 之间的历史记忆…', label='', scale=8, container=False)
                search_btn = gr.Button('🔍 搜索', variant='primary', scale=1)
            search_条结果 = gr.HTML(value="<div class='xb-empty'>输入关键词，检索你与 TA 之间的<b>历史记忆</b></div>")

        # TAB 4: 📔 情绪日记
        with gr.TabItem('📔 情绪日记'):
            journal_gen_btn = gr.Button('📔 生成今日日记', variant='primary')
            journal_display = gr.HTML(value="<div class='xb-empty'>点击上方按钮，把今天的对话整理成一篇<b>情绪日记</b></div>")

    # ===== BIND EVENTS =====
    demo.load(on_page_load, None, [chatbot, hero, status_md, dash_html])
    tab_dash.select(get_dashboard_html, None, dash_html)
    msg.submit(respond, [msg, chatbot], [msg, chatbot]).then(get_hero_html, None, hero)
    send_btn.click(respond, [msg, chatbot], [msg, chatbot]).then(get_hero_html, None, hero)
    reset_btn.click(lambda: (agent.reset_conversation(), [], '🔄 对话已重置'), None, [chatbot, status_md])
    save_btn.click(lambda: (agent.make_exit_snapshot(), '💾 快照已保存'), None, status_md)

    gender_dd.change(update_char_choices, gender_dd, char_dd)
    char_confirm_btn.click(switch_character, char_dd, [chatbot, status_md, hero])
    refresh_btn.click(get_status_md, None, status_md)
    refresh_dash_btn.click(get_dashboard_html, None, dash_html)
    info_save_btn.click(save_personal_info, [info_key, info_val], edit_msg).then(get_dashboard_html, None, dash_html)
    clean_btn.click(run_cleanup, None, edit_msg).then(get_dashboard_html, None, dash_html)
    clear_fu_btn.click(clear_pending_followups, None, edit_msg).then(get_dashboard_html, None, dash_html)
    clear_short_btn.click(lambda: (short_term_memory.reset(), get_dashboard_html()), None, dash_html)
    journal_btn.click(make_journal_entry, None, dash_html)
    journal_dash_btn.click(make_journal_entry, None, dash_html)
    journal_gen_btn.click(lambda: get_journal_html(), None, journal_display)
    export_btn.click(do_export, None, export_output)
    search_btn.click(do_search, search_query, search_条结果)
    search_query.submit(do_search, search_query, search_条结果)
    settings_btn.click(apply_settings, [backend_dd, model_txt, temp_slider], settings_msg)
    clear_mem_btn.click(handle_clear_memory, clear_mem_state, [clear_mem_state, clear_mem_msg, clear_mem_btn]).then(lambda: [], None, chatbot)
    custom_save_btn.click(set_custom_prompt, custom_prompt, custom_msg)

if __name__ == '__main__':
    # 云端部署：监听 0.0.0.0 + 平台注入的 PORT；本地默认 7860
    _port = int(os.getenv('PORT', '7860'))
    demo.launch(
        server_name=os.getenv('SERVER_NAME', '0.0.0.0'),
        server_port=_port,
        share=False,
        theme=THEME,
        css=CSS,
        head=HEAD,
    )