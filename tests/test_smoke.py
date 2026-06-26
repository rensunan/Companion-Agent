import sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PASSED = 0
FAILED = 0

def check(name, condition, detail=''):
    global PASSED, FAILED
    if condition:
        print(f'  PASS {name}')
        PASSED += 1
    else:
        print(f'  FAIL {name}: {detail}')
        FAILED += 1

print('='*50)
print('小伴 v2 - 全功能烟雾测试')
print('='*50)

print('\n[1] 模块导入')
from src.config import config
from src.llm.client import llm_client
from src.memory.long_term import personal_info, event_store, entity_store, emotion_log
from src.memory.long_term import topic_profile, followup_store, session_snapshot, vector_memory
from src.memory.short_term import short_term_memory
from src.extractor import info_extractor
from src.agent import agent
check('所有模块导入', True)

print('\n[2] 配置')
check('event_min_importance=7', config.memory.event_min_importance == 7)
check('top_events_inject=5', config.memory.top_events_inject == 5)

print('\n[3] 个人信息')
personal_info.set('test_name', '测试')
check('新增', personal_info.get('test_name') == '测试')
personal_info.set('test_name', '更新后')
check('更新', personal_info.get('test_name') == '更新后')
personal_info.set('test_phone', '13800000000', sensitive=True)
check('敏感标记', personal_info.get('test_phone') == '13800000000')
check('get_context_text', 'test_name' in personal_info.get_context_text())

print('\n[4] 事件存储')
eid = event_store.add('测试事件', '重要测试', event_date='2026年', emotion='joy', importance=8, category='life_milestone')
check('新增(importance>=7)', eid > 0)
eid_low = event_store.add('不重要', 'x', importance=3)
check('过滤低重要度', eid_low == 0)
check('获取最近事件', len(event_store.get_recent(5)) >= 1)

print('\n[5] 人物实体')
entity_store.upsert('小芳', relation='女朋友', traits=['爱吃火锅', '性格开朗'])
entities = entity_store.get_all()
check('实体存在', any(e['name']=='小芳' for e in entities))
entity_store.upsert('小芳', relation='女朋友', traits=['温柔体贴'])
entities2 = entity_store.get_all()
e = next(e for e in entities2 if e['name']=='小芳')
check('特征合并', len(e['traits']) >= 2)

print('\n[6] 情绪记录')
emotion_log.record('joy', intensity=8)
emotion_log.record('sadness', intensity=3)
check('最近记录', len(emotion_log.get_recent(2)) >= 2)

print('\n[7] 话题偏好')
topic_profile.touch('科幻电影', emotion='joy')
topic_profile.touch('科幻电影', emotion='excited')
topic_profile.touch('工作', emotion='anxiety')
topic_profile.mark_sensitive('原生家庭')
check('喜好话题', '科幻电影' in topic_profile.get_favorites())
check('敏感话题', '原生家庭' in topic_profile.get_sensitive())

print('\n[8] 待追问')
fid = followup_store.add('下周二有面试', due_date='下周二')
check('新增', fid > 0)
check('获取待办', len(followup_store.get_pending()) >= 1)
followup_store.resolve(fid)
check('完成', len(followup_store.get_pending()) == 0)

print('\n[9] 会话快照')
session_snapshot.save('测试摘要', last_topic='测试', emotion='joy')
snap = session_snapshot.get_latest()
check('保存读取', snap is not None and snap['summary']=='测试摘要')

print('\n[10] 短期记忆')
short_term_memory.reset()
short_term_memory.add_user_message('你好')
short_term_memory.add_assistant_message('你好！')
check('轮数', short_term_memory.turn_count == 1)
short_term_memory.set_emotion('happy')
check('情绪记录', short_term_memory.get_last_emotion() == 'happy')

print('\n[11] 信息提取器(正则)')
result = info_extractor._regex_extract('我叫张三，今年25岁，手机13812345678')
check('姓名', result.get('name') == '张三')
check('年龄', result.get('age') == '25')
check('手机', result.get('phone') == '13812345678')

print('\n[12] Agent状态')
status = agent.show_status()
for key in ['llm_backend','llm_model','short_term_turns','personal_info_count','event_count','entity_count','pending_followups']:
    check(f'字段{key}', key in status)

# cleanup
from src.memory.long_term import _DB
db = _DB.get()
db.execute('DELETE FROM personal_info WHERE key LIKE "test_%"')
db.execute('DELETE FROM core_events WHERE title LIKE "测试%" OR title LIKE "不重要%"')
db.execute('DELETE FROM entities WHERE name IN ("小芳")')
db.execute('DELETE FROM emotion_log WHERE 1=1')
db.execute('DELETE FROM topic_profile WHERE 1=1')
db.execute('DELETE FROM pending_followups WHERE 1=1')
db.execute('DELETE FROM session_snapshot WHERE 1=1')
db.commit()

print()
print('='*50)
print(f'结果: {PASSED} 通过, {FAILED} 失败')
print('='*50)
if FAILED > 0: sys.exit(1)