/**
 * 跨会话意识层：让「一个主体同时参与多个会话」成为模型能看见的事实。
 *
 * ── 要解决的具体现象 ──────────────────────────────────────────────────────
 * 桥接的会话模型是「一个 QQ 群 / 一个私聊 = 一个独立 DSH 会话」（state/sessions.json）。
 * 这对隔离很友好，但和真人相反：真人在群里说完话，回私聊还记得自己刚说了什么，
 * 也认得「群里那个皮蛋」就是「私聊里的皮蛋」。桥接里这三件事以前全都做不到：
 *   1. 在私聊里被问「你刚才在群里说什么来着」→ 只能编，或者装傻；
 *   2. 同一个 QQ 号在群里叫「皮蛋」、私聊昵称是「蛋总」→ 被当成两个人；
 *   3. 唯一能跨会话看东西的是管理员私聊（crossReadHintV2 的跨会话只读），
 *      其它会话之间是彻底的黑箱。
 *
 * 这里补的是**意识**，不是**权限**：只把「别处发生了什么」压成一小段文字塞进唤醒提示，
 * 不改任何白名单/令牌/工具面。模型仍然只能在自己被唤醒的那个会话里说话，
 * 想往别的会话发消息还是走原来的口子（管理员私聊的跨会话代发）。
 *
 * ── 为什么是环缓冲 + 反向索引，而不是查归档 ────────────────────────────────
 * 唤醒是热路径（每个群几分钟一次）。每次唤醒去 readArchive 重扫磁盘，几万条归档会
 * 把提示词组装变成主要耗时；而这里真正需要的只是「最近两小时、别的会话说了什么」。
 * 所以：归档写入时顺手 push 进内存环（appendArchive 的返回值天然去过重），
 * 启动时从归档尾部播种一次，之后全是内存操作。进程重启丢掉的也只是内存态，
 * 播种会从归档里补回来。
 *
 * ── 本文件不碰 fs / 网络 / 配置读取 ───────────────────────────────────────
 * 与 src/core/session-router.mjs 同一个口径：纯逻辑，输入是记录数组，输出是一段文本。
 * 播种由 bridge.js 负责（它才有 STATE_DIR），这样 scripts/test-cross-talk.mjs 可以
 * 直接构造记录断言行为，不需要起桥接。
 */

import { describeAge } from './qq-model-view.js';

/** 配置默认值。数字都会被 normalizeCrossTalkConfig 夹到合理区间。 */
export const CROSS_TALK_DEFAULTS = Object.freeze({
  // 总开关。关掉后唤醒提示里不会出现【跨会话】段（模型退回「各会话互不相识」）。
  enabled: true,
  // 回看多久以内的别处动态。太长会把昨天的事当好今天的谈资，太短又接不上话。
  lookbackMs: 2 * 60 * 60 * 1000,
  // 「你自己在别处说过的话」最多几条。
  selfLimit: 5,
  // 「这个人也是别处那个人」最多写几个人（只写当前会话最近出现的人）。
  personLimit: 4,
  // 别处会话的近期动静：最多几个会话、每个会话最多几条。
  ambientKeys: 3,
  ambientPerKey: 2,
  // 会话名单最多列几个（让她知道自己同时在跟谁说话）。
  rosterLimit: 8,
  // 整段文字的字符上限。这是提示词预算，不是安全边界。
  maxChars: 1200,
  // 这些会话的内容**不进别人的提示词**（例如想彻底屏蔽管理员私聊外泄时填 private:<ownerQQ>）。
  hideKeysFromOthers: [],
  // 群聊里能不能看见私聊内容。默认 false：群是公开场合，把私聊搬到群里是最刺眼的那种翻车。
  // 私聊里看群聊不受这条限制（那正是「你刚才在群里说」要用的方向）。
  privateVisibleInGroups: false
});

const KEY_RE = /^(group|private):(\d+)$/;
const SELF_LABEL = '我';

