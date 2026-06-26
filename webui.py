import sys, json, os
from pathlib import Path
from datetime import datetime
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gradio as gr
from src.agent import agent
from src.characters import list_characters, list_by_gender
from src.memory.long_term import personal_info, event_store, entity_store, followup_store, emotion_log, topic_profile, vector_memory
from src.memory.short_term import short_term_memory
from src.memory.long_term import clear_all_long_term
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

# Combined with section separators
CHAR_LABELS = ["── 🚹 男性 ──"] + MALE_LABELS + ["── 🚺 女性 ──"] + FEMALE_LABELS + ["── 🚻 中性 ──"] + NEUTRAL_LABELS
CHAR_ID_MAP = {**MALE_ID_MAP, **FEMALE_ID_MAP, **NEUTRAL_ID_MAP}
DATA_DIR = Path(__file__).resolve().parent / 'data'
JOURNAL_FILE = DATA_DIR / 'journal.json'

def get_status_md():
    s = agent.show_status()
    char = agent.get_character()
    info = personal_info.get_all()
    lines = [f"### {char['emoji']} {char['name']}"]
    lines.append(f"- LLM： {s['llm_backend']} / {s['llm_model']}")
    lines.append(f"- 对话： {s['short_term_turns']}轮 | 向量： {s['vector_memory_count']}条 | 事件： {s['event_count']}")
    if info:
        lines.append('')
        lines.append('**已记住的信息**')
        for k, v in info.items():
            lines.append(f'- {k}: {v}')
    return chr(10).join(lines)

def get_dashboard_html():
    sp = ', '
    parts = []
    BG = 'background:#1e293b;border-radius:12px;padding:16px;margin:8px 0'
    CI = 'background:rgba(255,255,255,0.03);border-radius:8px'

    info = personal_info.get_all()
    if info:
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#f59e0b;margin:0 0 8px'>📋 个人信息</h3>")
        for k, v in info.items():
            parts.append(f"<div style='color:#e2e8f0;padding:4px'><span style='color:#94a3b8'>{k}:</span> {v}</div>")
        parts.append('</div>')

    events = event_store.get_recent(10)
    if events:
        EM = {'joy':'喜','sadness':'悲','anxiety':'虑','excited':'奋','grateful':'恩','anger':'怒','fear':'惧','neutral':'平'}
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#8b5cf6;margin:0 0 8px'>📅 核心事件</h3>")
        for e in events:
            d = e.get('event_date','')
            bar = chr(9608)*e['importance'] + chr(9617)*(10-e['importance'])
            parts.append(f"<div style='margin:6px 0;padding:8px;{CI}'>")
            parts.append(f"<b style='color:#e2e8f0'>[{EM.get(e['emotion'],'?')}] {e['title']}</b>")
            parts.append(f"<span style='color:#64748b;margin-left:8px'>{d}</span>")
            parts.append(f"<br><span style='font-size:11px;color:#f59e0b'>{bar}</span> {e['importance']}/10")
            parts.append('</div>')
        parts.append('</div>')

    ents = entity_store.get_all()
    if ents:
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#ec4899;margin:0 0 8px'>👥 人物关系</h3>")
        for e in ents:
            t = sp.join(e.get('traits',[]))
            parts.append(f"<div style='margin:4px 0;padding:8px;{CI}'>")
            parts.append(f"<b style='color:#e2e8f0'>{e['name']}</b>")
            parts.append(f"<span style='color:#94a3b8'> - {e['relation']}</span>")
            if t: parts.append(f"<br><span style='font-size:11px;color:#64748b'>{t}</span>")
            parts.append('</div>')
        parts.append('</div>')

    fus = followup_store.get_pending(10)
    if fus:
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#ef4444;margin:0 0 8px'>⏰ 待追问</h3>")
        for f in fus:
            dd = f.get('due_date','')
            ds = f" <span style='color:#f59e0b;font-size:11px'>({dd})</span>" if dd else ''
            parts.append(f"<div style='color:#e2e8f0;padding:4px'>- {f['description']}{ds}</div>")
        parts.append('</div>')

    trend = emotion_log.get_trend(30)
    recent = emotion_log.get_recent(5)
    parts.append(f"<div style='{BG}'>")
    parts.append("<h3 style='color:#10b981;margin:0 0 8px'>📊 情绪趋势</h3>")
    parts.append(f"<p style='color:#e2e8f0'>{trend}</p>")
    if recent:
        EM2 = {'joy':'喜','sadness':'悲','anxiety':'虑','excited':'奋','grateful':'恩','anger':'怒','fear':'惧','neutral':'平'}
        for r in recent:
            bar2 = chr(9608)*r['intensity'] + chr(9617)*(10-r['intensity'])
            parts.append(f"<div style='color:#e2e8f0'>[{EM2.get(r['emotion'],'?')}] {r['emotion']} <span style='color:#f59e0b'>{bar2}</span> {r['intensity']}/10</div>")
    parts.append('</div>')

    fav = topic_profile.get_favorites(10)
    sens = topic_profile.get_sensitive()
    if fav or sens:
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#3b82f6;margin:0 0 8px'>🏷️ 话题偏好</h3>")
        if fav: parts.append(f"<p style='color:#10b981'>✅ 喜欢： {sp.join(fav)}</p>")
        if sens: parts.append(f"<p style='color:#ef4444'>⚠️ 敏感： {sp.join(sens)}</p>")
        parts.append('</div>')

    jrn = load_journal()
    if jrn:
        parts.append(f"<div style='{BG}'>")
        parts.append("<h3 style='color:#a78bfa;margin:0 0 8px'>📔 情绪日记</h3>")
        for j in jrn[-7:]:
            parts.append(f"<div style='margin:4px 0;padding:8px;{CI}'>")
            parts.append(f"<span style='color:#64748b;font-size:11px'>{j['date']}</span>")
            parts.append(f"<span style='color:#f59e0b;margin-left:8px'>{j['emotion']}</span>")
            parts.append(f"<p style='color:#e2e8f0;margin:4px 0'>{j['summary'][:200]}</p>")
            parts.append('</div>')
        parts.append('</div>')

    if not parts: parts.append("<div style='text-align:center;color:#64748b;padding:40px'>暂无数据，开始聊天吧！</div>")
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
        return "<div style='color:#64748b;text-align:center;padding:40px'>暂无日记，去聊天后点击生成</div>"
    parts = []
    BG = 'background:#1e293b;border-radius:12px;padding:16px;margin:8px 0'
    CI = 'background:rgba(255,255,255,0.03);border-radius:8px'
    parts.append(f"<div style='{BG}'>")
    parts.append("<h3 style='color:#a78bfa;margin:0 0 12px'>情绪日记</h3>")
    for j in reversed(jrn[-14:]):
        parts.append(f"<div style='margin:6px 0;padding:12px;{CI}'>")
        parts.append(f"<span style='color:#64748b;font-size:12px'>{j['date']}</span>")
        em_cn = {"joy":"开心","sadness":"难过","anxiety":"焦虑","excited":"兴奮","grateful":"感恩","anger":"生气","fear":"害怕","neutral":"平静"}
        em_label = em_cn.get(j['emotion'], j['emotion'])
        parts.append(f"<span style='color:#f59e0b;margin-left:8px;font-size:14px'>{em_label}</span>")
        parts.append(f"<p style='color:#e2e8f0;margin:6px 0;white-space:pre-wrap;line-height:1.6'>{j['summary']}</p>")
        parts.append("</div>")
    parts.append("</div>")
    return ''.join(parts)

