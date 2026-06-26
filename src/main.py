import logging, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from src.config import config
from src.agent import agent
from src.llm.client import llm_client
from src.memory.long_term import personal_info, event_store, entity_store, followup_store, vector_memory, emotion_log, topic_profile
from src.memory.short_term import short_term_memory

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger('companion')
console = Console()

WELCOME_TEXT = '''# 小伴 - 你的陪伴伙伴

你好！我是小伴，一位会记住你的故事和心情的陪伴伙伴。
我会记住你的重要信息、人生事件，陪你聊天、倾听你的心声。

**命令列表：**
- `/help` - 显示此帮助
- `/status` - 查看系统状态
- `/info` - 查看我已记住的你的信息
- `/events` - 查看核心事件
- `/entities` - 查看你常提到的人
- `/followups` - 查看待追问事项
- `/emotion` - 查看情绪轨迹
- `/topics` - 查看话题偏好
- `/memory [关键词]` - 搜索相关记忆
- `/reset` - 重置当前对话
- `/exit` 或 `/quit` - 退出（自动保存快照）
'''

def print_welcome():
    console.print(Markdown(WELCOME_TEXT))
    greeting = agent.get_startup_greeting()
    console.print(Panel(Markdown(greeting), title='小伴', title_align='left', border_style='green'))

def print_status():
    status = agent.show_status()
    table = Table(title='系统状态')
    table.add_column('项目', style='cyan')
    table.add_column('值', style='green')
    for k, v in status.items():
        table.add_row(k, str(v))
    console.print(table)

def print_personal_info():
    info = personal_info.get_all()
    if not info:
        console.print('[dim]暂无个人信息。[/dim]')
        return
    table = Table(title='已记住的个人信息')
    table.add_column('类别', style='cyan')
    table.add_column('内容', style='green')
    for k, v in info.items():
        table.add_row(k, v)
    console.print(table)

def print_events():
    events = event_store.get_recent(20)
    if not events:
        console.print('[dim]暂无核心事件。[/dim]')
        return
    table = Table(title='核心事件')
    table.add_column('#', style='dim')
    table.add_column('标题', style='cyan')
    table.add_column('时间', style='yellow')
    table.add_column('情绪', style='magenta')
    table.add_column('重要度', style='red')
    for i, e in enumerate(events, 1):
        table.add_row(str(i), e['title'], e.get('event_date',''), e['emotion'], str(e['importance']))
    console.print(table)

def print_entities():
    entities = entity_store.get_all()
    if not entities:
        console.print('[dim]暂无人物记录。[/dim]')
        return
    table = Table(title='你常提到的人')
    table.add_column('名字', style='cyan')
    table.add_column('关系', style='green')
    table.add_column('特征', style='yellow')
    for e in entities:
        table.add_row(e['name'], e['relation'], ', '.join(e.get('traits',[])))
    console.print(table)

def print_followups():
    items = followup_store.get_pending(20)
    if not items:
        console.print('[dim]暂无待追问事项。[/dim]')
        return
    table = Table(title='待追问事项')
    table.add_column('#', style='dim')
    table.add_column('描述', style='cyan')
    table.add_column('时间', style='yellow')
    for i, item in enumerate(items, 1):
        table.add_row(str(i), item['description'], item.get('due_date',''))
    console.print(table)

def print_emotion():
    trend = emotion_log.get_trend(30)
    console.print(f'[cyan]{trend}[/cyan]')
    recent = emotion_log.get_recent(10)
    if recent:
        table = Table(title='最近情绪记录')
        table.add_column('情绪', style='magenta')
        table.add_column('强度', style='yellow')
        for r in recent:
            table.add_row(r['emotion'], str(r['intensity']))
        console.print(table)

def handle_command(cmd: str) -> bool:
    cmd = cmd.strip().lower()
    if cmd in ('/exit', '/quit'):
        console.print('[yellow]正在保存会话快照...[/yellow]')
        agent.make_exit_snapshot()
        console.print('[yellow]再见！期待下次聊天~[/yellow]')
        return False
    if cmd == '/help': print_welcome(); return True
    if cmd == '/status': print_status(); return True
    if cmd == '/info': print_personal_info(); return True
    if cmd == '/events': print_events(); return True
    if cmd == '/entities': print_entities(); return True
    if cmd == '/followups': print_followups(); return True
    if cmd == '/emotion': print_emotion(); return True
    if cmd == '/reset':
        agent.reset_conversation()
        console.print('[green]对话已重置。[/green]')
        return True
    if cmd.startswith('/memory'):
        query = cmd.replace('/memory', '').strip()
        if not query: query = Prompt.ask('[dim]输入搜索关键词[/dim]')
        if query:
            memories = vector_memory.search(query, top_k=5)
            if memories:
                for i, text in enumerate(memories, 1):
                    console.print(Panel(text[:500], title=f'#{i}', border_style='dim'))
            else:
                console.print('[dim]没有找到相关记忆。[/dim]')
        return True
    console.print(f'[red]未知命令: {cmd}[/red] 输入 /help 查看帮助')
    return True

def main():
    print_welcome()
    try:
        console.print(f'[dim]当前使用: {llm_client.active_backend} / {llm_client.active_model}[/dim]\n')
    except: pass
    try:
        while True:
            user_input = Prompt.ask('\n[bold cyan]你[/bold cyan]')
            if not user_input.strip(): continue
            if user_input.startswith('/'):
                if not handle_command(user_input): break
                continue
            with console.status('[dim]小伴正在思考...[/dim]', spinner='dots'):
                response = agent.process_message(user_input)
            console.print()
            console.print(Panel(Markdown(response), title='小伴', title_align='left', border_style='green'))
    except KeyboardInterrupt:
        console.print('\n[yellow]正在保存会话快照...[/yellow]')
        agent.make_exit_snapshot()
        console.print('[yellow]再见！[/yellow]')
    except Exception as e:
        logger.exception('程序异常退出')
        console.print(f'\n[red]程序异常: {e}[/red]')

if __name__ == '__main__':
    main()