/** key 规范化：非法 key 返回 null（绝不臆造会话）。 */
export function canonicalKey(key) {
  const m = KEY_RE.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 私聊消息在归档里没有名字（桥接按设计把私聊发送者写成「私聊」，见 bridge.js 的 sender 赋值）。 */
const GENERIC_NAMES = new Set(['私聊', '未知', '匿名', '群聊', '']);

function isGenericName(name) {
  return GENERIC_NAMES.has(String(name ?? '').trim());
}

/**
 * 配置归一化：只认显式合理值，其余落回默认。
 *
 * 这里**必须**逐项合并而不是 `{...默认, ...文件}` 就完事吗？不 —— 这里就是那个合并本身，
 * 调用方（bridge.js）已经有外层 spread 的坑（见 socialV2.tools / sticker.collect 的注释），
 * 所以这一层要能独立扛住「文件里只写了一个字段」的情况。
 *
 * @param {object} raw  config.json 里的 socialV2.crossTalk
 * @param {{ownerQQ?: number|string}} [ctx] 传入 ownerQQ 时会把管理员私聊默认屏蔽在别人之外
 */
export function normalizeCrossTalkConfig(raw, { ownerQQ = null } = {}) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const hide = [];
  const addHide = (item) => {
    const key = canonicalKey(item);
    if (key && !hide.includes(key)) hide.push(key);
  };
  for (const item of Array.isArray(src.hideKeysFromOthers) ? src.hideKeysFromOthers : []) addHide(item);
  // 管理员私聊默认对其它会话隐形。
  //
  // 为什么这不是「过度保护」：管理员私聊里出现的是操作者本人的原话（"你就照我说的回她"
  // 这类），一旦被复述到某个好友的私聊里，损害不可撤销；而反向需求（好友私聊的内容
  // 让管理员看到）本来就有显式的跨会话只读通路，不依赖这一段。
  // 想对称互通就设 hideOwnerPrivate: false。
  if (src.hideOwnerPrivate !== false) {
    const ownerKey = canonicalKey(`private:${String(ownerQQ ?? '').trim()}`);
    if (ownerKey) addHide(ownerKey);
  }
  return {
    enabled: src.enabled !== false,
    lookbackMs: clampInt(src.lookbackMs, CROSS_TALK_DEFAULTS.lookbackMs, 60_000, 24 * 60 * 60 * 1000),
    selfLimit: clampInt(src.selfLimit, CROSS_TALK_DEFAULTS.selfLimit, 0, 20),
    personLimit: clampInt(src.personLimit, CROSS_TALK_DEFAULTS.personLimit, 0, 12),
    ambientKeys: clampInt(src.ambientKeys, CROSS_TALK_DEFAULTS.ambientKeys, 0, 8),
    ambientPerKey: clampInt(src.ambientPerKey, CROSS_TALK_DEFAULTS.ambientPerKey, 0, 6),
    rosterLimit: clampInt(src.rosterLimit, CROSS_TALK_DEFAULTS.rosterLimit, 0, 20),
    // 下限 400：规则段本身就占三百来字，再小就连一条正文都塞不进来，
    // 那不如整段不出现（digest 在装不下任何正文时返回空串），而不是留一个只有规则的壳。
    maxChars: clampInt(src.maxChars, CROSS_TALK_DEFAULTS.maxChars, 400, 4000),
    hideKeysFromOthers: hide,
    hideOwnerPrivate: src.hideOwnerPrivate !== false,
    privateVisibleInGroups: src.privateVisibleInGroups === true
  };
}

/** 一句聊天记录压成一行（正文可能带换行，注入快照里换行会把一条消息撑成三段）。 */
function oneLine(text, max = 60) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

function isRecord(rec) {
  return !!rec && typeof rec === 'object' && typeof rec.m === 'string' && rec.m.trim();
}

/**
 * 跨会话存储。
 *
 * 三份索引各有各的用途，缺一个都要退化成全表扫描：
 *   · #perKey  —— 「别处各会话最近在说什么」；
 *   · #global  —— 「我不在这个会话时，别处都发生了什么」（按时间取最近）；
 *   · #users   —— 「这个 QQ 号在哪些会话里出现过、分别叫什么」= 身份同一性。
 */
export class CrossTalkStore {
  #perKey = new Map();          // key -> rec[]（时间正序，尾部最新）
  #global = [];                 // { key, rec }（时间正序）
  #users = new Map();           // uid -> { names: Map<name,{count,lastAt}>, keys: Map<key,{count,lastAt}>, lastAt, lastRec }
  #perKeyLimit;
  #globalLimit;
  #log;