def respond(message, history):
    if not message.strip(): return '', history
    now = datetime.now().strftime('%H:%M')
    history.append({'role': 'user', 'content': f'[{now}] {message}'})
    resp = agent.process_message(message)
    now2 = datetime.now().strftime('%H:%M')
    history.append({'role': 'assistant', 'content': f'[{now2}] {resp}'})
    return '', history

def switch_character(choice):
    if not choice or choice.startswith('─'):
        return [], "请选择一个角色", "请先选择一个角色", "#f59e0b"
    cid = CHAR_ID_MAP.get(choice, 'warm_friend')
    char = agent.switch_character(cid)
    greet = agent.get_startup_greeting()
    color = char.get('color', '#f59e0b')
    return [], greet, f"✅ 已切换为 {char['emoji']} {char['name']}", color

def get_char_bg_css(char_id):
    char = agent.get_character()
    color = char.get('color', '#f59e0b')
    emoji = char.get('emoji', '')
    # Generate gradient background
    css = f'''
    <style>
    .chat-bg-overlay {{
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none; z-index: 0; opacity: 0.06;
        background: radial-gradient(ellipse at 70% 30%, {color}44 0%, transparent 60%),
                    radial-gradient(ellipse at 30% 70%, {color}22 0%, transparent 50%);
    }}
    .chat-bg-emoji {{
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        font-size: 280px; opacity: 0.04; pointer-events: none; z-index: 0;
        animation: float 8s ease-in-out infinite;
    }}
    @keyframes float {{
        0%, 100% {{ transform: translate(-50%, -50%) rotate(0deg); }}
        50% {{ transform: translate(-50%, -52%) rotate(5deg); }}
    }}
    </style>
    <div class="chat-bg-overlay"></div>
    <div class="chat-bg-emoji">{emoji}</div>
    '''
    return css

def do_search(query):
    if not query.strip(): return ''
    条结果 = vector_memory.search(query, top_k=5)
    if not 条结果:
        return f"<div style='color:#94a3b8;text-align:center;padding:20px'>未找到与 '{query}'</div>"
    html = [f"<h3 style='color:#3b82f6'>搜索 '{query}': {len(条结果)} 条结果</h3>"]
    for i, r in enumerate(条结果, 1):
        html.append(f"<div style='margin:8px 0;padding:12px;background:rgba(59,130,246,0.08);border-radius:8px;border-left:3px solid #3b82f6'>")
        html.append(f"<span style='color:#64748b;font-size:11px'>#{i}</span>")
        html.append(f"<p style='color:#e2e8f0;margin:4px 0;white-space:pre-wrap'>{r}</p>")
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

