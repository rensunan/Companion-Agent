/* ============================================================
   小伴 · 网页版
   认证 / 云数据库 / 模型调用 全部走浏览器端云 SDK
   ============================================================ */
(function () {
    'use strict';

    /* ---------- 云服务配置（来自 workbuddy_cloud_service 的 publicConfig） ---------- */
    const CFG = {
        endpoint: 'https://companion-agent-58708.app.workbuddy.host',
        publishableKey: 'wbpk_Xq5lveeMLby8H2WsFVUslk_iY7D13Qh0PXgLjToBECM5dW7c2At3Jyl',
        oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
    };

    const META_MARK = '<<<META>>>';

    const BASE_PROMPT = `{character_prompt}

## 关于用户的已知信息
{personal_context}

## 用户最近的经历
{event_context}

## 情绪轨迹
{emotion_context}

## 用户常提到的人
{entity_context}

## 需要关心的待办事项
{followup_context}

追问规则：
- 下面每条待办后面标了到期时间。已经到期（今天或更早）的，这一轮要自然地把它带进对话问一句，别装作忘了。
- 用户这轮主动聊到相关的人和事时，也可以顺着问，不必等到期。
- 同一条不要连环追问；用户已经回应过的，就当过了，不要再提。
- 追问要像朋友随口一问，不要像念清单。

## 喜欢的话题
{topic_context}
`;

    // 记忆提取独立成一次调用：对话模型只负责聊天、不需要输出任何特殊格式，
    // 因此换成任何模型都不会丢记忆。提取固定用下面这个模型 + 专用 prompt。
    const EXTRACT_MODEL = 'glm-5.3-flash';

    const EMO_CN = { joy: '喜', sadness: '悲', anxiety: '虑', excited: '奋', grateful: '恩', anger: '怒', fear: '惧', neutral: '平' };
    const EMO_LABEL = { joy: '开心', sadness: '难过', anxiety: '焦虑', excited: '兴奋', grateful: '感恩', anger: '生气', fear: '害怕', neutral: '平静' };

    // 实测能调通、且**会按格式输出记忆 JSON** 的模型（2026-11-02 验证）。
    // 关键差别：deepseek-v4-flash / kimi-k2.5 在有历史对话时不输出 <<<META>>>，
    // 会导致记忆全丢；glm-5.3-flash 实测 541 字带完整 JSON，唯一可靠。
    // 其余模型（auto / default / hy3-x 等）要么 0 分片，要么不遵守格式。
    const VERIFIED_MODELS = [
        'glm-5.3-flash',
        'deepseek-v4-flash',
        'deepseek-v4.1-flash',
        'glm-5.2',
        'glm-5.0',
        'glm-5.3',
        'kimi-k2.5',
        'deepseek-v4-pro',
        'deepseek-v3-2-volc',
        'hunyuan-chat',
        'mimo-v2.6-pro',
        'hy3',
        'space-bunny'
    ];

    // 默认对话模型（可随意更换：记忆提取已与对话解耦，换模型不影响记忆写入）
    const DEFAULT_MODEL = 'glm-5.3-flash';

    // 记忆提取专用 prompt：输入最近几轮对话 + 本轮用户消息，只要求输出一行 JSON
    const EXTRACT_PROMPT = '你是一个信息提取助手。阅读下面的对话，把【值得长期记住】的信息抽成一行 JSON。\n'
        + '只输出 JSON，不要解释、不要代码围栏、不要寒暄。\n'
        + '格式：{"facts":{},"events":[],"entities":[],"current_emotion":{"emotion":"neutral","intensity":5},"followups":[],"topics":[],"forget":{},"resolved_followups":[]}\n'
        + '规则：\n'
        + '- facts：**只写用户本人**的信息（name / age / occupation / city / birthday / phone 等，key 用英文小写），没有就 {}\n'
        + '  别人的年龄、生日、职业、喜好、住哪儿一律不要写进 facts，也不要把人名当 key——那些属于 entities\n'
        + '  岁数优先靠 birthday 推算：birthday 写成 YYYY-MM-DD（不知道年份就写 MM-DD，如 05-01）；只有实在拿不到生日才写 age=纯数字\n'
        + '- events：只记用户身上**真实发生过、正在发生或明确计划**的事，一条一件事 [{"title":"简短标题","description":"细节","event_date":"YYYY-MM-DD 或空","emotion":"joy|sadness|anxiety|excited|grateful|anger|fear|neutral","importance":1到10,"entities":[{"name":"涉及的人"}],"category":"work|life|study|health|other|family"}]。\n'
        + '  importance 必须按下面这把尺子打分，**不许一律给 4-5**：\n'
        + '    10＝人生转折：结婚、离婚、亲人去世、重病确诊、移居\n'
        + '    8-9＝重大变化：换工作、被裁、分手或确定关系、住院手术、买房搬家\n'
        + '    6-7＝明显影响近期生活或情绪：面试、考试、和家人/伴侣大吵、出差、拿到机会、宠物走失\n'
        + '    4-5＝有具体安排的日常事：约了饭、去医院复查、周末出行、被安排连续加班、要交的材料\n'
        + '    2-3＝随口提到的日常：熬夜、吃了什么、看了什么、天气、通勤\n'
        + '    1＝顺口一句、玩笑、寒暄、附和\n'
        + '- 只有 importance>=3 才写进 events；1-2 的（"好累啊""随便吧""哈哈哈"这类）不要写，交给 current_emotion/topics\n'
        + '- 同一件事只记一条：同一天同一件事换个说法又说一遍，**不要新增**；要补充细节时，title 沿用与上次完全相同的措辞（系统会按标题合并进同一条）\n'
        + '- **别人的生日/纪念日本身不是事件**：那只是那个人的生日字段。只有用户**为对方做了什么**（送礼、一起庆祝、办婚礼）才写成事件\n'
        + '- entities：[{"name":"人名或称呼","relation":"与用户的关系","traits":["短标签"],"birthday":"YYYY-MM-DD 或 MM-DD 或空","age":数字或0}]。'
        + '**职业、喜好、性格、近况、外貌写进 traits**（每条不超过 8 个字）；'
        + '**年龄和生日不要写进 traits**：知道生日就填 birthday（只知月日就写 "11-02"），知道几岁就填 age，都不知道则 age:0、birthday:""\n'
        + '- current_emotion：用户此刻情绪 {"emotion":"","intensity":1到10}\n'
        + '- followups：[{"description":"之后应主动关心/追问的事","due_date":"YYYY-MM-DD 或空","entities":[{"name":"这件事关于谁"}]}]。entities 是**可选**的：只有话题确实指向某个具体的人（妈妈/王总/小雅…）时才填；说的是用户自己的事（我想去逛街、我想换工作）或没有具体对象时，给空数组 []，不要拿"我"或"用户"去凑\n'
        + '  不要给"别人的生日/节日"凭空造任务；只有用户明确说"提醒我"、"我要准备"才记。纯属一句"她今天生日"不要变成待办\n'
        + '- topics：1-2 个归类词（工作/家庭/情绪/健康/兴趣/学习/情感）\n'
        + '- resolved_followups：待追问 id 数组，表示"这条这轮已经问过了、以后不用再问"。判断标准：看【助手刚回复的】里有没有问到某条待追问的内容——问到了就填它的 id，不管用户答得怎么样（答了、没答、答"还没弄"都算，因为已经问过，不该再问第二次）；用户自己主动说某事已经完成/取消/不用管了，也填对应 id。助手没问到的、或者只是又提了一嘴但没真正问，不要填。没有就给 []\n'
        + '- forget：用户明确要求删除某些记忆时填 {"facts":[],"events":[],"followups":[]}，否则 {}\n'
        + '当前日期：';

    /* ---------- 运行时状态 ---------- */
    let cloud = null;
    let session = null;
    let modelId = null;
    let modelList = [];
    let chars = {};
    let charId = 'warm_friend';
    let history = [];          // [{role, content, at}]
    let busy = false;

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, html) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined) n.innerHTML = html;
        return n;
    };

    function toast(msg, isErr) {
        const t = $('toast');
        t.textContent = msg;
        t.className = 'toast show' + (isErr ? ' err' : '');
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
    }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function nowHM() {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function todayISO() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function localHM(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts).slice(11, 16);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /* 数据库时间戳是 UTC，直接截前 10 位会跨时区错日；统一转成本地日期再分组 */
    function localDay(ts) {
        if (!ts) return todayISO();
        const d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts).slice(0, 10);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /* ============================================================
       年龄：一律按生日算，不把「N岁」写死
       ============================================================ */
    const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

    /* 生日写法归一：'2004-11-02' / '11-02' / '11月2日' 都收，返回 'YYYY-MM-DD' 或 'MM-DD' 或 '' */
    function normBirthday(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/(\d{1,2})[-/.月](\d{1,2})/);
        if (m) {
            const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10);
            if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return ('0' + mm).slice(-2) + '-' + ('0' + dd).slice(-2);
        }
        return '';
    }

    /* 有完整生日 → 按今天推算岁数；只有 MM-DD → 算不出来 */
    function ageFromBirthday(bd, now) {
        const s = String(bd || '');
        if (s.length !== 10) return null;
        const n = now || new Date();
        const y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(5, 7), 10), d = parseInt(s.slice(8, 10), 10);
        if (!y || !m || !d) return null;
        let age = n.getFullYear() - y;
        const passed = (n.getMonth() + 1 > m) || (n.getMonth() + 1 === m && n.getDate() >= d);
        if (!passed) age -= 1;
        return age >= 0 && age < 130 ? age : null;
    }

    /* 只知道「几岁」时，用记录那天当基准往前推：过了一年就多算一岁，不会永远卡在 24 */
    function ageFromSnapshot(ageSeen, seenOn, now) {
        const a = parseInt(ageSeen, 10);
        if (!a) return null;
        const n = now || new Date();
        const seen = seenOn ? new Date(String(seenOn).slice(0, 10) + 'T00:00:00') : null;
        if (!seen || isNaN(seen.getTime())) return a;
        const years = n.getFullYear() - seen.getFullYear()
            - ((n.getMonth() < seen.getMonth() || (n.getMonth() === seen.getMonth() && n.getDate() < seen.getDate())) ? 1 : 0);
        return a + Math.max(0, years);
    }

    /* 人物 / 用户的当前岁数：优先生日，其次「N岁 + 记录日期」快照 */
    function currentAge(e) {
        if (!e) return null;
        const fromBd = ageFromBirthday(e.birthday);
        if (fromBd !== null) return fromBd;
        return ageFromSnapshot(e.age_seen, e.age_seen_on);
    }

    /* 个人信息里的年龄：有 birthday 就按生日算，只有 age 就按那条记录的时间往后顺推 */
    function profileAgeInfo(rows) {
        const map = {};
        (rows || []).forEach(p => { map[p.field_key] = p; });
        const bd = map.birthday ? normBirthday(map.birthday.field_value) : '';
        if (bd && bd.length === 10) {
            const a = ageFromBirthday(bd);
            if (a !== null) return { value: a + '岁', note: '按生日 ' + birthdayLabel(bd) + ' 推算' };
        }
        const ageRow = map.age;
        if (ageRow) {
            const a = ageFromSnapshot(String(ageRow.field_value).match(/\d+/), ageRow.updated_at);
            if (a !== null) return { value: a + '岁', note: '按 ' + localDay(ageRow.updated_at) + ' 的记录顺推' };
        }
        return null;
    }

    /* 只有 MM-DD 又有岁数时，把年份补出来（今年生日过了就是 今年-岁，没过就是 今年-岁-1） */
    function fillBirthdayYear(bd, age) {
        const s = String(bd || '');
        const a = parseInt(age, 10);
        if (s.length !== 5 || !a) return s;
        const now = new Date();
        const mm = parseInt(s.slice(0, 2), 10), dd = parseInt(s.slice(3, 5), 10);
        const passed = (now.getMonth() + 1 > mm) || (now.getMonth() + 1 === mm && now.getDate() >= dd);
        return (now.getFullYear() - a - (passed ? 0 : 1)) + '-' + s;
    }

    function birthdayLabel(bd) {
        const s = String(bd || '');
        return s.length >= 5 ? s.slice(5) : s;
    }

    /* ============================================================
       主题
       ============================================================ */
    function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        $('theme-toggle').textContent = t === 'dark' ? '☀️' : '🌙';
        try { localStorage.setItem('xb-theme', t); } catch (e) { /* ignore */ }
    }

    /* ============================================================
       数据层
       ============================================================ */
    async function unwrap(promise) {
        const res = await promise;
        if (res && res.error) throw res.error;
        return res ? res.data : null;
    }

    const db = () => cloud.database;

    async function listProfile() {
        return (await unwrap(db().from('xb_profile').select('field_key,field_value,updated_at').order('updated_at', { ascending: false }))) || [];
    }
    async function listEvents(limit) {
        return (await unwrap(db().from('xb_events').select('*').order('created_at', { ascending: false }).limit(limit || 20))) || [];
    }
    async function listEntities() {
        return (await unwrap(db().from('xb_entities').select('*').order('last_mentioned', { ascending: false }))) || [];
    }
    async function listEmotions(limit) {
        return (await unwrap(db().from('xb_emotions').select('*').order('created_at', { ascending: false }).limit(limit || 20))) || [];
    }
    /* sessionId 传了值就只取这段对话的待追问；不传则取全部（仪表盘/关系图用） */
    async function listFollowups(limit, sessionId) {
        let q = db().from('xb_followups').select('*').eq('status', 'pending');
        if (sessionId !== undefined && sessionId !== null) q = q.eq('session_id', sessionId);
        return (await unwrap(q.order('created_at', { ascending: false }).limit(limit || 20))) || [];
    }
    async function listTopics() {
        return (await unwrap(db().from('xb_topics').select('*').order('frequency', { ascending: false }).limit(20))) || [];
    }
    /* 按 id 倒序取最近 N 条再翻正：id 是插入顺序，比 created_at 更可靠
       （created_at 默认值是 now()＝事务开始时间，并发写入时会取到比前一句更早的时刻） */
    async function listMessages(limit) {
        const rows = (await unwrap(db().from('xb_messages').select('id,role,content,created_at').order('id', { ascending: false }).limit(limit || 40))) || [];
        return rows.reverse();
    }

    async function setProfile(key, value, sensitive) {
        await unwrap(db().from('xb_profile').upsert(
            { field_key: key, field_value: String(value), is_sensitive: !!sensitive, updated_at: new Date().toISOString() },
            { onConflict: 'owner_id,field_key' }
        ));
    }
    async function delProfile(key) {
        await unwrap(db().from('xb_profile').delete().eq('field_key', key).select());
    }

    /* ---------- 事件：判断两句话是不是「同一件事」 ---------- */
    /* 去标点、数字统一成 0（"凌晨三点" 和 "凌晨3点" 要算一件），再比字符重合度 */
    function evKey(t) {
        return String(t || '').toLowerCase()
            .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 65248))
            .replace(/[0-9]+/g, '0')
            .replace(/[^\u4e00-\u9fa5a-z]/g, '');
    }
    function evSim(a, b) {
        const A = evKey(a), B = evKey(b);
        if (!A || !B) return 0;
        if (A === B) return 1;
        const sa = new Set(A), sb = new Set(B);
        let inter = 0;
        sa.forEach(ch => { if (sb.has(ch)) inter++; });
        return inter / (sa.size + sb.size - inter);
    }
    /* 同一天 + （一方是另一方的子串，或字符重合度 >=0.55）视为同一件事
       —— "熬夜刷手机到凌晨三点" ≈ "熬夜到凌晨3点"，"换工作去上海" ≈ "换工作" */
    function sameThing(a, b) {
        const da = a && a.event_date ? String(a.event_date).slice(0, 10) : '';
        const db2 = b && b.event_date ? String(b.event_date).slice(0, 10) : '';
        if (da && db2 && da !== db2) return false;
        const ka = evKey(a && a.title), kb = evKey(b && b.title);
        if (!ka || !kb) return false;
        const short = ka.length <= kb.length ? ka : kb;
        const long = ka.length <= kb.length ? kb : ka;
        if (short.length >= 3 && long.indexOf(short) >= 0) return true;
        return evSim(a && a.title, b && b.title) >= 0.55;
    }

    async function upsertEvent(e) {
        const title = String(e.title || '').trim();
        if (!title) return;
        const importance = Math.max(1, Math.min(10, parseInt(e.importance, 10) || 5));
        const ents = Array.isArray(e.entities) ? e.entities.map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x && x.name) : [];
        const old = (await unwrap(db().from('xb_events').select('id,title,description,importance,entities,event_date').eq('title', title).limit(1))) || [];
        // 标题不完全一样也认：模型同一件事换个说法又记一条，是最容易攒出重复的地方
        let prev = old[0] || null;
        if (!prev) {
            let recent = [];
            try {
                recent = (await unwrap(db().from('xb_events')
                    .select('id,title,description,importance,entities,event_date')
                    .order('created_at', { ascending: false }).limit(80))) || [];
            } catch (err) { recent = []; }
            prev = recent.find(r => sameThing(r, { title: title, event_date: e.event_date })) || null;
        }
        if (prev) {
            const mergedEnts = (prev.entities || []).concat(ents).reduce((acc, cur) => {
                if (cur && cur.name && !acc.some(x => x.name === cur.name)) acc.push({ name: cur.name });
                return acc;
            }, []);
            await unwrap(db().from('xb_events').update({
                description: (String(prev.description || '').length > String(e.description || '').length) ? prev.description : (e.description || ''),
                importance: Math.max(prev.importance || 0, importance),
                entities: mergedEnts,
                emotion: e.emotion || 'neutral',
                event_date: e.event_date || prev.event_date || null,
                category: e.category || 'other'
            }).eq('id', prev.id).select());
            return;
        }
        await unwrap(db().from('xb_events').insert({
            title: title,
            description: e.description || '',
            event_date: e.event_date || null,
            emotion: e.emotion || 'neutral',
            importance: importance,
            entities: ents,
            category: e.category || 'other'
        }).select());
    }

    async function upsertEntity(ent) {
        const name = String(ent.name || '').trim();
        if (!name) return;
        // 「22岁」「生日11-02」不进 traits：年龄是可推算字段，写死在标签里就永远不变
        const traits = (Array.isArray(ent.traits) ? ent.traits : [])
            .map(v => String(v || '').trim())
            .filter(v => v && !/^\d{1,3}\s*岁$/.test(v) && !/^(生日|出生)/.test(v));
        const age = parseInt(ent.age, 10) || 0;
        let bd = normBirthday(ent.birthday);
        if (bd && bd.length === 5 && age) bd = fillBirthdayYear(bd, age);

        const old = (await unwrap(db().from('xb_entities')
            .select('id,traits,relation,birthday,age_seen').eq('name', name).limit(1))) || [];
        if (old.length) {
            const prev = old[0];
            const merged = (prev.traits || []).concat(traits).filter((v, i, a) => v && a.indexOf(v) === i);
            const patch = {
                relation: ent.relation || prev.relation || '',
                traits: merged,
                last_mentioned: new Date().toISOString()
            };
            if (bd) patch.birthday = bd;
            if (age) { patch.age_seen = age; patch.age_seen_on = todayISO(); }
            await unwrap(db().from('xb_entities').update(patch).eq('id', prev.id).select());
            return;
        }
        await unwrap(db().from('xb_entities').insert({
            name: name,
            relation: ent.relation || '',
            traits: traits,
            birthday: bd || null,
            age_seen: age || null,
            age_seen_on: age ? todayISO() : null
        }).select());
    }

    async function upsertEmotion(emotion, intensity) {
        if (!emotion) return;
        await unwrap(db().from('xb_emotions').upsert(
            { emotion: emotion, intensity: Math.max(1, Math.min(10, parseInt(intensity, 10) || 5)), day: todayISO() },
            { onConflict: 'owner_id,day,emotion' }
        ));
    }

    async function addFollowup(desc, dueDate, entities) {
        const d = String(desc || '').trim();
        if (!d) return;
        const ents = (Array.isArray(entities) ? entities : [])
            .map(x => (typeof x === 'string' ? { name: x } : x))
            .filter(x => x && x.name)
            .map(x => ({ name: String(x.name) }));
        const old = (await unwrap(db().from('xb_followups').select('id,entities').eq('status', 'pending').eq('description', d).limit(1))) || [];
        if (old.length) {
            // 同一句待办重复出现时，把新识别到的关联人补上
            const prev = Array.isArray(old[0].entities) ? old[0].entities : [];
            const merged = prev.concat(ents).reduce((acc, cur) => {
                const n = (cur && cur.name) ? cur.name : String(cur);
                if (n && !acc.some(x => x.name === n)) acc.push({ name: n });
                return acc;
            }, []);
            if (merged.length !== prev.length) {
                await unwrap(db().from('xb_followups').update({ entities: merged }).eq('id', old[0].id).select());
            }
            return;
        }
        const row = { description: d, due_date: dueDate || null, entities: ents };
        if (conv && conv.id) row.session_id = conv.id;
        await unwrap(db().from('xb_followups').insert(row).select());
    }

    async function touchTopic(topic) {
        const t = String(topic || '').trim();
        if (!t) return;
        const old = (await unwrap(db().from('xb_topics').select('id,frequency').eq('topic', t).limit(1))) || [];
        if (old.length) {
            await unwrap(db().from('xb_topics').update({ frequency: (old[0].frequency || 1) + 1, last_discussed: new Date().toISOString() }).eq('id', old[0].id).select());
            return;
        }
        await unwrap(db().from('xb_topics').insert({ topic: t }).select());
    }

    /* ---------- 会话：一段对话 = 一个角色 + 一串消息 ---------- */
    let conv = null;   // { id, character_id, title, started_at, last_at }

    async function listSessions(limit) {
        return (await unwrap(db().from('xb_sessions').select('*')
            .order('last_at', { ascending: false }).limit(limit || 100))) || [];
    }

    async function createConv(wantedId, withGreeting) {
        const id = wantedId || charId;
        const c = chars[id] || currentCharacter();
        const cid = c ? c.id : '';
        const rows = await unwrap(db().from('xb_sessions').insert({
            character_id: cid,
            title: (c ? c.name : '新对话')
        }).select());
        conv = (rows && rows[0]) ? rows[0] : {
            id: null, character_id: cid, started_at: new Date().toISOString()
        };
        charId = cid;
        setCharUI(cid);
        history = [];
        if (withGreeting !== false && c && c.greeting) {
            history.push({ role: 'assistant', content: c.greeting, at: nowHM() });
            try { await addMessage('assistant', c.greeting); } catch (e) { /* 落库失败不影响聊天 */ }
        }
        renderChat();
        renderChatMeta();
        renderHero();
        renderStatus();
        renderHistoryList().catch(() => {});
        return conv;
    }

    /* 这段对话还没开始聊：直接换角色，不新增会话 */
    async function retargetConv(c, keepGreeting) {
        if (!c) return;
        charId = c.id;
        setCharUI(c.id);
        if (conv && conv.id) {
            try {
                await unwrap(db().from('xb_sessions')
                    .update({ character_id: c.id, title: c.name }).eq('id', conv.id).select());
                conv.character_id = c.id;
            } catch (e) { /* 忽略，界面照常 */ }
            try {
                await unwrap(db().from('xb_messages').delete().eq('session_id', conv.id).select());
            } catch (e) { /* 忽略 */ }
        }
        history = [];
        if (c.greeting) {
            history.push({ role: 'assistant', content: c.greeting, at: nowHM() });
            addMessage('assistant', c.greeting).catch(() => {});
        }        renderChat();
        renderChatMeta();
        renderHero();
        renderStatus();
        renderHistoryList().catch(() => {});
    }

    function setCharUI(id) {
        const c = chars[id];
        if (!c) return;
        const g = c.gender || 'male';
        $('gender-select').value = g;
        fillCharOptions(g);
        $('char-select').value = id;
    }

    /* 切到某一段历史对话，接着聊 */
    async function jumpToConv(id) {
        let list = [];
        try { list = await listSessions(100); } catch (e) { list = []; }
        const target = list.find(x => String(x.id) === String(id));
        if (!target) { toast('这段对话已不存在', true); return false; }
        if (!chars[target.character_id]) {
            toast('这段对话的角色已不可用，只能查看不能继续', true);
            return false;
        }
        conv = target;
        charId = target.character_id;
        setCharUI(charId);
        await syncHistory();
        renderHero();
        renderStatus();
        await renderHistoryList();
        toast('已回到 ' + chars[charId].name + ' · ' + (localDay(target.started_at) + ' ' + localHM(target.started_at)).trim() + ' 那段对话');
        return true;
    }

    /* ---------- 左栏：历史对话列表（一段对话一行，点一下接着聊） ---------- */
    function histWhen(started, last) {
        const t = last || started;
        if (!t) return '';
        const day = localDay(t);
        const hm = localHM(t);
        if (day === todayISO()) return '今天 ' + hm;
        const y = new Date(Date.now() - 86400000);
        if (day === localDay(y.toISOString())) return '昨天 ' + hm;
        return day + ' ' + hm;
    }

    async function renderHistoryList() {
        const box = $('hist-list');
        if (!box) return;
        let list = [];
        try {
            list = await listSessions(60);
        } catch (e) {
            box.innerHTML = '<div class="empty" style="padding:16px 6px">读取失败，稍后刷新</div>';
            return;
        }
        if (!list.length) {
            box.innerHTML = '<div class="empty" style="padding:16px 6px">还没有对话<br>点上面「＋ 新对话」开始</div>';
            return;
        }
        box.innerHTML = list.map(s => {
            const c = chars[s.character_id];
            const name = c ? c.name : '（未知角色）';
            const emoji = c ? c.emoji : '❔';
            const cur = conv && String(conv.id) === String(s.id);
            const when = histWhen(s.started_at, s.last_at);
            return '<div class="hist-item' + (cur ? ' cur' : '') + '" data-conv="' + s.id + '">'
                + '<span class="hist-emoji">' + esc(emoji) + '</span>'
                + '<div class="hist-info">'
                + '<div class="hist-name">' + esc(name) + '</div>'
                + '<div class="hist-when">' + esc(when) + (cur ? ' · 当前' : '') + '</div>'
                + '</div>'
                + '<button class="del-btn hist-del" data-del-conv="' + s.id + '" title="删除这段对话">✕</button>'
                + '</div>';
        }).join('');
    }

    /* 左右两栏的显隐，记在本地，下次打开还是你上次的样子 */
    const colState = { history: true, side: true };
    function applyCols() {
        const wrap = $('chat-wrap');
        if (wrap) {
            wrap.classList.toggle('no-history', !colState.history);
            wrap.classList.toggle('no-side', !colState.side);
        }
        const th = $('toggle-history');
        if (th) {
            th.textContent = colState.history ? '◀ 历史对话' : '▶ 历史对话';
            th.classList.toggle('on', colState.history);
            th.classList.toggle('off', !colState.history);
        }
        const ts = $('toggle-side');
        if (ts) {
            ts.textContent = colState.side ? '角色面板 ▶' : '角色面板 ◀';
            ts.classList.toggle('on', colState.side);
            ts.classList.toggle('off', !colState.side);
        }
        try { localStorage.setItem('xb-cols', JSON.stringify(colState)); } catch (e) { /* 隐私模式忽略 */ }
    }
    function loadCols() {
        try {
            const raw = JSON.parse(localStorage.getItem('xb-cols') || '{}');
            if (typeof raw.history === 'boolean') colState.history = raw.history;
            if (typeof raw.side === 'boolean') colState.side = raw.side;
        } catch (e) { /* ignore */ }
        applyCols();
    }

    /* 打开应用时接着上一次对话；没有就新开一段 */
    async function resumeConv() {
        let rows = [];
        try { rows = await listSessions(1); } catch (e) { rows = []; }
        const last = rows[0];
        if (last && chars[last.character_id]) {
            conv = last;
            charId = last.character_id;
            setCharUI(charId);
            await syncHistory();
            await renderHistoryList();
        } else {
            // 没有会话，或最近这段是迁移出来的“历史对话”（没有角色）：开一段新的
            await createConv(charId, true);
        }
    }

    /* 消息落库串行队列：一句一句排队写入，id 递增 == 真实发言顺序。
       之前 addMessage('user') 和 addMessage('assistant') 是并发发出的两个请求，
       created_at 取的是 Postgres 事务开始时间 now()，谁的事务先开始谁的时间更早，
       于是「AI 的回答」会排到「用户的提问」前面。串行化后两件事同时解决：
       id 一定递增，created_at 也一定递增。 */
    let msgQueue = Promise.resolve();
    function addMessage(role, content) {
        const sid = (conv && conv.id) ? conv.id : null;
        const row = { role: role, content: content };
        if (sid) row.session_id = sid;
        const job = async () => {
            try {
                await unwrap(db().from('xb_messages').insert(row).select());
            } catch (e) {
                // 单条失败会让对话「少半句」，再试一次
                await unwrap(db().from('xb_messages').insert(row).select());
            }
            if (sid) {
                unwrap(db().from('xb_sessions').update({ last_at: new Date().toISOString() })
                    .eq('id', sid).select()).catch(() => {});
            }
        };
        const next = msgQueue.then(job, job);
        msgQueue = next.catch(() => {});
        return next;
    }

    /* 从「22岁，今天（2026-11-02）是她的生日」这种句子里拆出岁数 / 生日，剩下的当标签 */
    function parsePersonFacts(v) {
        const s = String(v || '');
        const out = { traits: [], birthday: '', age: 0 };
        const age = s.match(/(\d{1,3})\s*岁/);
        if (age) out.age = parseInt(age[1], 10) || 0;
        if (/生日|出生/.test(s)) {
            const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
            const md = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
            if (iso) out.birthday = iso[1] + '-' + ('0' + iso[2]).slice(-2) + '-' + ('0' + iso[3]).slice(-2);
            else if (md) out.birthday = ('0' + md[1]).slice(-2) + '-' + ('0' + md[2]).slice(-2);
        }
        if (!out.age && !out.birthday) out.traits.push(s.length > 12 ? s.slice(0, 12) : s);
        return out;
    }

    /* ---------- 把一次调用拿到的结构化记忆落库 ---------- */
    async function applyMeta(meta) {
        if (!meta || typeof meta !== 'object') return;
        const jobs = [];

        // 兜底：模型偶尔把「阿美：22岁，今天生日」当用户信息写进 facts（key 就是人名）。
        // 个人信息只留用户自己的，这类改挂到那个人的人物标签上。
        let entNames = [];
        try { entNames = (await listEntities()).map(e => String(e.name || '')); } catch (e) { entNames = []; }

        if (meta.facts && typeof meta.facts === 'object') {
            Object.keys(meta.facts).forEach(k => {
                const v = meta.facts[k];
                if (!k || v === null || v === undefined || String(v).trim() === '') return;
                const who = entNames.find(n => n.length >= 2 && k.indexOf(n) >= 0);
                if (who) {
                    const pf = parsePersonFacts(v);
                    jobs.push(upsertEntity({ name: who, traits: pf.traits, birthday: pf.birthday, age: pf.age }));
                    return;
                }
                jobs.push(setProfile(k, String(v).trim(), k === 'phone' || k === 'address'));
            });
        }

        const forget = meta.forget;
        if (forget && typeof forget === 'object') {
            (forget.facts || []).forEach(k => { if (k) jobs.push(delProfile(String(k))); });
            (forget.events || []).forEach(t => { if (t) jobs.push(unwrap(db().from('xb_events').delete().eq('title', String(t)).select())); });
            (forget.followups || []).forEach(t => { if (t) jobs.push(unwrap(db().from('xb_followups').delete().ilike('description', '%' + t + '%').select())); });
        }

        (Array.isArray(meta.events) ? meta.events : []).forEach(e => { if (e && e.title) jobs.push(upsertEvent(e)); });
        (Array.isArray(meta.entities) ? meta.entities : []).forEach(e => {
            // 模型有时给 ["妈妈"] 而不是 [{"name":"妈妈"}]，两种都要接住
            const item = (typeof e === 'string') ? { name: e } : e;
            if (item && item.name) jobs.push(upsertEntity(item));
        });
        (Array.isArray(meta.followups) ? meta.followups : []).forEach(f => {
            const desc = (typeof f === 'string') ? f : (f && f.description);
            if (desc) jobs.push(addFollowup(desc, f && f.due_date, f && f.entities));
        });

        (Array.isArray(meta.resolved_followups) ? meta.resolved_followups : []).forEach(id => {
            const n = parseInt(id, 10);
            if (n) jobs.push(unwrap(db().from('xb_followups').update({ status: 'asked' }).eq('id', n).select()));
        });

        const em = meta.current_emotion;
        if (em && em.emotion) jobs.push(upsertEmotion(em.emotion, em.intensity));

        (Array.isArray(meta.topics) ? meta.topics : []).forEach(t => {
            const name = (typeof t === 'string') ? t : (t && t.topic);
            if (name) jobs.push(touchTopic(name));
        });

        const results = await Promise.allSettled(jobs);
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length) console.warn('[小伴] 记忆写入部分失败', failed.map(f => String(f.reason && f.reason.message || f.reason)));
    }

    /* 记忆提取：与对话完全解耦，每轮都用固定模型单独抽一次。
       不再要求对话模型输出任何特殊格式，所以换任何模型都不会丢记忆。 */
    /* 待追问按「到期优先」排序，没日期的排后面 */
    function sortFollowups(list) {
        return (list || []).slice().sort((a, b) => {
            const da = a.due_date ? String(a.due_date).slice(0, 10) : '9999-99-99';
            const db_ = b.due_date ? String(b.due_date).slice(0, 10) : '9999-99-99';
            if (da !== db_) return da < db_ ? -1 : 1;
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
    }

    async function extractMemory(userText, recent, replyText) {
        const pick = modelList.some(m => (m.id || m.name) === EXTRACT_MODEL) ? EXTRACT_MODEL : modelId;
        if (!pick) return {};
        const ctxLines = (recent || []).slice(-6)
            .map(m => (m.role === 'user' ? '用户' : '助手') + '：' + m.content)
            .join('\n');

        // 现有待追问：让模型能判断哪条这轮被处理掉了
        let fuLines = '';
        try {
            const pend = sortFollowups(await listFollowups(20, conv && conv.id ? conv.id : -1));
            fuLines = pend.map(f => '- id=' + f.id + ' ' + f.description +
                (f.due_date ? '（到期 ' + String(f.due_date).slice(0, 10) + '）' : '（无期限）')).join('\n');
        } catch (e) { fuLines = ''; }

        const payload = EXTRACT_PROMPT + todayISO() + '\n\n'
            + (ctxLines ? '【最近对话】\n' + ctxLines + '\n\n' : '')
            + (fuLines ? '【现有待追问】\n' + fuLines + '\n\n' : '')
            + '【本轮用户说的】\n' + userText
            + (replyText ? '\n\n【助手刚回复的】\n' + replyText : '');
        try {
            let text = '';
            const stream = cloud.llm.chat.completions.create({
                model: pick,
                messages: [
                    { role: 'system', content: '你是一个严谨的信息提取助手，只输出 JSON，不要寒暄。' },
                    { role: 'user', content: payload }
                ],
                stream: true,
                temperature: 0.1,
                max_tokens: 700
            });
            for await (const ch of stream) {
                const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                if (d && d.content) text += d.content;
            }
            const s = text.indexOf('{'), e = text.lastIndexOf('}');
            if (s < 0 || e <= s) return {};
            return JSON.parse(text.slice(s, e + 1));
        } catch (e) {
            console.warn('[小伴] 兜底提取失败', e);
            return {};
        }
    }

    /* ============================================================
       角色
       ============================================================ */
    function currentCharacter() {
        return chars[charId] || Object.values(chars)[0] || null;
    }

    function fillCharOptions(gender) {
        const sel = $('char-select');
        sel.innerHTML = '';
        Object.keys(chars).forEach(id => {
            const c = chars[id];
            if (gender && c.gender !== gender) return;
            const o = document.createElement('option');
            o.value = id;
            o.textContent = c.emoji + ' ' + c.name;
            sel.appendChild(o);
        });
        const n = sel.options.length;
        $('char-count').textContent = '共 ' + n + ' 位角色' + (gender ? '（' + (gender === 'male' ? '男性' : gender === 'female' ? '女性' : '中性') + '）' : '');
    }

    /* ============================================================
       渲染
       ============================================================ */
    function renderHero() {
        const c = currentCharacter();
        if (!c) return;
        $('hero-orb').textContent = c.emoji;
        $('hero-orb').style.setProperty('--char-color', c.color || '#f59e0b');
        $('hero-title').textContent = '小伴 · ' + c.name;
        $('hero-sub').textContent = c.description || '你的陪伴伙伴';

        const turns = history.filter(m => m.role === 'user').length;
        $('hero-badges').innerHTML =
            '<span class="badge">🧠 ' + esc(modelId || '云端模型') + '</span>' +
            '<span class="badge violet">💬 ' + turns + ' 轮</span>' +
            '<span class="badge cyan">🗂 ' + history.length + ' 条对话</span>';
    }

    function renderStatus() {
        const c = currentCharacter();
        if (!c) return;
        $('status-box').innerHTML =
            '<div class="row"><span class="k">角色：</span>' + esc(c.emoji + ' ' + c.name) + '</div>' +
            '<div class="row"><span class="k">模型：</span>' + esc(modelId || '加载中…') + '</div>' +
            '<div class="row"><span class="k">对话：</span>' + history.filter(m => m.role === 'user').length + ' 轮</div>' +
            '<div class="row"><span class="k">登录：</span>' + esc((session && session.user && (session.user.email || session.user.name)) || '已登录') + '</div>';
    }

    function renderChat() {
        const box = $('chat');
        box.innerHTML = '';
        if (!history.length) {
            const empty = el('div', 'chat-empty');
            empty.innerHTML = '在右侧选一位角色，然后说点什么…<br><span style="font-size:12px">说的每句话都会变成 TA 的记忆</span>';
            box.appendChild(empty);
            return;
        }
        history.forEach(m => appendBubble(m.role, m.content, m.at, false));
        box.scrollTop = box.scrollHeight;
    }

    function appendBubble(role, content, at, scroll) {
        const box = $('chat');
        const wrap = el('div', 'msg ' + (role === 'user' ? 'user' : 'bot'));
        const bubble = el('div', 'bubble');
        if (at) bubble.innerHTML = '<span class="time">' + esc(at) + '</span>' + esc(content);
        else bubble.textContent = content;
        wrap.appendChild(bubble);
        box.appendChild(wrap);
        if (scroll !== false) box.scrollTop = box.scrollHeight;
        return bubble;
    }

    function appendTyping() {
        const box = $('chat');
        const wrap = el('div', 'msg bot');
        wrap.id = 'typing-row';
        wrap.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
        box.appendChild(wrap);
        box.scrollTop = box.scrollHeight;
        return wrap;
    }

    function removeTyping() {
        const t = $('typing-row');
        if (t) t.remove();
    }

    function bar(pct) {
        return '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>';
    }

    /* ============================================================
       仪表盘：所有卡片都支持编辑 / 删除
       ============================================================ */
    let dashEdit = null;
    let dashData = { events: [], entities: [] };
    const CORE_IMP = 6;        // 重要度达到这个分数才算「核心事件」，其余进「日常记录」
    let dailyOpen = false;     // 「日常记录」默认收起

    function evNames(ev) {
        return (ev.entities || []).map(x => (x && x.name) ? x.name : String(x)).filter(Boolean);
    }

    /* 改人名时把事件里的关联人名一起换掉，否则事件会变成孤儿 */
    async function renameInEvents(oldName, newName) {
        if (oldName === newName) return 0;
        const evs = await listEvents(500);
        const hit = evs.filter(ev => evNames(ev).indexOf(oldName) >= 0);
        for (const ev of hit) {
            const ents = evNames(ev).map(n => ({ name: n === oldName ? newName : n }));
            await unwrap(db().from('xb_events').update({ entities: ents }).eq('id', ev.id).select());
        }
        return hit.length;
    }

    /* 删除人物 = 删除人物 + 时间线上所有关联事件（用户要求两者联动） */
    async function deletePersonCascade(name, entId) {
        let evs = [], fus = [];
        try { evs = await listEvents(500); } catch (err) { evs = []; }
        try { fus = await listFollowups(200); } catch (err) { fus = []; }
        const hit = evs.filter(ev => evNames(ev).indexOf(name) >= 0);
        const shared = hit.filter(ev => evNames(ev).length > 1);
        const hitFu = fus.filter(f => evNames(f).indexOf(name) >= 0);
        let msg = '删除人物「' + name + '」？';
        if (hit.length) {
            msg += '\n\n时间线上和 TA 关联的 ' + hit.length + ' 条事件会一起删掉';
            if (shared.length) msg += '（其中 ' + shared.length + ' 条还关联了别人）';
            msg += '。';
        }
        if (hitFu.length) msg += '\n还有 ' + hitFu.length + ' 条待追问是关于 TA 的，也会一起删掉。';
        msg += '\n\n不可恢复。';
        if (!confirm(msg)) return false;
        try {
            if (entId) await unwrap(db().from('xb_entities').delete().eq('id', entId).select());
            if (hit.length) await deleteByIds('xb_events', hit.map(e => e.id));
            if (hitFu.length) await deleteByIds('xb_followups', hitFu.map(f => f.id));
            toast('已删除「' + name + '」和 ' + hit.length + ' 条事件、' + hitFu.length + ' 条待追问');
            return true;
        } catch (err) {
            toast('删除失败：' + ((err && err.message) || err), true);
            return false;
        }
    }

    function dashEventForm(e) {
        const emoOpts = ['joy', 'sadness', 'anxiety', 'excited', 'grateful', 'anger', 'fear', 'neutral']
            .map(k => '<option value="' + k + '"' + (e && e.emotion === k ? ' selected' : '') + '>' + EMO_LABEL[k] + '</option>').join('');
        return '<div class="gform">'
            + '<label>事件标题</label>'
            + '<input id="de-title" value="' + esc(e ? e.title : '') + '">'
            + '<div class="gform-row">'
            + '<div><label>日期</label><input id="de-date" type="date" value="' + esc(e && e.event_date ? String(e.event_date).slice(0, 10) : '') + '"></div>'
            + '<div><label>重要度 1-10</label><input id="de-imp" type="number" min="1" max="10" value="' + (e ? (parseInt(e.importance, 10) || 5) : 5) + '"></div>'
            + '</div>'
            + '<label>情绪</label><select id="de-emo">' + emoOpts + '</select>'
            + '<label>细节</label><textarea id="de-desc">' + esc(e ? (e.description || '') : '') + '</textarea>'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-save-event="' + (e ? e.id : '') + '">💾 保存</button>'
            + '<button class="btn ghost tiny" data-dash-cancel="1">取消</button>'
            + '</div></div>';
    }

    /* 个人信息：直接在卡片里增删改，独立的「编辑记忆」表单已经并进来了 */
    function dashProfileForm(p) {
        return '<div class="gform gform-prof">'
            + '<div class="gform-row">'
            + '<div><label>字段名</label><input id="dpf-key" value="' + esc(p ? p.field_key : '') + '" placeholder="如 city / birthday"></div>'
            + '<div><label>值</label><input id="dpf-val" value="' + esc(p ? p.field_value : '') + '" placeholder="留空＝删除这个字段"></div>'
            + '</div>'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-save-profile="' + esc(p ? p.field_key : '') + '">💾 保存</button>'
            + '<button class="btn ghost tiny" data-dash-cancel="1">取消</button>'
            + '</div></div>';
    }

    function dashEntityForm(e) {
        const cat = e ? (e.category || '') : '';
        const opts = ['<option value="">自动判断</option>'].concat(
            REL_KINDS.map(k => '<option value="' + k.id + '"' + (cat === k.id ? ' selected' : '') + '>' + k.label + '</option>'),
            ['<option value="other"' + (cat === 'other' ? ' selected' : '') + '>其他</option>']
        ).join('');
        return '<div class="gform">'
            + '<label>名字 / 称呼</label>'
            + '<input id="dp-name" value="' + esc(e ? e.name : '') + '">'
            + '<label>关系</label>'
            + '<input id="dp-relation" value="' + esc(e ? (e.relation || '') : '') + '">'
            + '<div class="gform-row">'
            + '<div><label>生日（YYYY-MM-DD 或 11-02）</label><input id="dp-birthday" value="' + esc(e ? (e.birthday || '') : '') + '" placeholder="2004-11-02"></div>'
            + '<div><label>岁数（不知生日才填）</label><input id="dp-age" type="number" min="0" max="120" value="' + esc(e && currentAge(e) !== null ? currentAge(e) : '') + '"></div>'
            + '</div>'
            + '<label>分类</label>'
            + '<select id="dp-category">' + opts + '</select>'
            + '<label>标签（顿号分隔，如 护士、爱熬夜）</label>'
            + '<input id="dp-traits" value="' + esc(e && e.traits ? e.traits.join('、') : '') + '">'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-save-entity="' + (e ? e.id : '') + '">💾 保存</button>'
            + '<button class="btn ghost tiny" data-dash-cancel="1">取消</button>'
            + '</div></div>';
    }

    /* 记忆写完后，如果用户正停在仪表盘，就顺手刷新一下 */
    function refreshAfterMemory() {
        const panel = $('panel-dash');
        if (panel && panel.classList.contains('active')) renderDashboard();
    }

    /* 从库里重新拉一遍对话，删掉某条消息后聊天区也能同步 */
    async function syncHistory() {
        try {
            if (conv && conv.id) {
                // 先取新的一段（id 倒序），再翻正成时间顺序：
                // 1) id 是插入顺序，不受 created_at 相同/倒挂影响；
                // 2) 只捞最近 300 条，长对话不会每次都全量搬。
                const rows = (await unwrap(db().from('xb_messages')
                    .select('id,role,content,created_at')
                    .eq('session_id', conv.id)
                    .order('id', { ascending: false })
                    .limit(300))) || [];
                rows.reverse();
                history = rows.map(m => ({ role: m.role, content: m.content, at: localHM(m.created_at) }));
            } else {
                history = [];
            }
        } catch (e) {
            console.warn('[小伴] 历史同步失败', e);
            history = [];
        }
        renderChat();
        renderChatMeta();
    }

    /* 聊天区顶部那条「当前对话是哪个角色」 */
    function renderChatMeta() {
        const box = $('chat-meta');
        if (!box) return;
        const c = chars[conv && conv.character_id] || currentCharacter();
        const turns = history.filter(m => m.role === 'user').length;
        const started = conv && conv.started_at ? localHM(conv.started_at) : '';
        const parts = [];
        if (c) parts.push('<b>' + esc(c.emoji + ' ' + c.name) + '</b>');
        if (started) parts.push('开始于 ' + esc(started));
        parts.push(turns + ' 轮对话');
        if (conv && conv.id) parts.push('<span class="conv-id">#' + conv.id + '</span>');
        box.innerHTML = parts.join('<i class="dot-sep">·</i>');
        // 这段已经聊过了，换角色就等于开新对话，按钮文案说清楚
        const btn = $('switch-char');
        if (btn) btn.textContent = turns ? '➕ 用该角色开启新对话' : '✅ 使用该角色';
    }

    function dashFollowupForm(f) {
        const who = evNames(f || {});
        return '<div class="gform">'
            + '<label>要追问的事</label>'
            + '<input id="df-desc" value="' + esc(f ? f.description : '') + '">'
            + '<div class="gform-row">'
            + '<div><label>日期</label><input id="df-date" type="date" value="' + esc(f && f.due_date ? String(f.due_date).slice(0, 10) : '') + '"></div>'
            + '<div><label>关于谁（可留空）</label><input id="df-who" value="' + esc(who.join('、')) + '" placeholder="可留空，如 妈妈"></div>'
            + '</div>'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-save-followup="' + (f ? f.id : '') + '">💾 保存</button>'
            + '<button class="btn ghost tiny" data-dash-cancel="1">取消</button>'
            + '</div></div>';
    }

    async function renderDashboard() {
        const body = $('dash-body');
        body.innerHTML = '<div class="empty">读取中…</div>';
        let profile = [], events = [], entities = [], followups = [], emotions = [], topics = [];
        try {
            [profile, events, entities, followups, emotions, topics] = await Promise.all([
                listProfile(), listEvents(200), listEntities(), listFollowups(10), listEmotions(10), listTopics()
            ]);
        } catch (e) {
            body.innerHTML = '<div class="empty">读取失败：' + esc(e.message || e) + '</div>';
            return;
        }
        dashData = { events: events, entities: entities };
        const hasAny = profile.length || events.length || entities.length || followups.length || emotions.length || topics.length;
        if (!hasAny) {
            body.innerHTML = '<div class="empty">还没有任何记忆数据。<br>去「💬 聊天」和角色聊几句，<b>个人信息 · 核心事件 · 人物关系 · 情绪</b> 会自动沉淀到这里。'
                + '<br><button class="btn primary small" data-add-profile="1" style="margin-top:14px">＋ 先手动填一条个人信息</button></div>';
            return;
        }

        const parts = [];

        const profEditing = dashEdit && dashEdit.type === 'profile';
        if (profile.length || profEditing) {
            parts.push('<div class="card"><h3 class="card-title c-amber">📋 个人信息'
                + '<span class="count-badge">' + profile.length + '</span>'
                + '<button class="btn ghost tiny card-action" data-add-profile="1">＋ 新增字段</button></h3>');
            // 新增表单放最上面，不用滚到底才能填
            if (profEditing && !dashEdit.key) parts.push('<div class="item">' + dashProfileForm(null) + '</div>');
            const profAge = profileAgeInfo(profile);
            const hasAgeField = profile.some(p => p.field_key === 'age');
            profile.forEach(p => {
                if (profEditing && dashEdit.key === p.field_key) {
                    parts.push('<div class="item">' + dashProfileForm(p) + '</div>');
                    return;
                }
                const derived = (p.field_key === 'age' && profAge) ? profAge : null;
                parts.push('<div class="row prof-row"><span class="k">' + esc(p.field_key) + '：</span>'
                    + '<span class="prof-val">' + esc(derived ? derived.value : p.field_value)
                    + (derived ? ' <i class="derived-note">（' + esc(derived.note) + '）</i>' : '') + '</span>'
                    + '<span class="item-tools">'
                    + '<button class="del-btn" data-edit-profile="' + esc(p.field_key) + '" title="编辑">✏️</button>'
                    + '<button class="del-btn" data-del-profile="' + esc(p.field_key) + '" title="删除这个字段">✕</button>'
                    + '</span></div>');
            });
            // 有生日但没单独写 age：补一行现算的岁数（只读，改生日即可）
            if (profAge && !hasAgeField) {
                parts.push('<div class="row prof-row"><span class="k">age：</span>'
                    + '<span class="prof-val">' + esc(profAge.value)
                    + ' <i class="derived-note">（' + esc(profAge.note) + '）</i></span></div>');
            }
            parts.push('<p class="hint">对话里说「我叫小飞」也会自动更新这里；年龄按生日实时算，只有生日不准时才需要改。</p>');
            parts.push('</div>');
        }

        if (events.length) {
            const sorted = events.slice().sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
            const impOf = (e) => parseInt(e.importance, 10) || 0;
            // 重要度 ≥6 才算「核心」；4-5 是有安排的日常；≤3 是随口一提
            const core = sorted.filter(e => impOf(e) >= CORE_IMP);
            const daily = sorted.filter(e => impOf(e) < CORE_IMP);

            const evHtml = (e, isDaily) => {
                if (dashEdit && dashEdit.type === 'event' && String(dashEdit.id) === String(e.id)) {
                    return '<div class="item">' + dashEventForm(e) + '</div>';
                }
                const imp = impOf(e);
                let h = '<div class="item">';
                h += '<div class="item-head"><span class="item-title">[' + esc(EMO_CN[e.emotion] || '?') + '] ' + esc(e.title) + '</span>';
                h += '<span class="meta">' + esc(e.event_date || '日期未记录') + '</span>';
                h += '<span class="item-tools">';
                if (isDaily) h += '<button class="del-btn" data-promote-event="' + e.id + '" title="标为核心事件">☆</button>';
                h += '<button class="del-btn" data-edit-event="' + e.id + '" title="编辑">✏️</button>'
                    + '<button class="del-btn" data-del-event="' + e.id + '" title="删除">✕</button></span></div>';
                if (e.description) h += '<p class="desc">' + esc(e.description) + '</p>';
                const rel = evNames(e);
                if (rel.length) h += '<p class="meta">涉及：' + esc(rel.join('、')) + '</p>';
                h += '<div>' + bar(imp * 10) + '<span class="meta">' + imp + '/10</span></div>';
                h += '</div>';
                return h;
            };

            parts.push('<div class="card"><h3 class="card-title c-violet">📅 核心事件 · 时间线'
                + '<span class="count-badge">' + core.length + '</span></h3>');
            if (core.length) {
                core.forEach(e => parts.push(evHtml(e, false)));
            } else {
                parts.push('<p class="hint">还没有够格进核心的事。'
                    + '重要度 ≥ ' + CORE_IMP + ' 才算核心——下面「日常记录」里点 ☆ 可以手动提上来。</p>');
            }
            parts.push('<p class="hint">按重要度筛选：' + CORE_IMP + ' 分以上进这里（人生转折 10 / 重大变化 8-9 / 影响近期 6-7）。</p></div>');

            if (daily.length) {
                parts.push('<div class="card"><h3 class="card-title c-cyan">🌿 日常记录'
                    + '<span class="count-badge">' + daily.length + '</span>'
                    + '<button class="btn ghost tiny card-action" data-toggle-daily="1">'
                    + (dailyOpen ? '收起' : '展开') + '</button></h3>');
                if (dailyOpen) {
                    daily.forEach(e => parts.push(evHtml(e, true)));
                    parts.push('<p class="hint">这些是 1-' + (CORE_IMP - 1) + ' 分的日常，留着当上下文，但不算核心事件。</p>');
                } else {
                    parts.push('<p class="hint">' + daily.length + ' 条日常小事（重要度 ≤ ' + (CORE_IMP - 1)
                        + '），默认收起来，点「展开」看。</p>');
                }
                parts.push('</div>');
            }
        }

        if (entities.length) {
            parts.push('<div class="card"><h3 class="card-title c-pink">👥 人物关系</h3>');
            entities.forEach(e => {
                if (dashEdit && dashEdit.type === 'entity' && String(dashEdit.id) === String(e.id)) {
                    parts.push('<div class="item">' + dashEntityForm(e) + '</div>');
                    return;
                }
                const linked = events.filter(ev => evNames(ev).indexOf(e.name) >= 0).length;
                const kind = kindOf(e);
                parts.push('<div class="item"><div class="item-head">'
                    + '<span class="item-title">' + esc(e.name) + '</span>'
                    + '<span class="meta">' + esc(e.relation || '关系未标注') + '</span>'
                    + '<span class="tag" style="color:' + kindById(kind).c2 + ';border-color:' + kindById(kind).c2 + '">'
                    + esc(KIND_SHORT[kind] || kind) + '</span>'
                    + '<span class="item-tools">'
                    + '<button class="del-btn" data-edit-entity="' + e.id + '" title="编辑">✏️</button>'
                    + '<button class="del-btn" data-del-entity="' + e.id + '" title="删除（连带删掉关联事件）">✕</button>'
                    + '</span></div>');
                // 岁数每次渲染时按生日现算，不存死值；只有「几岁」没有生日时按记录日期往后顺推
                const chips = [];
                const age = currentAge(e);
                if (age !== null && age !== undefined) {
                    const byBd = ageFromBirthday(e.birthday) !== null;
                    chips.push('<span class="chip age" title="' + (byBd ? '按生日 ' + esc(e.birthday) + ' 推算' : '按 ' + esc(e.age_seen_on || '') + ' 记录顺推') + '">'
                        + (byBd ? '' : '≈') + age + '岁</span>');
                }
                if (e.birthday) chips.push('<span class="chip">生日 ' + esc(birthdayLabel(e.birthday)) + '</span>');
                (e.traits || []).forEach(t => chips.push('<span class="chip">' + esc(t) + '</span>'));
                if (chips.length) parts.push('<div class="chips traits">' + chips.join('') + '</div>');
                parts.push('<p class="meta">' + (linked ? '关联 ' + linked + ' 条事件 · 删除人物会一并删除' : '还没有关联事件') + '</p>');
                parts.push('</div>');
            });
            parts.push('</div>');
        }

        if (followups.length) {
            parts.push('<div class="card"><h3 class="card-title c-red">⏰ 待追问</h3>');
            followups.forEach(f => {
                if (dashEdit && dashEdit.type === 'followup' && String(dashEdit.id) === String(f.id)) {
                    parts.push('<div class="item">' + dashFollowupForm(f) + '</div>');
                    return;
                }
                const who = evNames(f);
                parts.push('<div class="item"><div class="item-head">'
                    + '<span class="item-title">' + esc(f.description) + '</span>'
                    + (f.due_date ? '<span class="meta">' + esc(String(f.due_date).slice(0, 10)) + '</span>' : '')
                    + '<span class="item-tools">'
                    + '<button class="del-btn" data-edit-followup="' + f.id + '" title="编辑">✏️</button>'
                    + '<button class="del-btn" data-del-followup="' + f.id + '" title="删除">✕</button>'
                    + '</span></div>');
                if (who.length) {
                    parts.push('<p class="meta">关于：' + who.map(n =>
                        '<span class="gd-chip" data-goto-person="' + esc(n) + '">' + esc(n) + '</span>'
                    ).join(' ') + '</p>');
                }
                parts.push('<p class="meta">' + (f.session_id
                    ? '属于对话 #' + f.session_id + '，只在那段对话里会被带出'
                    : '未绑定对话（不会自动带出）') + '</p>');
                parts.push('</div>');
            });
            parts.push('</div>');
        }

        if (emotions.length) {
            parts.push('<div class="card"><h3 class="card-title c-green">📊 情绪记录</h3>');
            const map = {};
            emotions.forEach(e => { map[e.emotion] = (map[e.emotion] || 0) + 1; });
            const top = Object.keys(map).sort((a, b) => map[b] - map[a])[0];
            parts.push('<p class="row">最近 ' + emotions.length + ' 条记录，主要情绪：' + esc(EMO_LABEL[top] || top) + '</p>');
            emotions.slice(0, 8).forEach(e => {
                const it = parseInt(e.intensity, 10) || 5;
                parts.push('<div class="row row-tools">[' + esc(EMO_CN[e.emotion] || '?') + '] ' + esc(EMO_LABEL[e.emotion] || e.emotion) +
                    ' ' + bar(it * 10) + '<span class="meta">' + it + '/10 · ' + esc(e.day || '') + '</span>' +
                    '<button class="del-btn" data-del-emotion="' + e.id + '" title="删除这条记录">✕</button></div>');
            });
            parts.push('</div>');
        }

        if (topics.length) {
            parts.push('<div class="card"><h3 class="card-title c-cyan">🏷️ 话题偏好</h3><div class="chips">');
            topics.forEach(t => {
                parts.push('<span class="chip">' + esc(t.topic) + '<b>×' + t.frequency + '</b>' +
                    '<button class="del-btn" data-del-topic="' + t.id + '" title="删除这个话题">✕</button></span>');
            });
            parts.push('</div></div>');
        }

        body.innerHTML = parts.join('');
    }

    /* ============================================================
       模型调用（一次调用同时拿回复和记忆）
       ============================================================ */
    /* ============================================================
       关系图（中心=用户，外围=人物，连线标注关系）
       ============================================================ */
    /* ============================================================
       关系图（中心=用户，外围=人物，连线标注关系；节点与事件均可增删改）
       ============================================================ */
    const SVG_NS = 'http://www.w3.org/2000/svg';

    /* 分类顺序即匹配优先级；颜色成对（亮→暗）用于节点径向渐变，优先保证区分度 */
    const REL_KINDS = [
        { id: 'family', label: '家人', c1: '#fda4af', c2: '#e11d48', kw: /母|父|妈|爸|姐|妹|哥|弟|儿|女|妻|夫|爷|奶|姨|叔|姑|舅|兄|嫂|媳|婿|侄|甥|亲|家人|老公|老婆|婆婆|岳父|岳母|公公|爱人/ },
        { id: 'love', label: '恋爱情感', c1: '#d8b4fe', c2: '#9333ea', kw: /男友|女友|对象|恋人|暗恋|前任|相亲|喜欢的人|未婚|伴侣|暧昧|crush/i },
        { id: 'study', label: '学业', c1: '#fde047', c2: '#ca8a04', kw: /老师|教授|导师|同学|学长|学姐|学弟|学妹|班主任|辅导员|教练|同桌/ },
        { id: 'friend', label: '朋友', c1: '#86efac', c2: '#15803d', kw: /朋友|好友|闺蜜|兄弟|哥们|姐妹|室友|同住|邻居|发小|死党|搭子/ },
        { id: 'work', label: '工作', c1: '#7dd3fc', c2: '#0369a1', kw: /老板|领导|上司|上级|主管|经理|总监|同事|客户|下属|员工|搭档|合作|商务|甲方|乙方|面试官|HR|boss|lead|manager|组长/i }
    ];
    const KIND_OTHER = { id: 'other', label: '其他', c1: '#cbd5e1', c2: '#64748b' };
    /* 图上用的 2 字短名，全名留给图例和详情卡 */
    const KIND_SHORT = { family: '家人', love: '恋爱', study: '学业', friend: '朋友', work: '工作', other: '其他' };
    const KIND_ME = { id: 'me', label: '本人', c1: '#fcd34d', c2: '#d97706' };

    let gData = null;
    let gSel = null;
    let gEdit = null;

    function kindById(id) {
        if (id === 'me') return KIND_ME;
        return REL_KINDS.find(k => k.id === id) || KIND_OTHER;
    }

    /* 分类来源：手动指定的 category 优先，没指定才按关系词猜 */
    function kindOf(entity) {
        const c = String((entity && entity.category) || '').trim();
        if (c && (c === 'other' || REL_KINDS.some(k => k.id === c))) return c;
        const rel = String((entity && entity.relation) || '');
        const hit = REL_KINDS.find(k => k.kw.test(rel));
        return hit ? hit.id : 'other';
    }

    function renderLegend() {
        const box = $('graph-legend');
        if (!box) return;
        box.innerHTML = REL_KINDS.map(k =>
            '<span><i class="dot" style="background:' + k.c2 + '"></i>' + k.label + '</span>'
        ).join('') + '<span class="legend-hint">你 → 类别 → 人物 · 点类别看成员，点人物看事件</span>';
    }

    async function openGraph() {
        $('graph-overlay').hidden = false;
        $('graph-canvas').innerHTML = '<div class="empty">读取中…</div>';
        $('graph-detail').innerHTML = '<p class="empty">点类别看成员，点人物看 TA 的事件</p>';
        gSel = null; gEdit = null;
        renderLegend();
        // 等两帧，确保覆盖层已完成布局、canvas 有真实宽高
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await reloadGraph(null);
    }

    /* 从仪表盘点人名直接跳到关系图里的那个人 */
    async function openGraphNamed(name) {
        await openGraph();
        const p = gData && gData.people.find(x => x.label === name);
        if (p) selectGraphNode(p.id);
        else toast('关系图里还没有「' + name + '」这个节点', true);
    }

    async function reloadGraph(keepId) {
        let profile = [], entities = [], events = [], followups = [];
        try {
            [profile, entities, events, followups] = await Promise.all([
                listProfile(), listEntities(), listEvents(300), listFollowups(100)
            ]);
        } catch (e) {
            $('graph-canvas').innerHTML = '<div class="empty">读取失败：' + esc(e.message || e) + '</div>';
            return;
        }
        renderGraph(profile, entities, events, followups);
        if (keepId) selectGraphNode(keepId);
        else selectGraphNode(null);
        renderDashboard();
    }

    /* 折叠状态：某类别人物太多时先只画前 N 个，点「+N」展开 */
    let gExpand = new Set();
    let gLast = null;

    function byId(id) {
        if (!gData || !id) return null;
        if (id === 'me') return gData.me;
        if (id.indexOf('more-') === 0) return null;
        if (id.indexOf('k') === 0) return gData.cats.find(c => c.id === id) || null;
        return gData.people.find(p => p.id === id) || null;
    }

    const PERSON_CAP = 8;

    function personRadius(cnt) {
        return cnt >= 6 ? 18 : cnt >= 3 ? 16 : cnt >= 1 ? 14 : 12;
    }

    function renderGraph(profile, entities, events, followups) {
        gLast = { profile: profile, entities: entities, events: events, followups: followups };
        const canvas = $('graph-canvas');
        canvas.innerHTML = '';
        renderLegend();

        const meName = ((profile.find(p => p.field_key === 'name') || {}).field_value || '我').trim() || '我';
        const allEv = (events || []).slice();

        // 人物 → 事件
        const evByName = {};
        entities.forEach(en => { evByName[en.name] = []; });
        allEv.forEach(ev => {
            const names = (ev.entities || []).map(x => (x && x.name) ? x.name : String(x)).filter(Boolean);
            names.forEach(n => { if (evByName[n]) evByName[n].push(ev); });
        });

        // 人物先按类别归组，类别再挂到中心 —— 三级结构
        const catMap = {};
        entities.forEach(en => {
            const k = kindOf(en);
            (catMap[k] = catMap[k] || []).push({
                id: 'e' + en.id,
                entId: en.id,
                label: en.name,
                relation: en.relation || '',
                category: en.category || '',
                kind: k,
                parentId: 'k' + k,
                traits: en.traits || [],
                birthday: en.birthday || '',
                age_seen: en.age_seen || null,
                age_seen_on: en.age_seen_on || null,
                events: evByName[en.name] || []
            });
        });

        const order = REL_KINDS.map(k => k.id).concat(['other']);
        const cats = order.filter(k => catMap[k] && catMap[k].length).map(k => {
            const ppl = catMap[k];
            const seen = {};
            const evs = [];
            ppl.forEach(p => p.events.forEach(e => {
                if (!seen[e.id]) { seen[e.id] = 1; evs.push(e); }
            }));
            const expand = gExpand.has(k) || ppl.length <= PERSON_CAP;
            return {
                id: 'k' + k,
                kind: k,
                label: kindById(k).label,
                short: KIND_SHORT[k] || kindById(k).label,
                people: ppl,
                events: evs,
                shown: expand ? ppl : ppl.slice(0, PERSON_CAP),
                moreCount: expand ? 0 : ppl.length - PERSON_CAP
            };
        });

        const fus = followups || [];
        const fuByName = {};
        cats.forEach(c => c.people.forEach(p => { fuByName[p.label] = []; }));
        fus.forEach(f => {
            evNames(f).forEach(n => { if (fuByName[n]) fuByName[n].push(f); });
        });
        cats.forEach(c => {
            c.people.forEach(p => { p.followups = fuByName[p.label] || []; });
            c.followups = c.people.reduce((a, p) => a.concat(p.followups), []);
        });

        const me = { id: 'me', label: meName, kind: 'me', events: allEv, traits: [], followups: fus };
        gData = {
            me: me,
            cats: cats,
            people: cats.reduce((a, c) => a.concat(c.people), []),
            allEvents: allEv
        };

        $('graph-stats').textContent = cats.length + ' 个类别 · ' + gData.people.length + ' 个人物 · ' + allEv.length + ' 条事件';

        const w = canvas.clientWidth || 720;
        const h = canvas.clientHeight || 520;
        const cx = w / 2, cy = h / 2;

        /* ---------- 布局：中心 → 类别环 → 人物扇 ---------- */
        const pos = { me: { x: cx, y: cy } };
        const nCats = cats.length;
        const availX = Math.max(w / 2 - 62, 110);
        const availY = Math.max(h / 2 - 52, 96);
        // 类别离中心远一些，把外圈让给人物
        const R1x = availX * 0.55, R1y = availY * 0.57;
        const startA = -Math.PI / 2;
        // 相邻类别间距决定人物小圈的最大半径，太大会和隔壁类别打架
        const neighborGap = nCats > 1 ? 2 * R1x * Math.sin(Math.PI / nCats) : availX;
        const ringMax = Math.min(Math.min(availX, availY) * 0.36, neighborGap * 0.44);

        // 按成员数分配角度扇区：人多的类别占更宽的角度，避免全挤在一根线上
        const weights = cats.map(c => Math.max(2, c.shown.length));
        const totalW = weights.reduce((a, b) => a + b, 0) || 1;
        let acc = 0;

        cats.forEach((cat, i) => {
            const sector = (Math.PI * 2 * weights[i]) / totalW;
            const a = startA + acc + sector / 2;
            acc += sector;
            cat.angle = a;
            cat.pos = { x: cx + Math.cos(a) * R1x, y: cy + Math.sin(a) * R1y };
            pos[cat.id] = cat.pos;

            const n = cat.shown.length;
            // 人物绕类别节点均匀铺满一圈；起始角偏移半步，避免正好挡在「我→类别」那条线上
            const rp = Math.min(ringMax, Math.max(58, 30 + n * 10));
            const step = n ? (Math.PI * 2) / n : 0;
            // 奇数个从「正外侧」起排，偶数个偏移半个步长 —— 两种情况都不会有人物正好挡在
            // 「我 → 类别」那条线上
            const base = a + (n % 2 === 0 ? Math.PI / n : 0);
            cat.shown.forEach((p, j) => {
                const b = base + j * step;
                pos[p.id] = { x: cat.pos.x + Math.cos(b) * rp, y: cat.pos.y + Math.sin(b) * rp };
            });
            if (cat.moreCount) {
                pos['more-' + cat.kind] = {
                    x: cat.pos.x + Math.cos(a) * (rp + 30),
                    y: cat.pos.y + Math.sin(a) * (rp + 30)
                };
            }
        });

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        /* ---------- 渐变 / 阴影 ---------- */
        const defs = document.createElementNS(SVG_NS, 'defs');
        const usedKinds = ['me'].concat(cats.map(c => c.kind)).filter((v, i, a) => a.indexOf(v) === i);
        usedKinds.forEach(k => {
            const kk = kindById(k);
            const grad = document.createElementNS(SVG_NS, 'radialGradient');
            grad.setAttribute('id', 'xbg-' + k);
            grad.setAttribute('cx', '30%');
            grad.setAttribute('cy', '26%');
            grad.setAttribute('r', '80%');
            [['0%', kk.c1], ['100%', kk.c2]].forEach(([off, col]) => {
                const st = document.createElementNS(SVG_NS, 'stop');
                st.setAttribute('offset', off);
                st.setAttribute('stop-color', col);
                grad.appendChild(st);
            });
            defs.appendChild(grad);
        });
        const filt = document.createElementNS(SVG_NS, 'filter');
        filt.setAttribute('id', 'xbshadow');
        filt.setAttribute('x', '-70%'); filt.setAttribute('y', '-70%');
        filt.setAttribute('width', '240%'); filt.setAttribute('height', '240%');
        const ds = document.createElementNS(SVG_NS, 'feDropShadow');
        ds.setAttribute('dx', '0'); ds.setAttribute('dy', '4');
        ds.setAttribute('stdDeviation', '5'); ds.setAttribute('flood-opacity', '0.45');
        filt.appendChild(ds);
        defs.appendChild(filt);
        svg.appendChild(defs);

        /* ---------- 连线：中心→类别→人物 ---------- */
        const catR = 25;
        const showRel = gData.people.length <= 6;

        const addEdge = (from, to, r1, r2, color, width, opacity, a, b, curve, labelText) => {
            const dx = to.x - from.x, dy = to.y - from.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            const sx = from.x + ux * (r1 + 4), sy = from.y + uy * (r1 + 4);
            const ex = to.x - ux * (r2 + 4), ey = to.y - uy * (r2 + 4);
            const span = Math.hypot(ex - sx, ey - sy) || 1;
            const off = span * curve;
            const qx = (sx + ex) / 2 - (dy / len) * off;
            const qy = (sy + ey) / 2 + (dx / len) * off;

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', 'M' + sx + ',' + sy + ' Q' + qx + ',' + qy + ' ' + ex + ',' + ey);
            path.setAttribute('class', 'gedge');
            path.dataset.a = a;
            path.dataset.b = b;
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-opacity', String(opacity));
            path.setAttribute('stroke-width', String(width));
            svg.appendChild(path);

            if (labelText) {
                const t0 = 0.58, u = 1 - t0;
                const mx = u * u * sx + 2 * u * t0 * qx + t0 * t0 * ex;
                const my = u * u * sy + 2 * u * t0 * qy + t0 * t0 * ey;
                const t = document.createElementNS(SVG_NS, 'text');
                t.setAttribute('x', mx - (dy / len) * 3);
                t.setAttribute('y', my + (dx / len) * 3);
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('class', 'gedge-label');
                t.dataset.a = a;
                t.dataset.b = b;
                t.textContent = labelText.length > 7 ? labelText.slice(0, 7) + '…' : labelText;
                svg.appendChild(t);
            }
        };

        cats.forEach(cat => {
            addEdge(pos.me, cat.pos, 34, catR, kindById(cat.kind).c2, 2.4, 0.55, 'me', cat.id, 0.05, '');
            cat.shown.forEach(p => {
                const pp = pos[p.id];
                if (!pp) return;
                addEdge(cat.pos, pp, catR, personRadius(p.events.length),
                    kindById(cat.kind).c2, 1.5, 0.45, cat.id, p.id, 0.08,
                    showRel ? p.relation : '');
            });
            if (cat.moreCount) {
                const mp = pos['more-' + cat.kind];
                if (mp) addEdge(cat.pos, mp, catR, 13, kindById(cat.kind).c2, 1.2, 0.35, cat.id, 'more-' + cat.kind, 0.06, '');
            }
        });

        /* ---------- 节点 ---------- */
        const addNode = (n, p, r, kd, opts) => {
            const isMe = n.id === 'me';
            const g = document.createElementNS(SVG_NS, 'g');
            g.setAttribute('class', 'gnode' + (opts.cat ? ' cat' : ''));
            g.dataset.node = n.id;
            g.dataset.a = opts.a || n.id;
            g.dataset.b = opts.b || n.id;

            const halo = document.createElementNS(SVG_NS, 'circle');
            halo.setAttribute('cx', p.x); halo.setAttribute('cy', p.y);
            halo.setAttribute('r', r + (isMe ? 8 : 6));
            halo.setAttribute('fill', kd.c2);
            halo.setAttribute('opacity', isMe ? '0.22' : '0.13');
            halo.setAttribute('class', 'halo');
            g.appendChild(halo);

            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', r);
            c.setAttribute('fill', 'url(#xbg-' + n.kind + ')');
            c.setAttribute('stroke', isMe ? '#fff' : 'rgba(255,255,255,.6)');
            c.setAttribute('stroke-width', isMe ? '2.5' : (opts.cat ? '2' : '1.6'));
            c.setAttribute('filter', 'url(#xbshadow)');
            c.setAttribute('class', 'core');
            g.appendChild(c);

            if (isMe) {
                const ring = document.createElementNS(SVG_NS, 'circle');
                ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y);
                ring.setAttribute('r', r + 5);
                ring.setAttribute('fill', 'none');
                ring.setAttribute('stroke', kd.c1);
                ring.setAttribute('stroke-width', '1.2');
                ring.setAttribute('stroke-dasharray', '4 5');
                ring.setAttribute('opacity', '0.75');
                g.appendChild(ring);
            }

            const inner = document.createElementNS(SVG_NS, 'text');
            inner.setAttribute('x', p.x);
            inner.setAttribute('y', p.y + 4);
            inner.setAttribute('text-anchor', 'middle');
            inner.setAttribute('dominant-baseline', 'middle');
            inner.setAttribute('class', opts.cat ? 'gcname' : 'gcount');
            if (isMe) {
                inner.style.fill = '#3b2300';
                inner.textContent = '我';
            } else if (opts.cat) {
                inner.textContent = n.short || n.label;
            } else {
                inner.textContent = opts.badge != null ? opts.badge : '';
            }
            g.appendChild(inner);

            // 类别节点右上角的小数量徽章
            if (opts.cat && opts.badge) {
                const bx = p.x + r * 0.72, by = p.y - r * 0.72;
                const bc = document.createElementNS(SVG_NS, 'circle');
                bc.setAttribute('cx', bx); bc.setAttribute('cy', by); bc.setAttribute('r', 9);
                bc.setAttribute('fill', 'var(--panel)');
                bc.setAttribute('stroke', kd.c2);
                bc.setAttribute('stroke-width', '1.4');
                g.appendChild(bc);
                const bt = document.createElementNS(SVG_NS, 'text');
                bt.setAttribute('x', bx); bt.setAttribute('y', by);
                bt.setAttribute('text-anchor', 'middle');
                bt.setAttribute('dominant-baseline', 'middle');
                bt.setAttribute('class', 'gbadge');
                bt.textContent = opts.badge;
                g.appendChild(bt);
            }

            if (opts.cat) { svg.appendChild(g); return g; }
            const label = document.createElementNS(SVG_NS, 'text');
            // 标签沿「远离父节点」的方向摆，避免压住上级节点
            const dx = opts.dir ? opts.dir.x : 0;
            const dy = opts.dir ? opts.dir.y : 1;
            const gap = isMe ? 20 : 15;
            label.setAttribute('x', p.x + dx * (r + gap));
            label.setAttribute('y', p.y + dy * (r + gap));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('dominant-baseline', 'middle');
            label.setAttribute('class', isMe ? 'gme-label' : '');
            const txt = opts.cat ? (n.short || n.label) : n.label;
            const maxLen = opts.cat ? 2 : (gData.people.length > 16 ? 4 : 7);
            label.textContent = txt.length > maxLen ? txt.slice(0, maxLen) + '…' : txt;
            g.appendChild(label);

            svg.appendChild(g);
            return g;
        };

        addNode(me, pos.me, 34, kindById('me'), { dir: { x: 0, y: 1 } });
        cats.forEach(cat => {
            const cdx = cat.pos.x - cx, cdy = cat.pos.y - cy;
            const clen = Math.hypot(cdx, cdy) || 1;
            addNode(cat, pos[cat.id], catR, kindById(cat.kind), {
                cat: true, badge: cat.people.length,
                dir: { x: cdx / clen, y: cdy / clen }
            });
            cat.shown.forEach(p => {
                const pp = pos[p.id];
                if (!pp) return;
                const pdx = pp.x - cat.pos.x, pdy = pp.y - cat.pos.y;
                const plen = Math.hypot(pdx, pdy) || 1;
                const ng = addNode(p, pp, personRadius(p.events.length), kindById(p.kind), {
                    badge: p.events.length || '',
                    dir: { x: pdx / plen, y: pdy / plen }
                });
                if (gData.people.length > 16) ng.classList.add('dense');
            });
            if (cat.moreCount) {
                const mp = pos['more-' + cat.kind];
                if (!mp) return;
                const g = document.createElementNS(SVG_NS, 'g');
                g.setAttribute('class', 'gnode');
                g.dataset.node = 'more-' + cat.kind;
                g.dataset.a = cat.id;
                g.dataset.b = 'more-' + cat.kind;
                const mc = document.createElementNS(SVG_NS, 'circle');
                mc.setAttribute('cx', mp.x); mc.setAttribute('cy', mp.y); mc.setAttribute('r', 13);
                mc.setAttribute('fill', 'var(--panel-2)');
                mc.setAttribute('stroke', kindById(cat.kind).c2);
                mc.setAttribute('stroke-width', '1.6');
                mc.setAttribute('class', 'core');
                g.appendChild(mc);
                const mt = document.createElementNS(SVG_NS, 'text');
                mt.setAttribute('x', mp.x); mt.setAttribute('y', mp.y + 4);
                mt.setAttribute('class', 'gcount');
                mt.style.fill = 'var(--text)';
                mt.textContent = '+' + cat.moreCount;
                g.appendChild(mt);
                svg.appendChild(g);
            }
        });

        svg.addEventListener('click', (e) => {
            const hit = e.target.closest('[data-node]');
            if (!hit) { selectGraphNode(null); return; }
            const nid = hit.dataset.node;
            if (nid.indexOf('more-') === 0) {
                gExpand.add(nid.slice(5));
                renderGraph(gLast.profile, gLast.entities, gLast.events, gLast.followups);
                selectGraphNode('k' + nid.slice(5));
                return;
            }
            selectGraphNode(nid);
        });

        canvas.appendChild(svg);

        if (!cats.length) {
            const hint = document.createElement('div');
            hint.className = 'empty';
            hint.style.cssText = 'position:absolute;left:0;right:0;bottom:26px;padding:0 20px';
            hint.innerHTML = '还没有记录到人物。<br>聊天里提到「我妈妈」「我老板」这类人，这里就会长出来；也可以点右上角「➕ 新增人物」手动加。';
            canvas.appendChild(hint);
        }
    }

    function selectGraphNode(id) {
        gSel = id || null;
        gEdit = null;
        const svg = $('graph-canvas').querySelector('svg');
        if (svg) {
            const node = byId(id);
            // 选中类别 → 高亮「我→类别」和「类别→成员」；选中人物 → 只高亮它的那条链路
            const nodeOn = (nid) => {
                if (!id || id === 'me') return true;
                if (nid === 'me' || nid === id) return true;
                if (!node) return false;
                if (node.people) return node.people.some(p => p.id === nid) || nid === 'more-' + node.kind;
                return nid === node.parentId;
            };
            const edgeOn = (a, b) => {
                if (!id || id === 'me') return true;
                if (!node) return false;
                if (node.people) return (a === 'me' && b === id) || (a === id);
                return (a === 'me' && b === node.parentId) || (a === node.parentId && b === id);
            };
            svg.querySelectorAll('[data-node]').forEach(g => {
                const on = nodeOn(g.dataset.node);
                g.classList.toggle('active', !!id && on);
                g.classList.toggle('dim', !!id && !on);
            });
            svg.querySelectorAll('.gedge, .gedge-label').forEach(el => {
                const on = edgeOn(el.dataset.a, el.dataset.b);
                el.classList.toggle('active', !!id && on);
                el.classList.toggle('dim', !!id && !on);
            });
        }
        if (!id) {
            $('graph-detail').innerHTML = '<p class="empty">点一下类别看成员，点人物看 TA 的事件</p>';
            return;
        }
        showGraphDetail(id);
    }

    function showGraphDetail(id) {
        if (!gData) return;
        const node = byId(id);
        const box = $('graph-detail');
        if (!node) { box.innerHTML = '<p class="empty">节点不存在</p>'; return; }

        const isMe = id === 'me';
        const isCat = !!node.people;
        const kd = kindById(node.kind);
        const parts = [];

        parts.push('<div class="gd-head"><span class="gd-name">' + esc(node.label) + '</span>');
        if (!isMe && !isCat && node.relation) {
            parts.push('<span class="gd-rel" style="color:' + kd.c2 + '">' + esc(node.relation) + '</span>');
        }
        if (!isMe) parts.push('<span class="gd-kind" style="background:' + kd.c2 + '">' + kd.label + '</span>');
        parts.push('</div>');

        if (isCat) {
            parts.push('<p class="gd-traits">' + node.people.length + ' 人 · ' + node.events.length + ' 条相关事件</p>');
        } else if (!isMe) {
            if (node.traits && node.traits.length) {
                parts.push('<p class="gd-traits">标签：' + esc(node.traits.join('、')) + '</p>');
            }
        } else {
            parts.push('<p class="gd-traits">' + gData.cats.length + ' 个类别 · ' + gData.people.length + ' 个人物</p>');
        }

        if (gEdit && gEdit.mode === 'person') {
            parts.push(personForm(isCat ? null : ((isMe || isCat) ? null : node)));
        } else if (gEdit && gEdit.mode === 'event') {
            const ev = gEdit.evId ? (node.events || []).find(x => String(x.id) === String(gEdit.evId)) : null;
            parts.push(eventForm(ev));
        } else {
            parts.push('<div class="gd-actions">');
            if (isCat) parts.push('<button class="btn ghost tiny" data-gact="add-person" data-kind="' + node.kind + '">➕ 在这个类别下加人</button>');
            if (!isMe && !isCat) parts.push('<button class="btn ghost tiny" data-gact="edit-person">✏️ 编辑资料</button>');
            parts.push('<button class="btn ghost tiny" data-gact="add-event">➕ 添加事件</button>');
            if (!isMe && !isCat) parts.push('<button class="btn danger tiny" data-gact="del-person">🗑 删除人物</button>');
            parts.push('</div>');
        }

        if (isCat && node.people.length) {
            parts.push('<div class="gd-sub"><span>类别成员</span></div>');
            parts.push('<div class="gd-chips">' + node.people.map(p =>
                '<button class="gd-chip" data-gact="pick" data-id="' + p.id + '">' +
                esc(p.label) + (p.events.length ? '<i>' + p.events.length + '</i>' : '') + '</button>'
            ).join('') + '</div>');
        }

        const fus = (node.followups || []).slice();
        if (fus.length) {
            const fuTitle = isMe ? '全部待追问' : '和 TA 有关的待追问';
            parts.push('<div class="gd-sub"><span>' + fuTitle + ' · ' + fus.length + ' 条</span></div>');
            fus.forEach(f => {
                parts.push('<div class="gd-ev" style="border-left-color:var(--red)">');
                parts.push('<div class="gd-ev-title">' + esc(f.description) + '</div>');
                parts.push('<div class="gd-ev-meta">' +
                    (f.due_date ? esc(String(f.due_date).slice(0, 10)) : '未定期') + ' · 待追问</div>');
                parts.push('</div>');
            });
        }

        const evs = (node.events || []).slice().sort((a, b) =>
            String(b.event_date || '').localeCompare(String(a.event_date || '')));
        const subTitle = isMe ? '全部事件' : (isCat ? '这个类别下的事件' : '和 TA 相关的事件');
        parts.push('<div class="gd-sub"><span>' + subTitle + ' · ' + evs.length + ' 条</span></div>');

        if (!evs.length) {
            parts.push('<p class="gd-empty">' +
                (isMe
                    ? '还没有记录到事件。聊天里提到发生的事（生日、出差、吵架…）就会出现在这里，也可以手动添加。'
                    : '这里还没有事件。点上面的「➕ 添加事件」加一条。') + '</p>');
        } else {
            evs.forEach(ev => {
                const imp = parseInt(ev.importance, 10) || 5;
                const color = kindColorByEmotion(ev.emotion);
                parts.push('<div class="gd-ev" style="border-left-color:' + color + '">');
                parts.push('<div class="ev-tools">');
                parts.push('<button class="del-btn" data-gact="edit-event" data-evid="' + ev.id + '" title="编辑">✏️</button>');
                parts.push('<button class="del-btn" data-gact="del-event" data-evid="' + ev.id + '" title="删除">✕</button>');
                parts.push('</div>');
                parts.push('<div class="gd-ev-title">' + esc(ev.title || '(无标题)') + '</div>');
                parts.push('<div class="gd-ev-meta">' + esc(ev.event_date || '日期未记录') +
                    ' · 重要度 ' + imp + '/10 · ' + esc(EMO_LABEL[ev.emotion] || ev.emotion || '未标注') + '</div>');
                if (ev.description) parts.push('<div class="gd-ev-desc">' + esc(ev.description) + '</div>');
                parts.push('</div>');
            });
        }
        box.innerHTML = parts.join('');
    }

    function kindColorByEmotion(e) {
        return ({ joy: '#22c55e', excited: '#f59e0b', grateful: '#14b8a6', neutral: '#64748b',
                  anxiety: '#eab308', sadness: '#6366f1', anger: '#ef4444', fear: '#a855f7' })[e] || '#64748b';
    }

    function personForm(node) {
        const rel = node ? node.relation : '';
        const cat = node ? (node.category || '') : ((gEdit && gEdit.presetKind) || '');
        const traits = node && node.traits ? node.traits.join('、') : '';
        const opts = ['<option value="">自动判断</option>'].concat(
            REL_KINDS.map(k => '<option value="' + k.id + '"' + (cat === k.id ? ' selected' : '') + '>' + k.label + '</option>'),
            ['<option value="other"' + (cat === 'other' ? ' selected' : '') + '>其他</option>']
        ).join('');
        return '<div class="gform">'
            + '<label>名字 / 称呼</label>'
            + '<input id="gf-name" value="' + esc(node ? node.label : '') + '" placeholder="如 妈妈、王经理">'
            + '<label>关系</label>'
            + '<input id="gf-relation" value="' + esc(rel) + '" placeholder="如 母亲、上司、大学室友">'
            + '<div class="gform-row">'
            + '<div><label>生日（YYYY-MM-DD 或 11-02）</label><input id="gf-birthday" value="' + esc(node && node.birthday ? node.birthday : '') + '" placeholder="2004-11-02"></div>'
            + '<div><label>岁数（不知生日才填）</label><input id="gf-age" type="number" min="0" max="120" value="' + esc(node && currentAge(node) !== null ? currentAge(node) : '') + '"></div>'
            + '</div>'
            + '<label>分类（不选则按关系词自动判断）</label>'
            + '<select id="gf-category">' + opts + '</select>'
            + '<label>标签（顿号或逗号分隔，如 强势、护短）</label>'
            + '<input id="gf-traits" value="' + esc(traits) + '" placeholder="如 强势、护短">'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-gact="save-person">💾 保存</button>'
            + '<button class="btn ghost tiny" data-gact="cancel">取消</button>'
            + '</div></div>';
    }

    function eventForm(ev) {
        const emoOpts = ['joy', 'sadness', 'anxiety', 'excited', 'grateful', 'anger', 'fear', 'neutral']
            .map(k => '<option value="' + k + '"' + ((ev && ev.emotion === k) ? ' selected' : '') + '>' + EMO_LABEL[k] + '</option>').join('');
        return '<div class="gform">'
            + '<label>事件标题</label>'
            + '<input id="ge-title" value="' + esc(ev ? ev.title : '') + '" placeholder="一句话概括，如 妈妈过生日">'
            + '<div class="gform-row">'
            + '<div><label>日期</label><input id="ge-date" type="date" value="' + esc(ev && ev.event_date ? String(ev.event_date).slice(0, 10) : '') + '"></div>'
            + '<div><label>重要度 1-10</label><input id="ge-imp" type="number" min="1" max="10" value="' + (ev ? (parseInt(ev.importance, 10) || 5) : 5) + '"></div>'
            + '</div>'
            + '<label>情绪</label>'
            + '<select id="ge-emo">' + emoOpts + '</select>'
            + '<label>细节</label>'
            + '<textarea id="ge-desc" placeholder="发生了什么、你的感受">' + esc(ev ? (ev.description || '') : '') + '</textarea>'
            + '<div class="gform-btns">'
            + '<button class="btn primary tiny" data-gact="save-event">💾 保存</button>'
            + '<button class="btn ghost tiny" data-gact="cancel">取消</button>'
            + '</div></div>';
    }

    function openNewPersonForm(kind) {
        if (!gData) { toast('先打开关系图', true); return; }
        gSel = null;
        gEdit = { mode: 'person', isNew: true, presetKind: kind || '' };
        const title = kind ? ('➕ 新增人物 · ' + kindById(kind).label) : '➕ 新增人物';
        $('graph-detail').innerHTML = '<div class="gd-head"><span class="gd-name">' + title + '</span></div>' + personForm(null);
    }

    /* 人物表单里的生日/岁数/标签：有完整生日就不存岁数，岁数每次现算 */
    function personPatchFromDom(prefix) {
        const bdRaw = ($(prefix + '-birthday') || {}).value || '';
        const ageRaw = ($(prefix + '-age') || {}).value || '';
        const ageVal = parseInt(ageRaw, 10) || 0;
        let bd = normBirthday(bdRaw);
        if (bd && bd.length === 5 && ageVal) bd = fillBirthdayYear(bd, ageVal);
        const traits = (($(prefix + '-traits') || {}).value || '')
            .split(/[,，、\s]+/).filter(Boolean)
            .filter(v => !/^\d{1,3}\s*岁$/.test(v) && !/^(生日|出生)/.test(v));
        return {
            birthday: bd || null,
            age_seen: bd ? null : (ageVal || null),
            age_seen_on: bd ? null : (ageVal ? todayISO() : null),
            traits: traits
        };
    }

    async function savePerson() {
        const name = ($('gf-name').value || '').trim();
        if (!name) { toast('名字不能为空', true); return; }
        const relation = ($('gf-relation').value || '').trim();
        const category = $('gf-category').value || '';
        const p = personPatchFromDom('gf');
        const traits = p.traits;
        const editing = gSel && gSel !== 'me' ? gData.people.find(p => p.id === gSel) : null;
        try {
            if (!editing) {
                await unwrap(db().from('xb_entities').upsert(
                    { name: name, relation: relation, category: category, traits: traits,
                      birthday: p.birthday, age_seen: p.age_seen, age_seen_on: p.age_seen_on,
                      last_mentioned: new Date().toISOString() },
                    { onConflict: 'owner_id,name' }
                ));
                toast('已新增人物「' + name + '」');
                gEdit = null;
                await reloadGraph(null);
            } else {
                const oldName = editing.label;
                await unwrap(db().from('xb_entities').update({
                    name: name, relation: relation, category: category, traits: traits,
                    birthday: p.birthday, age_seen: p.age_seen, age_seen_on: p.age_seen_on
                }).eq('id', editing.entId).select());
                // 改名后同步事件里的关联人名，否则事件会掉到中心节点
                if (oldName !== name) await renameInEvents(oldName, name);
                toast('已保存');
                gEdit = null;
                await reloadGraph(gSel);
            }
        } catch (e) {
            toast('保存失败：' + ((e && e.message) || e), true);
        }
    }

    async function saveEvent() {
        const title = ($('ge-title').value || '').trim();
        if (!title) { toast('标题不能为空', true); return; }
        const date = ($('ge-date').value || '').trim() || null;
        const imp = Math.max(1, Math.min(10, parseInt($('ge-imp').value, 10) || 5));
        const emo = $('ge-emo').value || 'neutral';
        const desc = ($('ge-desc').value || '').trim();
        const evId = gEdit && gEdit.evId;
        try {
            if (evId) {
                const node = byId(gSel);
                const ev = node && (node.events || []).find(x => String(x.id) === String(evId));
                const ents = (ev && Array.isArray(ev.entities)) ? ev.entities : [];
                await unwrap(db().from('xb_events').update({
                    title: title, event_date: date, importance: imp, emotion: emo, description: desc, entities: ents
                }).eq('id', evId).select());
                toast('事件已更新');
            } else {
                const person = (gSel && gSel !== 'me') ? gData.people.find(p => p.id === gSel) : null;
                // 类别节点上加事件：先不挂人，可再点进具体人物补
                await unwrap(db().from('xb_events').insert({
                    title: title, event_date: date, importance: imp, emotion: emo, description: desc,
                    entities: person ? [{ name: person.label }] : [], category: 'other'
                }).select());
                toast('事件已添加');
            }
            gEdit = null;
            await reloadGraph(gSel);
        } catch (e) {
            const msg = (e && (e.message || e.code)) || e;
            toast('保存失败：' + String(msg).slice(0, 80), true);
        }
    }

    async function deletePerson() {
        const node = gData && gData.people.find(p => p.id === gSel);
        if (!node || !node.entId) return;
        if (await deletePersonCascade(node.label, node.entId)) {
            gSel = null; gEdit = null;
            await reloadGraph(null);
        }
    }

    async function deleteEvent(evId) {
        if (!evId) return;
        if (!confirm('删除这条事件？不可恢复。')) return;
        try {
            await unwrap(db().from('xb_events').delete().eq('id', evId).select());
            toast('事件已删除');
            await reloadGraph(gSel);
        } catch (e) { toast('删除失败：' + ((e && e.message) || e), true); }
    }

    function closeGraph() {
        $('graph-overlay').hidden = true;
        gData = null; gSel = null; gEdit = null;
    }

    /* ============================================================
       搜索记忆：一段对话一行（最多 100 行，可单删/全清）
       ============================================================ */
    const CONV_LIMIT = 100;
    let convRows = [];
    const openConvs = new Set();

    function snippet(raw, q, len) {
        const s = String(raw || '').replace(/\s+/g, ' ');
        if (!q) return s.slice(0, len);
        const i = s.toLowerCase().indexOf(q);
        if (i < 0) return s.slice(0, len);
        const start = Math.max(0, i - Math.floor(len / 3));
        return (start > 0 ? '…' : '') + s.slice(start, start + len);
    }

    function highlight(raw, q) {
        const s = String(raw || '');
        const i = s.toLowerCase().indexOf(q);
        if (i < 0) return esc(s);
        return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
    }

    function convBodyHtml(row, q) {
        if (!row.msgs.length) return '<div class="empty" style="padding:16px 0">这段对话已经清空了。</div>';
        return row.msgs.map(m => {
            const t = localHM(m.created_at);
            const txt = q ? highlight(m.content, q) : esc(m.content || '');
            return '<div class="day-msg ' + (m.role === 'user' ? 'user' : 'bot') + '">'
                + '<span class="who">' + (m.role === 'user' ? '你' : '小伴') + '</span>'
                + '<span class="txt">' + txt + '</span>'
                + '<span class="time">' + esc(t) + '</span>'
                + '<button class="del-btn msg-del" data-del-msg="' + m.id + '" title="删除这条对话">✕</button></div>';
        }).join('');
    }

    async function allMessages(limit) {
        const rows = (await unwrap(db().from('xb_messages')
            .select('id,role,content,created_at,session_id')
            .order('id', { ascending: false })
            .limit(limit || 3000))) || [];
        return rows.reverse();
    }

    async function renderSearch() {
        const box = $('search-result');
        box.innerHTML = '<div class="empty">读取中…</div>';
        let sessions = [], msgs = [];
        try {
            [sessions, msgs] = await Promise.all([listSessions(CONV_LIMIT), allMessages(3000)]);
        } catch (e) {
            box.innerHTML = '<div class="empty">读取失败：' + esc(e.message || e) + '</div>';
            return;
        }
        if (!sessions.length) {
            $('search-hint').textContent = '';
            box.innerHTML = '<div class="empty">还没有对话记录。<br>去「💬 聊天」说几句话，这里就会一段对话一行地列出来。</div>';
            return;
        }

        const byConv = {};
        msgs.forEach(m => { (byConv[m.session_id] = byConv[m.session_id] || []).push(m); });

        const q = ($('search-input').value || '').trim();
        const ql = q.toLowerCase();
        let rows = sessions.map(s => ({ conv: s, msgs: byConv[s.id] || [] }));
        if (ql) {
            rows = rows.filter(r => r.msgs.some(m => String(m.content || '').toLowerCase().indexOf(ql) >= 0));
        }
        const total = rows.length;
        rows = rows.slice(0, CONV_LIMIT);
        convRows = rows;

        $('search-hint').textContent = ql
            ? '「' + q + '」命中 ' + total + ' 段对话，展示最近 ' + rows.length + ' 段 · 一段对话一行，点开看完整记录'
            : '共 ' + total + ' 段对话，展示最近 ' + rows.length + ' 段 · 一段对话一行，点开看完整记录';

        if (!rows.length) {
            box.innerHTML = '<div class="empty">没有找到与「' + esc(q) + '」相关的对话</div>';
            return;
        }

        box.innerHTML = rows.map((row, idx) => {
            const s = row.conv;
            const c = chars[s.character_id];
            const name = c ? (c.emoji + ' ' + c.name) : '（未知角色）';
            const hits = ql ? row.msgs.filter(m => String(m.content || '').toLowerCase().indexOf(ql) >= 0) : [];
            const sample = ql ? (hits[0] || row.msgs[0] || {}) : (row.msgs[row.msgs.length - 1] || {});
            const preview = snippet(sample.content, ql, 56);
            const hitBadge = ql ? '<span class="day-hit">命中 ' + hits.length + ' 处</span>' : '';
            const isOpen = openConvs.has(s.id);
            const when = (localDay(s.started_at) + ' ' + localHM(s.started_at)).trim();
            return '<div class="day-row conv-row' + (ql ? ' searching' : '') + (isOpen ? ' open' : '') + '" data-idx="' + idx + '">'
                + '<div class="conv-head day-head">'
                + '<span class="conv-name">' + esc(name) + '</span>'
                + '<span class="day-week">' + esc(when) + '</span>'
                + '<span class="day-count">' + row.msgs.length + ' 条</span>'
                + hitBadge
                + '<span class="day-preview">' + (ql ? highlight(preview, ql) : esc(preview)) + '</span>'
                + '<div class="day-tools">'
                + '<button class="conv-resume" data-resume-conv="' + s.id + '" title="回到这段对话继续聊">↩ 继续</button>'
                + '<button class="del-btn" data-del-conv="' + s.id + '" title="删除这段对话">✕</button>'
                + '<span class="day-caret">▾</span>'
                + '</div></div>'
                + '<div class="day-body"' + (isOpen ? '' : ' hidden') + '>' + convBodyHtml(row, ql) + '</div>'
                + '</div>';
        }).join('');
    }

    async function deleteByIds(table, ids) {
        if (!ids || !ids.length) return;
        for (let i = 0; i < ids.length; i += 80) {
            const chunk = ids.slice(i, i + 80);
            try {
                await unwrap(db().from(table).delete().in('id', chunk).select());
            } catch (e) {
                // 退路：逐条删，慢但不会因 in 语法差异整批失败
                for (const id of chunk) {
                    await unwrap(db().from(table).delete().eq('id', id).select());
                }
            }
        }
    }

    async function deleteConv(sessionId) {
        const row = convRows.find(r => String(r.conv.id) === String(sessionId));
        const n = row ? row.msgs.length : 0;
        if (!confirm('删除这段对话？' + (n ? '\n\n包含 ' + n + ' 条消息；' : '\n\n')
            + '这段对话产生的待追问也会一起删掉（事件和人物不受影响）。\n\n不可恢复。')) return;
        try {
            await unwrap(db().from('xb_messages').delete().eq('session_id', sessionId).select());
            await unwrap(db().from('xb_followups').delete().eq('session_id', sessionId).select());
            await unwrap(db().from('xb_sessions').delete().eq('id', sessionId).select());
            openConvs.delete(Number(sessionId));
            openConvs.delete(sessionId);
            toast('对话已删除');
            const wasCurrent = conv && String(conv.id) === String(sessionId);
            if (wasCurrent) {
                conv = null;
                await resumeConv();
            }
            await renderHistoryList();
            await renderSearch();
        } catch (e) { toast('删除失败：' + ((e && e.message) || e), true); }
    }

    async function clearAllMessages() {
        if (!confirm('清除全部对话记录？\n\n所有会话和消息都会删掉，记忆（人物、事件、个人信息、待追问）不受影响。')) return;
        try {
            await unwrap(db().from('xb_messages').delete().neq('id', 0).select());
            await unwrap(db().from('xb_sessions').delete().neq('id', 0).select());
            openConvs.clear();
            conv = null;
            await createConv(charId, true);
            toast('全部对话已清除');
            await renderSearch();
        } catch (e) { toast('清除失败：' + ((e && e.message) || e), true); }
    }

    /* ============================================================
       情绪日记：AI 读今天的对话，生成一篇日记
       ============================================================ */
    const JOURNAL_PROMPT = '你是一个温柔细腻的日记作者。请根据下面用户与陪伴角色的对话，写一篇第一人称日记。\n'
        + '要求：150-260 字，像自己写给自己的话，有细节、有情绪、不要分点罗列、不要复述对话原文、不要说教。\n'
        + '只输出一行合法 JSON，不要解释、不要代码围栏：\n'
        + '{"summary":"日记正文","emotion":"joy|sadness|anxiety|excited|grateful|anger|fear|neutral","highlights":["今天值得记住的1-3件小事"]}\n'
        + 'emotion 取今天最主要的那一种。\n\n【今天的对话】\n';

    async function listJournals(limit) {
        return (await unwrap(db().from('xb_journals').select('*').order('day', { ascending: false }).limit(limit || 30))) || [];
    }

    async function generateJournal() {
        const btn = $('gen-journal-2');
        const box = $('journal-body');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中…';
        box.innerHTML = '<div class="empty">正在读你今天的对话…</div>';
        try {
            const today = todayISO();
            const msgs = await listMessages(300);
            const todays = msgs.filter(m => localDay(m.created_at) === today);
            if (!todays.length) {
                box.innerHTML = '<div class="empty">今天还没有对话。<br>先去「💬 聊天」说几句话，再回来生成日记。</div>';
                toast('今天还没有对话', true);
                return;
            }
            const dialog = todays.map(m => (m.role === 'user' ? '我：' : '小伴：') + m.content).join('\n').slice(-4000);
            const pick = (modelList || []).some(m => (m.id || m.name) === EXTRACT_MODEL) ? EXTRACT_MODEL : modelId;
            if (!pick) throw new Error('没有可用模型，先去「聊天」右侧模型下拉里选一个');
            let text = '';
            const stream = cloud.llm.chat.completions.create({
                model: pick,
                messages: [
                    { role: 'system', content: '你是一个温柔细腻的日记作者，只输出 JSON。' },
                    { role: 'user', content: JOURNAL_PROMPT + dialog }
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 900
            });
            for await (const ch of stream) {
                const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                if (d && d.content) text += d.content;
            }

            let obj = null;
            const s = text.indexOf('{'), e = text.lastIndexOf('}');
            if (s >= 0 && e > s) {
                try { obj = JSON.parse(text.slice(s, e + 1)); } catch (err) { obj = null; }
            }
            if (!obj) obj = { summary: text.trim(), emotion: 'neutral', highlights: [] };
            const summary = String(obj.summary || '').trim();
            if (!summary) throw new Error('模型没有返回内容，稍后重试');

            await unwrap(db().from('xb_journals').upsert({
                day: today,
                summary: summary.slice(0, 3000),
                emotion: obj.emotion || 'neutral',
                highlights: Array.isArray(obj.highlights) ? obj.highlights.slice(0, 3).map(String) : [],
                msg_count: todays.length
            }, { onConflict: 'owner_id,day' }));

            await renderJournal();
            toast('今日日记已生成');
        } catch (err) {
            box.innerHTML = '<div class="empty">生成失败：' + esc((err && err.message) || err) + '</div>';
            toast('生成失败', true);
        } finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    }

    async function renderJournal() {
        const body = $('journal-body');
        body.innerHTML = '<div class="empty">读取中…</div>';
        let rows = [];
        try {
            rows = await listJournals(60);
        } catch (e) {
            body.innerHTML = '<div class="empty">读取失败：' + esc(e.message || e) + '</div>';
            return;
        }
        paintJournal(rows);
    }

    function paintJournal(rows) {
        const body = $('journal-body');
        if (!rows || !rows.length) {
            body.innerHTML = '<div class="empty">还没有日记。<br>点上方「✨ 生成今日日记」，AI 会读你今天的对话，写成一篇第一人称日记。</div>';
            return;
        }
        body.innerHTML = rows.map(j => {
            const emo = EMO_LABEL[j.emotion] || j.emotion || '未标注';
            const hls = Array.isArray(j.highlights) ? j.highlights : [];
            return '<div class="card journal-card">'
                + '<button class="del-btn journal-del" data-del-journal="' + j.id + '" title="删除这篇日记">✕</button>'
                + '<div class="journal-head">'
                + '<span class="journal-date">' + esc(String(j.day || '').slice(0, 10)) + '</span>'
                + '<span class="journal-emo">' + esc(emo) + '</span>'
                + '<span class="meta">' + (j.msg_count || 0) + ' 条对话</span>'
                + '</div>'
                + '<div class="journal-text">' + esc(j.summary || '') + '</div>'
                + (hls.length ? '<ul class="journal-hl">' + hls.map(h => '<li>' + esc(h) + '</li>').join('') + '</ul>' : '')
                + '</div>';
        }).join('');
    }

    function splitReplyAndMeta(text) {
        if (!text) return { reply: '', meta: {} };
        const i = text.indexOf(META_MARK);
        if (i < 0) return { reply: text.trim(), meta: {} };
        const reply = text.slice(0, i).trim();
        let tail = text.slice(i + META_MARK.length).trim();
        tail = tail.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
        const s = tail.indexOf('{'), e = tail.lastIndexOf('}');
        if (s < 0 || e <= s) return { reply: reply, meta: {} };
        try {
            const meta = JSON.parse(tail.slice(s, e + 1));
            return { reply: reply, meta: (meta && typeof meta === 'object') ? meta : {} };
        } catch (err) {
            console.warn('[小伴] 记忆 JSON 解析失败，已忽略', err);
            return { reply: reply, meta: {} };
        }
    }

    async function buildSystemPrompt() {
        let profile = [], events = [], entities = [], followups = [], topics = [], emotions = [];
        try {
            [profile, events, entities, followups, topics, emotions] = await Promise.all([
                listProfile(), listEvents(5), listEntities(),
                listFollowups(20, conv && conv.id ? conv.id : -1), listTopics(), listEmotions(5)
            ]);
        } catch (e) {
            console.warn('[小伴] 记忆上下文读取失败', e);
        }
        const c = currentCharacter();
        let charPrompt = (c && c.system_prompt) || '你是一个温柔的陪伴者。';

        const pAge = profileAgeInfo(profile);
        const personalCtx = profile.length ? profile.map(p => {
            const v = (p.field_key === 'age' && pAge) ? pAge.value : p.field_value;
            return '- ' + p.field_key + ': ' + v;
        }).join('\n') : '暂无已知个人信息';
        const eventCtx = events.length ? events.map(e => '- ' + e.title + (e.event_date ? '（' + e.event_date + '）' : '') + ' | 情绪: ' + e.emotion).join('\n') : '暂无记录的核心事件';
        const emoCtx = emotions.length ? ('最近情绪: ' + emotions.map(e => (EMO_LABEL[e.emotion] || e.emotion) + '(' + e.intensity + ')').join('、')) : '暂无情绪记录';
        const entCtx = entities.length ? entities.map(e => {
            const bits = [];
            if (e.relation) bits.push(e.relation);
            const a = currentAge(e);
            if (a !== null && a !== undefined) bits.push(a + '岁');
            if (e.birthday) bits.push('生日 ' + birthdayLabel(e.birthday));
            if (Array.isArray(e.traits) && e.traits.length) bits.push(e.traits.join('、'));
            return '- ' + e.name + (bits.length ? '（' + bits.join(' · ') + '）' : '');
        }).join('\n') : '暂无';
        const today0 = todayISO();
        const fuCtx = followups.length
            ? sortFollowups(followups).slice(0, 5).map(f => {
                const who = evNames(f);
                let due = '';
                if (f.due_date) {
                    const d = String(f.due_date).slice(0, 10);
                    due = d <= today0 ? '，已到期(' + d + ')' : '，' + d + ' 到期';
                }
                return '- ' + f.description + (who.length ? '（关于' + who.join('、') + '）' : '') + due;
            }).join('\n')
            : '暂无待办';
        const topicCtx = topics.length ? topics.map(t => t.topic).join('、') : '暂无偏好数据';

        charPrompt = charPrompt.replace('{sensitive_topics}', '暂无');
        charPrompt = charPrompt.replace('{custom_prompt}', '你是一个由用户自定义的AI陪伴角色。');

        return BASE_PROMPT
            .replace('{character_prompt}', charPrompt)
            .replace('{personal_context}', personalCtx)
            .replace('{event_context}', eventCtx)
            .replace('{emotion_context}', emoCtx)
            .replace('{entity_context}', entCtx)
            .replace('{followup_context}', fuCtx)
            .replace('{topic_context}', topicCtx);
    }

    async function loadModel() {
        try {
            // 注意：models.list() 直接返回数组，不是 {data, error} 信封
            const models = await cloud.llm.models.list();
            modelList = (Array.isArray(models) ? models : ((models && models.data) || []))
                .filter(m => m && (m.id || m.name));
        } catch (e) {
            console.warn('[小伴] 模型列表读取失败', e);
            modelList = [];
        }

        const usable = pickUsableModels();
        let saved = null;
        try { saved = localStorage.getItem('xb-model'); } catch (e) { /* ignore */ }
        if (saved && usable.some(m => (m.id || m.name) === saved)) {
            modelId = saved;
        } else if (usable.some(m => (m.id || m.name) === DEFAULT_MODEL)) {
            modelId = DEFAULT_MODEL;
        } else if (usable.length) {
            modelId = usable[0].id || usable[0].name;
        } else {
            modelId = null;
        }
        renderModelSelect();
    }

    /* 只保留实测能调通的模型；若目录整体变了导致一个都匹配不上，退回「全部非 disabled」 */
    function pickUsableModels() {
        const byId = (id) => modelList.find(m => (m.id || m.name) === id && m.disabled !== true);
        let usable = VERIFIED_MODELS.map(byId).filter(Boolean);
        if (!usable.length) {
            usable = modelList.filter(m => m.disabled !== true);
        }
        return usable;
    }

    /* 平台会在模型元数据里给一个 credits 系数，形如 "x0.08 credits"；0 就是免费 */
    function creditLabel(m) {
        const raw = String(m && m.credits || '');
        const mt = raw.match(/([\d.]+)/);
        if (!mt) return '';
        const n = parseFloat(mt[1]);
        if (!isFinite(n)) return '';
        return n === 0 ? '免费' : (n.toFixed(2) + ' cr');
    }

    function renderModelSelect() {
        const sel = $('model-select');
        if (!sel) return;
        const hint = $('model-hint');
        const usable = pickUsableModels();
        sel.innerHTML = '';
        if (!usable.length) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = '暂无可用模型';
            sel.appendChild(o);
            sel.disabled = true;
            if (hint) hint.textContent = '云端没有返回可用模型，请稍后刷新。';
            return;
        }
        sel.disabled = false;
        usable.forEach(m => {
            const id = m.id || m.name;
            const o = document.createElement('option');
            o.value = id;
            const cost = creditLabel(m);
            o.textContent = (m.name && m.name !== id ? (m.name + ' · ' + id) : id) + (cost ? '　' + cost : '');
            if (id === modelId) o.selected = true;
            sel.appendChild(o);
        });
        if (hint) {
            hint.textContent = usable.length + ' 个模型已实测可对话。cr = 平台单次调用的 credits 系数，'
                + '余额在 WorkBuddy 控制台查看（本应用不接触你的账号密钥）。';
        }
    }

    /* ============================================================
       发送消息
       ============================================================ */
    async function send() {
        const input = $('msg-input');
        const text = (input.value || '').trim();
        if (!text || busy) return;

        input.value = '';
        const at = nowHM();
        history.push({ role: 'user', content: text, at: at });
        appendBubble('user', text, at, true);
        appendTyping();
        busy = true;
        $('send-btn').disabled = true;
        // 用户这句话立刻进写入队列（不 await，不拖慢界面）：
        // 队列保证它先写、AI 的回答后写，历史里「提问在回答前面」不会是偶尔正确
        const userSave = addMessage('user', text).then(() => true, () => false);

        try {
            if (!modelId) await loadModel();
            if (!modelId) {
                removeTyping();
                appendBubble('assistant', '⚠️ 云端模型暂时不可用，请稍后重试。', nowHM(), true);
                busy = false;
                $('send-btn').disabled = false;
                return;
            }
            const sys = await buildSystemPrompt();
            const ctx = history.slice(-20).map(m => ({ role: m.role, content: m.content }));
            if (!ctx.length || ctx[ctx.length - 1].role !== 'user') {
                ctx.push({ role: 'user', content: text });
            }

            // 提取要看到本轮回复才能判断「哪条待追问被问过/处理掉了」，
            // 所以留到回复生成之后再异步跑（不阻塞界面）
            const recentCtx = history.slice(0, -1).slice(-6);

            let full = '';
            const typingRow = $('typing-row');
            const bubble = typingRow ? typingRow.querySelector('.bubble') : null;
            // 先保留「…」思考动画，等第一个字到了再换成文本容器，避免 1 秒多的空白气泡
            if (bubble) bubble.innerHTML = '<span class="time">' + esc(at) + '</span><span class="typing"><i></i><i></i><i></i></span>';
            let live = null;
            const ensureLive = () => {
                if (live || !bubble) return live;
                bubble.innerHTML = '<span class="time">' + esc(at) + '</span><span class="live"></span>';
                live = bubble.querySelector('.live');
                return live;
            };

            // 打字机：模型分片往往几十毫秒内密集到达，直接 setText 视觉上像"一次性弹出"。
            // 这里维护待显示缓冲，按节奏吐字；积压多时自动加速，保证不落后于模型。
            let visible = '';
            let shownLen = 0;
            const pump = () => {
                if (!visible.length) return;
                if (!ensureLive()) return;
                const backlog = visible.length - shownLen;
                if (backlog <= 0) return;
                // 每 22ms 吐 1~6 个字：积压越多越快，但不会一次蹦一大段，
                // 观感接近真实打字，同时不会明显落后于模型生成速度
                const step = backlog > 90 ? 6 : (backlog > 30 ? 3 : 1);
                shownLen = Math.min(visible.length, shownLen + step);
                live.textContent = visible.slice(0, shownLen);
                $('chat').scrollTop = $('chat').scrollHeight;
            };
            const typer = setInterval(pump, 22);

            // create() 直接返回 AsyncIterable，不要再 await（await 会破坏流式迭代）
            const stream = cloud.llm.chat.completions.create({
                model: modelId,
                messages: [{ role: 'system', content: sys }].concat(ctx),
                stream: true,
                temperature: 0.8,
                max_tokens: 1024
            });

            try {
                for await (const chunk of stream) {
                    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                    if (delta && delta.content) {
                        full += delta.content;
                        const cut = full.indexOf(META_MARK);
                        visible = cut >= 0 ? full.slice(0, cut) : full;
                        pump();
                    }
                }
            } finally {
                // 流结束后把缓冲吐完（最多再等 2.5 秒，避免异常时卡住）
                const deadline = Date.now() + 2500;
                while (shownLen < visible.length && Date.now() < deadline) {
                    pump();
                    await new Promise(r => setTimeout(r, 24));
                }
                clearInterval(typer);
            }

            const parsed = splitReplyAndMeta(full);
            const reply = parsed.reply || '……（这次没生成出来，再说一遍？）';
            history.push({ role: 'assistant', content: reply, at: nowHM() });

            // 直接复用正在打字的那条气泡收尾，避免内容相同却闪一下重新插入
            if (bubble) {
                bubble.innerHTML = '<span class="time">' + esc(nowHM()) + '</span>' + esc(reply);
                if (typingRow) typingRow.removeAttribute('id');
                $('chat').scrollTop = $('chat').scrollHeight;
            } else {
                removeTyping();
                appendBubble('assistant', reply, nowHM(), true);
            }

            // 落库：用户那句先落地，再写回答（顺序由写入队列保证）
            if (!(await userSave)) toast('这句话没保存成功，刷新后可能看不到它', true);
            await addMessage('assistant', reply).catch(e => console.warn('[小伴] 对话保存失败', e));
            renderHistoryList().catch(() => {});   // 左栏「最近聊的」排到最上面

            // 模型若自发带了 META（旧行为）先剥离入库；主路径是下面这次独立提取
            const inlineMeta = parsed.meta || {};
            if (Object.keys(inlineMeta).length) {
                applyMeta(inlineMeta).catch(e => console.warn('[小伴] 内联记忆保存失败', e));
            }
            extractMemory(text, recentCtx, reply).then(m => {
                if (!m || typeof m !== 'object') return null;
                const has = Object.keys(m.facts || {}).length > 0
                    || (m.events || []).length > 0
                    || (m.entities || []).length > 0
                    || (m.followups || []).length > 0
                    || (m.topics || []).length > 0
                    || (m.resolved_followups || []).length > 0
                    || (m.forget && Object.keys(m.forget).length > 0);
                return has ? applyMeta(m) : null;
            }).then(() => refreshAfterMemory())
              .catch(e => console.warn('[小伴] 记忆提取失败', e));

            renderHero();
            renderStatus();
        } catch (e) {
            removeTyping();
            const msg = (e && (e.message || (e.error && e.error.message))) || '模型调用失败';
            appendBubble('assistant', '⚠️ ' + msg, nowHM(), true);
            toast('模型调用失败：' + msg, true);
        } finally {
            busy = false;
            $('send-btn').disabled = false;
            input.focus();
        }
    }

    /* ============================================================
       登录
       ============================================================ */
    let pendingSignup = null;

    function showLogin(msg, ok) {
        $('login-view').hidden = false;
        $('app-view').hidden = true;
        const box = $('login-msg');
        box.textContent = msg || '';
        box.className = 'login-msg' + (ok ? ' ok' : '');
    }

    function showApp() {
        $('login-view').hidden = true;
        $('app-view').hidden = false;
    }

    function switchAuthTab(which) {
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.auth === which));
        $('login-form').hidden = which !== 'login';
        $('signup-form').hidden = which !== 'signup';
        $('reset-form').hidden = which !== 'reset';
        $('otp-form').hidden = which !== 'otp';
        document.querySelector('.auth-tabs').style.display = (which === 'login' || which === 'signup') ? 'flex' : 'none';
        const box = $('login-msg');
        box.textContent = '';
        box.className = 'login-msg';
    }

    /* ---------- 兜底：邮箱验证码登录（老账号没密码时用） ---------- */
    let pendingOtpLogin = null;

    async function sendOtpLoginCode() {
        const email = ($('otp-email').value || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('请输入正确的邮箱地址'); return; }
        const btn = $('send-otp-login');
        btn.disabled = true;
        btn.textContent = '发送中…';
        try {
            const sent = await cloud.auth.sendOtp({ email: email });
            if (sent.error) throw sent.error;
            pendingOtpLogin = {
                email: email,
                verificationId: sent.data.verificationId,
                isExistingUser: sent.data.isExistingUser
            };
            showLogin('验证码已发送，请查收邮件（也看下垃圾箱）', true);
            let left = 60;
            const timer = setInterval(() => {
                left -= 1;
                if (left <= 0) {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.textContent = '重新发送';
                } else {
                    btn.textContent = left + 's 后重发';
                }
            }, 1000);
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '获取验证码';
            showLogin('发送失败：' + ((e && e.message) || e));
        }
    }

    async function doOtpLogin(ev) {
        ev.preventDefault();
        const email = ($('otp-email').value || '').trim();
        const code = ($('otp-code').value || '').trim();
        if (!pendingOtpLogin || pendingOtpLogin.email !== email) {
            showLogin('请先点「获取验证码」，收件邮箱要与上面填的一致');
            return;
        }
        if (!code) { showLogin('请输入验证码'); return; }
        const btn = $('otp-btn');
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
            const done = await cloud.auth.verifyOtp({
                email: pendingOtpLogin.email,
                verificationId: pendingOtpLogin.verificationId,
                isExistingUser: pendingOtpLogin.isExistingUser,
                token: code
            });
            if (done.error) throw done.error;
            pendingOtpLogin = null;
            let s = done && done.data;
            if (s && s.session) s = s.session;
            if (!s || !s.user) s = await currentSession();
            if (!s || !s.user) {
                await new Promise(r => setTimeout(r, 400));
                s = await currentSession();
            }
            if (!s || !s.user) throw new Error('验证码通过但没拿到会话，请刷新页面重试');
            session = s;
            $('otp-code').value = '';
            await enterApp();
            toast('已用验证码登录');
        } catch (e) {
            const code2 = (e && (e.code || (e.error && e.error.code))) || '';
            showLogin('登录失败：' + ((e && (e.message || (e.error && e.error.message))) || e) +
                      (code2 ? '（' + code2 + '）' : ''));
        } finally {
            btn.disabled = false;
            btn.textContent = '验证码登录';
        }
    }

    function showResetForm() {
        const email = ($('login-email').value || '').trim();
        if (email) $('reset-email').value = email;
        switchAuthTab('reset');
    }

    async function doLogin(ev) {
        ev.preventDefault();
        const email = ($('login-email').value || '').trim();
        const pwd = $('login-password').value || '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('请输入正确的邮箱地址'); return; }
        if (!pwd) { showLogin('请输入密码'); return; }
        const btn = $('login-btn');
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
            const res = await cloud.auth.signInWithPassword({ email: email, password: pwd });
            if (res && res.error) throw res.error;

            // signInWithPassword 的 data 本身就是 session；不要写成 data.session
            let s = res && res.data;
            if (s && s.session) s = s.session;
            if (!s || !s.user) s = await currentSession();
            if (!s || !s.user) {
                await new Promise(r => setTimeout(r, 400));
                s = await currentSession();
            }
            if (!s || !s.user) {
                throw new Error('凭据校验通过但没拿到会话，请刷新页面再试一次');
            }
            session = s;
            $('login-password').value = '';
            await enterApp();
        } catch (e) {
            const code = (e && (e.code || (e.error && e.error.code))) || '';
            const raw = (e && (e.message || (e.error && e.error.message))) || '';
            let tip = raw || '邮箱或密码不正确';
            if (/password|credential|invalid|not\s*found|user|401/i.test(raw)) {
                tip = '邮箱或密码不正确。如果这个账号是早期用验证码注册的、从来没设置过密码，' +
                      '请点下面的「忘记密码 / 首次设置密码」设一个再登录。';
            }
            showLogin('登录失败：' + tip + (code ? '（' + code + '）' : ''));
        } finally {
            btn.disabled = false;
            btn.textContent = '登录';
        }
    }

    async function sendSignupCode() {
        const email = ($('signup-email').value || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('请输入正确的邮箱地址'); return; }
        const btn = $('send-code');
        btn.disabled = true;
        btn.textContent = '发送中…';
        try {
            const sent = await cloud.auth.sendOtp({ email: email });
            if (sent.error) throw sent.error;
            pendingSignup = {
                email: email,
                verificationId: sent.data.verificationId,
                isExistingUser: sent.data.isExistingUser
            };
            if (pendingSignup.isExistingUser) {
                // 平台规则：已存在的账号不能重复注册，引导去登录
                $('login-email').value = email;
                switchAuthTab('login');
                showLogin('这个邮箱已经注册过了。设过密码就用密码登录；没设过就点下面「忘记密码 / 首次设置密码」', true);
                btn.disabled = false;
                btn.textContent = '获取验证码';
                return;
            }
            showLogin('验证码已发送，请查收邮件（也看下垃圾箱）', true);
            let left = 60;
            const timer = setInterval(() => {
                left -= 1;
                if (left <= 0) {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.textContent = '重新发送';
                } else {
                    btn.textContent = left + 's 后重发';
                }
            }, 1000);
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '获取验证码';
            showLogin('发送失败：' + ((e && e.message) || e));
        }
    }

    async function doSignup(ev) {
        ev.preventDefault();
        const email = ($('signup-email').value || '').trim();
        const code = ($('signup-code').value || '').trim();
        const pwd = $('signup-password').value || '';
        const pwd2 = $('signup-password2').value || '';
        if (!pendingSignup || pendingSignup.email !== email) {
            showLogin('请先点「获取验证码」，收件邮箱要与上面填的一致');
            return;
        }
        if (!code) { showLogin('请输入邮箱验证码'); return; }
        if (pwd.length < 8) { showLogin('密码至少 8 位'); return; }
        if (pwd !== pwd2) { showLogin('两次输入的密码不一致'); return; }
        const btn = $('signup-btn');
        btn.disabled = true;
        btn.textContent = '注册中…';
        try {
            // 新账号必须带 password；平台不支持未验证的密码注册，所以仍要这次验证码
            const done = await cloud.auth.verifyOtp({
                email: pendingSignup.email,
                verificationId: pendingSignup.verificationId,
                isExistingUser: pendingSignup.isExistingUser,
                token: code,
                password: pwd
            });
            if (done.error) throw done.error;
            pendingSignup = null;
            $('signup-password').value = '';
            $('signup-password2').value = '';
            $('signup-code').value = '';
            $('login-email').value = email;
            session = await currentSession();
            await enterApp();
            toast('注册成功，已登录');
        } catch (e) {
            showLogin('注册失败：' + ((e && e.message) || e));
        } finally {
            btn.disabled = false;
            btn.textContent = '注册并登录';
        }
    }

    /* ---------- 忘记密码 / 首次设置密码 ---------- */
    let pendingReset = null;

    async function sendResetCode() {
        const email = ($('reset-email').value || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('请输入正确的邮箱地址'); return; }
        const btn = $('send-reset-code');
        btn.disabled = true;
        btn.textContent = '发送中…';
        try {
            const started = await cloud.auth.resetPasswordForEmail(email);
            if (started.error) throw started.error;
            pendingReset = { email: email, handle: started.data };
            showLogin('验证码已发送，请查收邮件（也看下垃圾箱）', true);
            let left = 60;
            const timer = setInterval(() => {
                left -= 1;
                if (left <= 0) {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.textContent = '重新发送';
                } else {
                    btn.textContent = left + 's 后重发';
                }
            }, 1000);
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '获取验证码';
            showLogin('发送失败：' + ((e && e.message) || e));
        }
    }

    async function doReset(ev) {
        ev.preventDefault();
        const email = ($('reset-email').value || '').trim();
        const code = ($('reset-code').value || '').trim();
        const pwd = $('reset-password').value || '';
        const pwd2 = $('reset-password2').value || '';
        if (!pendingReset || pendingReset.email !== email) {
            showLogin('请先点「获取验证码」，收件邮箱要与上面填的一致');
            return;
        }
        if (!code) { showLogin('请输入邮箱验证码'); return; }
        if (pwd.length < 8) { showLogin('密码至少 8 位'); return; }
        if (pwd !== pwd2) { showLogin('两次输入的密码不一致'); return; }
        const btn = $('reset-btn');
        btn.disabled = true;
        btn.textContent = '设置中…';
        try {
            const completed = await pendingReset.handle.updateUser({ nonce: code, password: pwd });
            if (completed.error) throw completed.error;
            pendingReset = null;
            $('reset-password').value = '';
            $('reset-password2').value = '';
            $('reset-code').value = '';
            $('login-email').value = email;

            let s = completed && completed.data;
            if (s && s.session) s = s.session;
            if (!s || !s.user) s = await currentSession();
            if (!s || !s.user) {
                await new Promise(r => setTimeout(r, 400));
                s = await currentSession();
            }

            if (!s || !s.user) {
                // 没拿到会话时，用新密码自检一次：直接确认密码到底有没有生效
                const check = await cloud.auth.signInWithPassword({ email: email, password: pwd });
                if (check && !check.error && check.data) {
                    s = check.data.session || check.data;
                } else {
                    const c2 = (check && check.error && (check.error.code || check.error.message)) || 'unknown';
                    switchAuthTab('login');
                    showLogin('密码没有生效（' + c2 + '）。请再走一次「忘记密码」，注意验证码要填最新那封邮件里的。');
                    return;
                }
            }
            if (!s || !s.user) {
                switchAuthTab('login');
                showLogin('新密码已设置，请用上面的邮箱和新密码登录', true);
                return;
            }
            session = s;
            await enterApp();
            toast('密码已设置，已登录');
        } catch (e) {
            showLogin('设置失败：' + ((e && e.message) || e));
        } finally {
            btn.disabled = false;
            btn.textContent = '设置新密码并登录';
        }
    }

    async function currentSession() {
        const res = await cloud.auth.getSession();
        if (!res) return null;
        let s = res.data;
        if (s && s.session) s = s.session;
        return (s && s.user) ? s : null;
    }

    async function enterApp() {
        if (!session || !session.user) {
            showLogin('登录状态没拿到，请刷新页面后重新登录');
            return;
        }
        showApp();
        const u = session.user || {};
        $('user-email').textContent = u.email || u.name || '已登录';

        await loadModel();
        await resumeConv();
        renderHero();
        renderStatus();
        renderDashboard();
        loadJournalHint();
    }

    function loadJournalHint() {
        $('journal-body').innerHTML = '<div class="empty">点上方按钮，按日期汇总你与 TA 的对话。</div>';
    }

    /* 切换标签页（搜索页“继续这段对话”也要用） */
    function switchTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        const panel = $('panel-' + name);
        if (panel) panel.classList.add('active');
        if (name === 'dash') renderDashboard();
        if (name === 'search') renderSearch();
        if (name === 'journal') renderJournal();
    }

    /* ============================================================
       事件绑定
       ============================================================ */
    function bindEvents() {
        // 主题
        $('theme-toggle').addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-theme');
            applyTheme(cur === 'dark' ? 'light' : 'dark');
        });

        // 登录 / 注册
        document.querySelectorAll('.auth-tab').forEach(t => {
            t.addEventListener('click', () => switchAuthTab(t.dataset.auth));
        });
        $('login-form').addEventListener('submit', doLogin);
        $('signup-form').addEventListener('submit', doSignup);
        $('send-code').addEventListener('click', sendSignupCode);
        $('forgot-link').addEventListener('click', showResetForm);
        $('back-login').addEventListener('click', () => switchAuthTab('login'));
        $('reset-form').addEventListener('submit', doReset);
        $('send-reset-code').addEventListener('click', sendResetCode);
        $('otp-login-link').addEventListener('click', () => {
            const email = ($('login-email').value || '').trim();
            if (email) $('otp-email').value = email;
            switchAuthTab('otp');
        });
        $('back-login2').addEventListener('click', () => switchAuthTab('login'));
        $('otp-form').addEventListener('submit', doOtpLogin);
        $('send-otp-login').addEventListener('click', sendOtpLoginCode);

        // 退出
        $('logout-btn').addEventListener('click', async () => {
            try { await cloud.auth.signOut(); } catch (e) { /* ignore */ }
            session = null;
            history = [];
            showLogin('已退出登录');
        });

        // Tab
        $('tabs').addEventListener('click', (e) => {
            const btn = e.target.closest('.tab');
            if (btn) switchTab(btn.dataset.tab);
        });

        // 聊天
        $('send-btn').addEventListener('click', send);
        $('msg-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });
        $('reset-chat').addEventListener('click', async () => {
            if (!conv || !conv.id) { toast('还没有对话', true); return; }
            if (!confirm('清空这一段对话的消息？（会话本身保留，记忆不会删除）')) return;
            try {
                await unwrap(db().from('xb_messages').delete().eq('session_id', conv.id).select());
            } catch (e) { console.warn(e); }
            const c = chars[conv.character_id] || currentCharacter();
            history = [];
            if (c && c.greeting) {
                history.push({ role: 'assistant', content: c.greeting, at: nowHM() });
                addMessage('assistant', c.greeting).catch(() => {});
            }
            renderChat();
            renderChatMeta();
            renderHero();
            toast('本段对话已清空');
        });
        $('gen-journal').addEventListener('click', () => {
            document.querySelector('.tab[data-tab="journal"]').click();
            generateJournal();
        });
        $('gen-journal-2').addEventListener('click', generateJournal);
        $('refresh-journal').addEventListener('click', renderJournal);
        $('journal-body').addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del-journal]');
            if (!del) return;
            if (!confirm('删除这篇日记？不可恢复。')) return;
            try {
                await unwrap(db().from('xb_journals').delete().eq('id', del.dataset.delJournal).select());
                toast('日记已删除');
                renderJournal();
            } catch (err) { toast('删除失败', true); }
        });

        // 角色
        $('gender-select').addEventListener('change', (e) => fillCharOptions(e.target.value));

        // 模型选择
        $('model-select').addEventListener('change', (e) => {
            modelId = e.target.value;
            try { localStorage.setItem('xb-model', modelId); } catch (err) { /* ignore */ }
            renderHero();
            renderStatus();
            toast('已切换模型：' + modelId);
        });
        $('switch-char').addEventListener('click', async () => {
            const wanted = $('char-select').value;
            const c = chars[wanted];
            if (!c) return;
            if (!history.some(m => m.role === 'user')) {
                await retargetConv(c);
                toast('已使用 ' + c.emoji + ' ' + c.name);
                return;
            }
            // 不弹确认框：换角色本来就是新开一段，上一段不会丢（左栏 / 搜索记忆都在）
            try {
                await createConv(wanted, true);
                toast('已和 ' + c.emoji + ' ' + c.name + ' 开启新对话，上一段在左边历史里');
            } catch (e) { toast('新建对话失败：' + ((e && e.message) || e), true); }
        });

        // 左右两栏收放（状态记在本地）
        const th = $('toggle-history');
        if (th) th.addEventListener('click', () => {
            colState.history = !colState.history;
            applyCols();
            if (colState.history) renderHistoryList().catch(() => {});
        });
        const ts = $('toggle-side');
        if (ts) ts.addEventListener('click', () => {
            colState.side = !colState.side;
            applyCols();
        });

        // 左栏：点一段接着聊 / 删掉这段
        const histList = $('hist-list');
        if (histList) histList.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del-conv]');
            if (del) {
                e.stopPropagation();
                await deleteConv(del.dataset.delConv);
                await renderHistoryList();
                return;
            }
            const item = e.target.closest('[data-conv]');
            if (!item) return;
            const id = item.dataset.conv;
            if (conv && String(conv.id) === String(id)) return;
            const okGo = await jumpToConv(id);
            if (okGo) {
                await renderHistoryList();
                // 窄屏时历史栏在聊天区下面，切完把对话滚回视野
                if (window.innerWidth <= 980) {
                    const col = document.querySelector('.chat-col');
                    if (col) col.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        });
        const histNew = $('hist-new');
        if (histNew) histNew.addEventListener('click', () => {
            const b = $('new-chat');
            if (b) b.click();
        });

        // 开启新对话：不弹确认框，点了就开（旧对话本来就在左栏和「搜索记忆」里）
        $('new-chat').addEventListener('click', async () => {
            const wanted = $('char-select').value || charId;
            const c = chars[wanted] || currentCharacter();
            if (!history.some(m => m.role === 'user')) {
                // 还没聊，直接重开当前这段，不新增空会话
                await retargetConv(c, true);
                return;
            }
            try {
                await createConv(wanted, true);
                toast('已开启新对话，上一段在左边「历史对话」里');
            } catch (e) { toast('新建对话失败：' + ((e && e.message) || e), true); }
        });

        // 仪表盘
        $('refresh-dash').addEventListener('click', renderDashboard);
        $('graph-btn').addEventListener('click', openGraph);
        $('graph-close').addEventListener('click', closeGraph);
        $('graph-add-person').addEventListener('click', () => openNewPersonForm(''));
        $('graph-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'graph-overlay') closeGraph();
        });
        $('graph-detail').addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-gact]');
            if (!btn) return;
            const act = btn.dataset.gact;
            if (act === 'add-person') { openNewPersonForm(btn.dataset.kind || ''); }
            else if (act === 'pick') { selectGraphNode(btn.dataset.id); }
            else if (act === 'edit-person') { gEdit = { mode: 'person' }; showGraphDetail(gSel); }
            else if (act === 'add-event') { gEdit = { mode: 'event', evId: null }; showGraphDetail(gSel); }
            else if (act === 'edit-event') { gEdit = { mode: 'event', evId: btn.dataset.evid }; showGraphDetail(gSel); }
            else if (act === 'cancel') { gEdit = null; showGraphDetail(gSel); }
            else if (act === 'save-person') { await savePerson(); }
            else if (act === 'save-event') { await saveEvent(); }
            else if (act === 'del-person') { await deletePerson(); }
            else if (act === 'del-event') { await deleteEvent(btn.dataset.evid); }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !$('graph-overlay').hidden) closeGraph();
        });
        $('clean-dup').addEventListener('click', async () => {
            if (!confirm('清理重复？\n\n· 同一天、说法近似的事件会合并成一条（保留更详细的描述和更高的重要度）\n'
                + '· 只出现过一次的话题会被删掉\n\n不可撤销。')) return;
            try {
                // 话题：只出现一次的清掉
                const topics = await listTopics();
                const low = topics.filter(t => (t.frequency || 1) < 2);
                for (const t of low) {
                    await unwrap(db().from('xb_topics').delete().eq('id', t.id).select());
                }

                // 事件：「熬夜刷手机到凌晨三点」和「熬夜到凌晨3点」这种只有一条该留
                const evs = await listEvents(500);
                const kept = [];
                let merged = 0;
                for (const ev of evs) {
                    const same = kept.find(k => sameThing(k, ev));
                    if (!same) { kept.push(ev); continue; }
                    const ents = (same.entities || []).concat(ev.entities || []).reduce((acc, cur) => {
                        const n = (cur && cur.name) ? cur.name : (typeof cur === 'string' ? cur : '');
                        if (n && !acc.some(x => x.name === n)) acc.push({ name: n });
                        return acc;
                    }, []);
                    const imp = Math.max(parseInt(same.importance, 10) || 0, parseInt(ev.importance, 10) || 0);
                    await unwrap(db().from('xb_events').update({
                        description: String(ev.description || '').length > String(same.description || '').length
                            ? ev.description : (same.description || ''),
                        importance: imp,
                        event_date: same.event_date || ev.event_date || null,
                        entities: ents
                    }).eq('id', same.id).select());
                    await unwrap(db().from('xb_events').delete().eq('id', ev.id).select());
                    same.importance = imp;
                    same.entities = ents;
                    merged++;
                }

                toast('合并了 ' + merged + ' 条重复事件，清理了 ' + low.length + ' 个一次性话题');
                await renderDashboard();
            } catch (e) { toast('清理失败：' + ((e && e.message) || e), true); }
        });

        $('clear-followups').addEventListener('click', async () => {
            if (!confirm('清空全部待追问？不可恢复。')) return;
            try {
                await unwrap(db().from('xb_followups').delete().neq('id', 0).select());
                toast('待追问已清空');
                renderDashboard();
            } catch (e) { toast('清空失败：' + ((e && e.message) || e), true); }
        });

        // 个人信息表单里按回车＝保存
        $('dash-body').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.id && e.target.id.indexOf('dpf-') === 0) {
                e.preventDefault();
                const btn = document.querySelector('#dash-body [data-save-profile]');
                if (btn) btn.click();
            }
        });

        // 仪表盘：编辑 / 删除（事件委托）
        $('dash-body').addEventListener('click', async (e) => {
            const q = (attr) => e.target.closest('[' + attr + ']');

            // 个人信息：新增 / 改 / 删
            if (q('data-add-profile')) {
                dashEdit = { type: 'profile', key: '' };
                renderDashboard();
                return;
            }

            const editProf = q('data-edit-profile');
            if (editProf) {
                dashEdit = { type: 'profile', key: editProf.dataset.editProfile };
                renderDashboard();
                return;
            }

            const delProf = q('data-del-profile');
            if (delProf) {
                const k = delProf.dataset.delProfile;
                try {
                    await delProfile(k);
                    dashEdit = null;
                    await renderDashboard();
                    toast('已删除 ' + k);
                } catch (err) { toast('删除失败：' + ((err && err.message) || err), true); }
                return;
            }

            const saveProf = q('data-save-profile');
            if (saveProf) {
                const oldKey = saveProf.dataset.saveProfile || '';
                const k = ($('dpf-key').value || '').trim();
                const v = ($('dpf-val').value || '').trim();
                if (!k) { toast('字段名不能为空', true); return; }
                try {
                    if (oldKey && oldKey !== k) await delProfile(oldKey);   // 改了字段名，旧的一条删掉
                    if (!v) {
                        await delProfile(k);
                        toast('已删除 ' + k);
                    } else {
                        await setProfile(k, v, k === 'phone' || k === 'address');
                        toast('已保存 ' + k + ' = ' + v);
                    }
                    dashEdit = null;
                    await renderDashboard();
                } catch (err) { toast('保存失败：' + ((err && err.message) || err), true); }
                return;
            }

            const editEv = q('data-edit-event');
            if (editEv) { dashEdit = { type: 'event', id: editEv.dataset.editEvent }; renderDashboard(); return; }

            const editEn = q('data-edit-entity');
            if (editEn) { dashEdit = { type: 'entity', id: editEn.dataset.editEntity }; renderDashboard(); return; }

            const editFu = q('data-edit-followup');
            if (editFu) { dashEdit = { type: 'followup', id: editFu.dataset.editFollowup }; renderDashboard(); return; }

            const gotoP = q('data-goto-person');
            if (gotoP) { openGraphNamed(gotoP.dataset.gotoPerson); return; }

            if (q('data-dash-cancel')) { dashEdit = null; renderDashboard(); return; }

            const saveEv = q('data-save-event');
            if (saveEv) {
                const title = ($('de-title').value || '').trim();
                if (!title) { toast('标题不能为空', true); return; }
                try {
                    await unwrap(db().from('xb_events').update({
                        title: title,
                        event_date: ($('de-date').value || '').trim() || null,
                        importance: Math.max(1, Math.min(10, parseInt($('de-imp').value, 10) || 5)),
                        emotion: $('de-emo').value || 'neutral',
                        description: ($('de-desc').value || '').trim()
                    }).eq('id', saveEv.dataset.saveEvent).select());
                    dashEdit = null;
                    toast('事件已更新');
                    await renderDashboard();
                } catch (err) { toast('保存失败：' + ((err && err.message) || err), true); }
                return;
            }

            const saveEn = q('data-save-entity');
            if (saveEn) {
                const id = saveEn.dataset.saveEntity;
                const name = ($('dp-name').value || '').trim();
                if (!name) { toast('名字不能为空', true); return; }
                const before = dashData.entities.find(x => String(x.id) === String(id)) || {};
                try {
                    const p = personPatchFromDom('dp');
                    await unwrap(db().from('xb_entities').update({
                        name: name,
                        relation: ($('dp-relation').value || '').trim(),
                        category: $('dp-category').value || '',
                        traits: p.traits,
                        birthday: p.birthday,
                        age_seen: p.age_seen,
                        age_seen_on: p.age_seen_on
                    }).eq('id', id).select());
                    if (before.name && before.name !== name) await renameInEvents(before.name, name);
                    dashEdit = null;
                    toast('已保存');
                    await renderDashboard();
                } catch (err) { toast('保存失败：' + ((err && err.message) || err), true); }
                return;
            }

            const saveFu = q('data-save-followup');
            if (saveFu) {
                const desc = ($('df-desc').value || '').trim();
                if (!desc) { toast('内容不能为空', true); return; }
                const who = ($('df-who').value || '').split(/[,，、\s]+/).filter(Boolean).map(n => ({ name: n }));
                try {
                    await unwrap(db().from('xb_followups').update({
                        description: desc,
                        due_date: ($('df-date').value || '').trim() || null,
                        entities: who
                    }).eq('id', saveFu.dataset.saveFollowup).select());
                    dashEdit = null;
                    toast('待追问已更新');
                    await renderDashboard();
                } catch (err) { toast('保存失败：' + ((err && err.message) || err), true); }
                return;
            }

            const delEv = q('data-del-event');
            if (delEv) {
                if (!confirm('删除这条事件？不可恢复。')) return;
                try {
                    await unwrap(db().from('xb_events').delete().eq('id', delEv.dataset.delEvent).select());
                    await renderDashboard();
                    toast('事件已删除');
                } catch (err) { toast('删除失败', true); }
                return;
            }

            // 日常记录 → 核心事件（手动抬一手）
            const promote = q('data-promote-event');
            if (promote) {
                try {
                    await unwrap(db().from('xb_events')
                        .update({ importance: CORE_IMP }).eq('id', promote.dataset.promoteEvent).select());
                    await renderDashboard();
                    toast('已标为核心事件');
                } catch (err) { toast('操作失败：' + ((err && err.message) || err), true); }
                return;
            }

            if (q('data-toggle-daily')) {
                dailyOpen = !dailyOpen;
                await renderDashboard();
                return;
            }

            const delEn = q('data-del-entity');
            if (delEn) {
                const ent = dashData.entities.find(x => String(x.id) === String(delEn.dataset.delEntity));
                if (!ent) return;
                if (await deletePersonCascade(ent.name, ent.id)) {
                    dashEdit = null;
                    await renderDashboard();
                }
                return;
            }

            const delFu = q('data-del-followup');
            if (delFu) {
                try {
                    await unwrap(db().from('xb_followups').delete().eq('id', delFu.dataset.delFollowup).select());
                    await renderDashboard();
                    toast('已删除');
                } catch (err) { toast('删除失败', true); }
                return;
            }

            const delEmo = q('data-del-emotion');
            if (delEmo) {
                try {
                    await unwrap(db().from('xb_emotions').delete().eq('id', delEmo.dataset.delEmotion).select());
                    await renderDashboard();
                    toast('情绪记录已删除');
                } catch (err) { toast('删除失败', true); }
                return;
            }

            const delTopic = q('data-del-topic');
            if (delTopic) {
                try {
                    await unwrap(db().from('xb_topics').delete().eq('id', delTopic.dataset.delTopic).select());
                    await renderDashboard();
                    toast('话题已删除');
                } catch (err) { toast('删除失败', true); }
            }
        });

        // 搜索：按天列表
        $('search-btn').addEventListener('click', renderSearch);
        $('search-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); renderSearch(); }
        });
        $('clear-msgs').addEventListener('click', clearAllMessages);
        $('search-result').addEventListener('click', async (e) => {
            const resume = e.target.closest('[data-resume-conv]');
            if (resume) {
                e.stopPropagation();
                const okGo = await jumpToConv(resume.dataset.resumeConv);
                if (okGo) switchTab('chat');
                return;
            }
            const delConv = e.target.closest('[data-del-conv]');
            if (delConv) {
                e.stopPropagation();
                await deleteConv(delConv.dataset.delConv);
                return;
            }
            const delMsg = e.target.closest('[data-del-msg]');
            if (delMsg) {
                e.stopPropagation();
                if (!confirm('删除这条对话？不可恢复。')) return;
                try {
                    await unwrap(db().from('xb_messages').delete().eq('id', delMsg.dataset.delMsg).select());
                    toast('对话已删除');
                    await syncHistory();
                    await renderSearch();
                } catch (err) { toast('删除失败：' + ((err && err.message) || err), true); }
                return;
            }
            const head = e.target.closest('.day-head');
            if (head) {
                const item = head.parentElement;
                const body = item.querySelector('.day-body');
                const open = !body.hidden;
                body.hidden = open;
                item.classList.toggle('open', !open);
                const row = convRows[parseInt(item.dataset.idx, 10)];
                if (row) {
                    if (open) openConvs.delete(row.conv.id);
                    else openConvs.add(row.conv.id);
                }
                if (!open) {
                    // 展开时直接定位到命中的那一句
                    const mark = body.querySelector('mark');
                    if (mark) {
                        const br = body.getBoundingClientRect();
                        const mr = mark.getBoundingClientRect();
                        body.scrollTop += (mr.top - br.top) - body.clientHeight / 2;
                        mark.classList.add('flash');
                        setTimeout(() => mark.classList.remove('flash'), 1600);
                    }
                }
            }
        });
    }

    /* ============================================================
       启动
       ============================================================ */
    async function boot() {
        let theme = 'dark';
        try { theme = localStorage.getItem('xb-theme') || 'dark'; } catch (e) { /* ignore */ }
        applyTheme(theme);
        loadCols();
        bindEvents();

        if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
            showLogin('云 SDK 加载失败，请检查网络后刷新页面');
            return;
        }

        cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
            endpoint: CFG.endpoint,
            oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
            publishableKey: CFG.publishableKey
        });

        try {
            const res = await fetch('characters.json');
            chars = await res.json();
        } catch (e) {
            console.error('[小伴] 角色数据加载失败', e);
        }
        fillCharOptions('male');
        const first = Object.keys(chars).find(id => chars[id].gender === 'male');
        if (first) { charId = first; $('char-select').value = first; }

        session = await currentSession();
        if (session) {
            await enterApp();
        } else {
            showLogin('');
        }

        // 登录态变化
        if (cloud.auth.onAuthStateChange) {
            cloud.auth.onAuthStateChange((event, s) => {
                if (event === 'SIGNED_OUT') { session = null; showLogin('已退出登录'); }
                else if (s) { session = s; }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', boot);
})();