  constructor({ log = null, perKeyLimit = 60, globalLimit = 400 } = {}) {
    this.#log = log;
    this.#perKeyLimit = Math.max(10, Math.min(500, Math.round(Number(perKeyLimit) || 60)));
    this.#globalLimit = Math.max(50, Math.min(5000, Math.round(Number(globalLimit) || 400)));
  }

  /** 会话列表，按最后活跃时间倒序（控制台/名单用）。 */
  keys() {
    return [...this.#perKey.entries()]
      .map(([key, list]) => ({ key, lastAt: Number(list[list.length - 1]?.t) || 0, count: list.length }))
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((item) => item.key);
  }

  /** 某个会话最近的记录（时间正序）。返回的是内部数组的浅拷贝，调用方不要改。 */
  recent(key, limit = 10) {
    const canonical = canonicalKey(key);
    if (!canonical) return [];
    const list = this.#perKey.get(canonical) ?? [];
    const n = Math.max(0, Math.round(Number(limit) || 0));
    return n ? list.slice(-n) : [];
  }

  /** 某个 QQ 号跨会话的身份：名字、出现的会话、最近一条。没有就 null。 */
  userInfo(userId) {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    const info = this.#users.get(uid);
    if (!info) return null;
    return {
      userId: uid,
      names: [...info.names.entries()]
        .map(([name, v]) => ({ name, count: v.count, lastAt: v.lastAt }))
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
      keys: [...info.keys.entries()]
        .map(([key, v]) => ({ key, count: v.count, lastAt: v.lastAt }))
        .sort((a, b) => b.lastAt - a.lastAt),
      lastAt: info.lastAt,
      lastRec: info.lastRec ?? null
    };
  }

  /** 统计（启动日志用：没有这行，「联通没生效」和「确实没人说话」在日志里长得一样）。 */
  stats() {
    return {
      keys: this.#perKey.size,
      records: this.#global.length,
      users: this.#users.size
    };
  }

  reset() {
    this.#perKey.clear();
    this.#global.length = 0;
    this.#users.clear();
  }

  /**
   * 喂入一批记录（归档格式：`{t,n,u,m,s}`）。
   *
   * 挂在 archiveMessagesV2 上而不是另开定时器：归档是**唯一**的汇合点，
   * 入站与出站消息都会经过它；定时扫 recentMessages 会漏掉被挤出去的中间消息。
   *
   * 去重只做「同 key 尾部 12 条」的粗查：归档本身已经去过重，这里防的是
   * 「启动播种 + 紧接着的热路径重复喂同一批」这种重叠。全量 Set 会随进程寿命无限长。
   */
  ingest(key, records) {
    const canonical = canonicalKey(key);
    if (!canonical) return 0;
    const list = Array.isArray(records) ? records : [records];
    let accepted = 0;
    for (const rec of list) {
      if (!isRecord(rec)) continue;
      const t = Number(rec.t);
      if (!Number.isFinite(t) || t <= 0) continue;
      const item = {
        t,
        n: String(rec.n ?? '').slice(0, 40) || '未知',
        u: rec.u != null ? String(rec.u) : null,
        m: String(rec.m).slice(0, 200),
        s: Number(rec.s) === 1 ? 1 : 0
      };
      if (this.#isDuplicate(canonical, item)) continue;
      let bucket = this.#perKey.get(canonical);
      if (!bucket) { bucket = []; this.#perKey.set(canonical, bucket); }
      bucket.push(item);
      if (bucket.length > this.#perKeyLimit) bucket.splice(0, bucket.length - this.#perKeyLimit);
      this.#global.push({ key: canonical, rec: item });
      if (this.#global.length > this.#globalLimit) this.#global.splice(0, this.#global.length - this.#globalLimit);
      this.#indexUser(canonical, item);
      accepted += 1;
    }
    // 记录是乱序喂进来时（播种按文件顺序，一般正序）保持有序，后面的「最近 N 条」才可信。
    const bucket = this.#perKey.get(canonical);
    if (bucket && bucket.length > 1) {
      let sorted = true;
      for (let i = 1; i < bucket.length; i += 1) {
        if (bucket[i].t < bucket[i - 1].t) { sorted = false; break; }
      }
      if (!sorted) bucket.sort((a, b) => a.t - b.t);
    }
    return accepted;
  }

  #isDuplicate(key, item) {
    const bucket = this.#perKey.get(key);
    if (!bucket || !bucket.length) return false;
    for (let i = Math.max(0, bucket.length - 12); i < bucket.length; i += 1) {
      if (bucket[i].t === item.t && bucket[i].m === item.m) return true;
    }
    return false;
  }

  #indexUser(key, item) {
    // 自己说的话没有「身份」可言（u 通常为空）；即便有也不进反向索引，
    // 否则「你」会被当成一个群友，身份段里出现「我（QQ xxx）也在群里」这种鬼话。
    if (item.s === 1) return;
    const uid = item.u;
    if (!uid) return;
    let info = this.#users.get(uid);
    if (!info) {
      info = { names: new Map(), keys: new Map(), lastAt: 0, lastRec: null };
      this.#users.set(uid, info);
    }
    // 「私聊」不是名字，是桥接给私聊消息的占位标签（见 GENERIC_NAMES）。把它当一个名字
    // 记下来会得到「你见过的名字：私聊」这种废话，还会让身份段以为"这人有两个名字"。
    if (!isGenericName(item.n)) {
      const nameKey = item.n || '未知';
      const nameEntry = info.names.get(nameKey) ?? { count: 0, lastAt: 0 };
      nameEntry.count += 1;
      if (item.t >= nameEntry.lastAt) nameEntry.lastAt = item.t;
      info.names.set(nameKey, nameEntry);
    }
    const keyEntry = info.keys.get(key) ?? { count: 0, lastAt: 0 };
    keyEntry.count += 1;
    if (item.t >= keyEntry.lastAt) keyEntry.lastAt = item.t;
    info.keys.set(key, keyEntry);
    if (item.t >= info.lastAt) {
      info.lastAt = item.t;
      info.lastRec = { key, t: item.t, m: item.m, n: item.n };
    }
  }

  /**
   * 生成唤醒提示里的一段【跨会话】。
   *
   * @param {object} args
   * @param {string} args.key        当前被唤醒的会话
   * @param {object} args.cfg        normalizeCrossTalkConfig 的产物
   * @param {object[]} [args.messages] 当前会话最近的消息（用来判断「谁是同一个人」）
   * @param {number} [args.now]
   * @param {(key:string)=>string} [args.labelFor] 会话展示名（bridge 可注入真群名）
   * @returns {string} 没有可写内容时返回空串（绝不返回一个只有标题的空段）
   */
  digest({ key, cfg, messages = [], now = Date.now(), labelFor = null } = {}) {
    const conf = cfg && typeof cfg === 'object' ? cfg : CROSS_TALK_DEFAULTS;
    if (conf.enabled === false) return '';
    const current = canonicalKey(key);
    if (!current) return '';
    const isCurrentGroup = current.startsWith('group:');
    const hidden = new Set(Array.isArray(conf.hideKeysFromOthers) ? conf.hideKeysFromOthers : []);
    const since = now - Math.max(60_000, Number(conf.lookbackMs) || CROSS_TALK_DEFAULTS.lookbackMs);
    const label = (k) => {
      if (typeof labelFor === 'function') {
        try {
          const value = labelFor(k);
          if (value) return String(value);
        } catch { /* 展示名失败不该拖垮整段提示词 */ }
      }
      return this.#defaultLabel(k);
    };
    // 隐私边界：群聊里默认不出现私聊内容（私聊里看群聊是允许的，那正是「你刚才在群里说」）。
    // 隐私边界分两条**不同**的线，别混成一条：
    //   · 内容（说了什么）：群聊里默认看不到私聊内容 —— 把私聊搬到群里是最刺眼的翻车。
    //   · 身份（谁是谁）：群里仍然知道「这个人和我私聊过」，否则「群里的皮蛋 = 私聊那个人」
    //     这个要求就只在私聊里成立。知道「有这么一条私聊」不等于知道里面说了什么。
    const contentVisible = (k) => {
      if (k === current) return false;
      if (hidden.has(k)) return false;
      if (isCurrentGroup && k.startsWith('private:') && conf.privateVisibleInGroups !== true) return false;
      return true;
    };
    const identityVisible = (k) => k !== current && !hidden.has(k);
    const active = this.#perKey.size
      ? [...this.#perKey.entries()]
        .filter(([k, list]) => contentVisible(k) && list.length && (Number(list[list.length - 1].t) || 0) >= since)
        .map(([k, list]) => ({ key: k, list, lastAt: Number(list[list.length - 1].t) || 0 }))
        .sort((a, b) => b.lastAt - a.lastAt)
      : [];
    const rosterKeys = this.keys().filter((k) => k === current || identityVisible(k)).slice(0, Math.max(0, Number(conf.rosterLimit) || 0));

    const sections = [];

    // ① 你自己在别处说过的话。这条最关键：被问「你刚才在群里说什么」时唯一的事实来源。
    const selfLimit = Math.max(0, Number(conf.selfLimit) || 0);
    if (selfLimit) {
      const mine = [];
      for (const entry of active) {
        for (const rec of entry.list) {
          if (rec.s !== 1) continue;
          if (rec.t < since) continue;
          mine.push({ rec, key: entry.key });
        }
      }
      mine.sort((a, b) => b.rec.t - a.rec.t);
      const lines = mine.slice(0, selfLimit)
        .map(({ rec, key: k }) => `· ${describeAge(rec.t, now)}前 你在${label(k)}里说：「${oneLine(rec.m, 60)}」`);
      if (lines.length) sections.push(['你在别处说过的话', lines]);
    }

    // ② 身份同一性：当前会话最近出现的人，在别的会话里是谁。
    const personLimit = Math.max(0, Number(conf.personLimit) || 0);
    if (personLimit && this.#users.size) {
      const seen = new Map(); // uid -> 最后一次出现时间
      for (const msg of Array.isArray(messages) ? messages : []) {
        if (!msg || msg.isSelf) continue;
        const uid = msg.userId != null ? String(msg.userId) : '';
        if (!uid) continue;
        const at = Number(msg.time) || 0;
        if (!seen.has(uid) || at > seen.get(uid)) seen.set(uid, at);
      }
      const lines = [];
      const ordered = [...seen.entries()].sort((a, b) => b[1] - a[1]);
      for (const [uid, at] of ordered) {
        if (lines.length >= personLimit) break;
        const info = this.userInfo(uid);
        if (!info) continue;
        const here = info.names[0] ?? null;
        // 身份用 identityVisible，内容用 contentVisible：群里可以说「这人也在私聊里找过我」，
        // 但不可以说私聊里聊了什么。
        const otherKeys = info.keys.filter((entry) => identityVisible(entry.key));
        const nameList = info.names.slice(0, 3).map((n) => `「${n.name}」`).join('/');
        // 名字全是从占位标签里过滤剩下的（私聊里只有「私聊」）时，names 会是空的：
        // 这时只能报 QQ 号，别硬编一个名字。
        if (!otherKeys.length && info.names.length <= 1) continue; // 只在本会话出现过、且只有一个名字：没有信息量
        const who = `（QQ ${uid}${nameList ? `；你见过的名字：${nameList}` : ''}）`;
        const bits = [`「${here ? here.name : uid}」${who}`];
        if (otherKeys.length) {
          const where = otherKeys
            .slice(0, 3)
            .map((entry) => `${label(entry.key)}（${describeAge(entry.lastAt, now)}前）`)
            .join('、');
          bits.push(`TA 也在${where}跟你说话`);
          if (info.lastRec && info.lastRec.key !== current && contentVisible(info.lastRec.key)) {
            bits.push(`最近一次在那边说：「${oneLine(info.lastRec.m, 50)}」`);
          }
        } else if (nameList) {
          bits.push(`目前只在别处（${nameList}）用过这个名字`);
        }
        if (at && describeAge(at, now)) bits.push(`本会话最近一条是${describeAge(at, now)}前`);
        lines.push(`· ${bits.join('，')}`);
      }
      if (lines.length) sections.push(['同一个人换了名字也别当成两个人', lines]);
    }

    // ③ 别处最近的动静（只放别人的话；自己说的已经在 ① 里了）。
    const ambientKeys = Math.max(0, Number(conf.ambientKeys) || 0);
    const ambientPerKey = Math.max(0, Number(conf.ambientPerKey) || 0);
    if (ambientKeys && ambientPerKey) {
      const lines = [];
      for (const entry of active) {
        if (lines.length >= ambientKeys) break;
        const recent = entry.list.filter((rec) => rec.s !== 1 && rec.t >= since).slice(-ambientPerKey);
        if (!recent.length) continue;
        // 私聊消息的发送者名是占位标签「私聊」，直接用会写成「私聊：在吗」。
        // 这里换成那个私聊里的人的名字（例如「蛋总：在吗」）；拿不到名字就退回 QQ 号。
        const body = recent
          .map((rec) => `${this.#displayName(rec.n, entry.key)}：${oneLine(rec.m, 50)}`)
          .join('；');
        lines.push(`· ${label(entry.key)}（${describeAge(entry.lastAt, now)}前，${recent.length} 条）：${body}`);
      }
      if (lines.length) sections.push(['别处最近在聊', lines]);
    }

    if (!sections.length) return '';

    const roster = rosterKeys.length
      ? `你现在在 ${rosterKeys.length} 个会话里：${rosterKeys.map((k) => (k === current ? `${label(k)}（这里）` : label(k))).join('、')}。`
      : '';
    const header = '【跨会话：你同时在这些会话里说话，下面是你自己知道的事】';
    const rules = [
      '· 这些是你自己在别处说过的话、以及别人在别处说的话；不是幻觉，也不用说「我看不到别的群」。被问「你刚才在群里说什么」就照这里答。',
      '· QQ 号相同就是同一个人：群里叫「皮蛋」、私聊叫「蛋总」，是同一个 TA，别当成两个人。',
      '· 这是旁路背景，不是当前对话：别硬把别处的话题扯进来，也别把这里的原话复述给另一个会话里的人。',
      '· 管理员私聊里的事更不要往群里搬（知道就行，不当传话筒）。'
    ].join('\n');

    // 预算：header + roster + rules 先占位，剩下的按 ①→②→③ 的顺序给正文（越靠前越重要）。
    const fixed = [header, roster, rules].filter(Boolean).join('\n').length + 2;
    const maxChars = Math.max(400, Number(conf.maxChars) || CROSS_TALK_DEFAULTS.maxChars);
    let budget = maxChars - fixed;
    const body = [];
    for (const [title, lines] of sections) {
      if (budget <= 0) break;
      const block = [`${title}：`, ...lines];
      const blockLen = block.join('\n').length + 1;
      if (blockLen > budget) {
        // 预算不够就按行裁，宁可少写一条也不要把句子截断成半句。
        const kept = [];
        let used = block[0].length + 1;
        for (const line of lines) {
          if (used + line.length + 1 > budget) break;
          kept.push(line);
          used += line.length + 1;
        }
        if (kept.length) body.push([block[0], ...kept].join('\n'));
        break;
      }
      body.push(block.join('\n'));
      budget -= blockLen;
    }
    if (!body.length) return '';
    return [header, roster, body.join('\n'), rules].filter(Boolean).join('\n');
  }

  /**
   * 一条记录的展示名。
   *
   * 为什么要单独一层：私聊路径上桥接给所有入站消息的 sender 都是占位标签「私聊」
   * （群聊才有群名片/昵称，见 bridge.js 里的 `sender` 赋值）。直接渲染就成了
   * 「私聊：在吗」，读提示词的模型根本不知道是谁在说。这里用「同一 QQ 号在别处用过的
   * 真名字」回填，取不到就退回 QQ 号。
   */
  #displayName(name, key) {
    const raw = String(name ?? '').trim();
    if (!isGenericName(raw)) return raw || '某人';
    const m = KEY_RE.exec(String(key ?? ''));
    const uid = m?.[1] === 'private' ? m[2] : '';
    if (!uid) return raw || '某人';
    const info = this.#users.get(uid);
    const best = info?.names?.size
      ? [...info.names.entries()].sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)[0][0]
      : '';
    return best || `QQ ${uid}`;
  }

  #defaultLabel(key) {
    const m = KEY_RE.exec(String(key ?? ''));
    if (!m) return String(key ?? '');
    if (m[1] === 'private') {
      const info = this.userInfo(m[2]);
      const name = info?.names?.[0]?.name;
      return name ? `和「${name}」的私聊` : `和 QQ ${m[2]} 的私聊`;
    }
    return `「群${m[2]}」`;
  }
}