# ============================================================
# UI Layout
# ============================================================

CSS = '''
.gradio-container { max-width: 1400px !important; }
/* Chat background - character themed */
#component-0 { position: relative; }
.chat-background {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    opacity: 0.08; pointer-events: none; z-index: 0;
    background-size: 200px; background-position: center;
    background-repeat: repeat;
    transition: all 1.5s ease;
}
/* Message bubble styling */
.bubble-wrap { position: relative; z-index: 1; }
.message-row { position: relative; z-index: 1; }
'''

with gr.Blocks(title='XiaoBan Companion') as demo:
    gr.Markdown('# 小伴 - 你的陪伴伙伴')

    with gr.Tabs():
        # TAB 1: Chat
        with gr.TabItem('💬 聊天'):
            with gr.Row():
                with gr.Column(scale=3):
                    bg_html = gr.HTML(value="<div class='chat-bg-overlay'></div><div class='chat-bg-emoji'>💛</div>", visible=True, elem_classes="chat-background")
                    chatbot = gr.Chatbot(label='', height=520)
                    with gr.Row():
                        msg = gr.Textbox(placeholder='输入消息... (Enter 发送)', label='', scale=5, container=False)
                        send_btn = gr.Button('发送', variant='primary', scale=1)
                    with gr.Row():
                        reset_btn = gr.Button('🔄 重置对话', variant='secondary', size='sm')
                        save_btn = gr.Button('💾 保存快照', variant='secondary', size='sm')
                        journal_btn = gr.Button('📔 写日记', variant='secondary', size='sm')

                with gr.Column(scale=1):
                    with gr.Accordion('🎭 角色切换', open=True):
                        char_radio = gr.Radio(choices=CHAR_LABELS, value=None, label='', interactive=True)
                        char_confirm_btn = gr.Button('✅ 切换选中角色', variant='primary', size='sm')
                        char_color = gr.Textbox(value='#f59e0b', label='角色主色', visible=False)

                    with gr.Accordion('⚙️ 设置', open=False):
                        backend_dd = gr.Dropdown(choices=['Ollama', 'Api'], value=llm_client.active_backend.title(), label='LLM 后端', interactive=True)
                        model_txt = gr.Textbox(value=llm_client.active_model, label='模型名称', interactive=True)
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

                    status_md = gr.Markdown(get_status_md())
                    refresh_btn = gr.Button('🔄 刷新状态', variant='secondary', size='sm')

        # TAB 2: Dashboard
        with gr.TabItem('📊 记忆仪表盘'):
            with gr.Row():
                refresh_dash_btn = gr.Button('🔄 刷新', variant='primary')
                clear_short_btn = gr.Button('🧹 清空短期记忆', variant='secondary', size='sm')
                journal_dash_btn = gr.Button('📔 生成今日日记', variant='secondary', size='sm')
                export_btn = gr.Button('📥 导出 JSON', variant='secondary', size='sm')
            dash_html = gr.HTML(value=get_dashboard_html())
            export_output = gr.JSON(label='导出数据', visible=False)

        # TAB 3: Search
        with gr.TabItem('🔍 搜索记忆'):
            with gr.Row():
                search_query = gr.Textbox(placeholder='搜索历史记忆...', label='', scale=5)
                search_btn = gr.Button('🔍 搜索记忆', variant='primary', scale=1)
            search_条结果 = gr.HTML(value="<div style='color:#64748b;text-align:center;padding:40px'>搜索你的 conversation history</div>")

        # TAB 4: 📔 情绪日记
        with gr.TabItem('📔 情绪日记'):
            journal_gen_btn = gr.Button('📔 生成今日日记', variant='primary')
            journal_display = gr.HTML(value="<div style='color:#64748b;text-align:center;padding:40px'>Click to generate today journal</div>")

    # ===== BIND EVENTS =====
    msg.submit(respond, [msg, chatbot], [msg, chatbot])
    send_btn.click(respond, [msg, chatbot], [msg, chatbot])
    reset_btn.click(lambda: (agent.reset_conversation(), [], '对话已重置'), None, [chatbot, status_md])
    save_btn.click(lambda: (agent.make_exit_snapshot(), '快照已保存'), None, status_md)


    char_confirm_btn.click(switch_character, char_radio, [chatbot, status_md, status_md, char_color]).then(lambda c: get_char_bg_css(''), char_color, bg_html)
    refresh_btn.click(get_status_md, None, status_md)
    refresh_dash_btn.click(get_dashboard_html, None, dash_html)
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
    demo.launch(server_name='127.0.0.1', server_port=7860, share=False, theme=gr.themes.Soft(), css=CSS)