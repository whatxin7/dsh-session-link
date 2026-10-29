// 群聊消息归档：把每条流入/流出的 QQ 消息 append 成 JSONL，供长期检索（RAG）使用。
//
// 为什么单独归档，而不是复用 state/social-v2.json 的 recentMessages：
//   · recentMessages 是**有界环形缓冲**（默认 100 条）。它是「眼前的草稿纸」，
//     超出的部分在设计上就是要丢的 —— 想靠它做长期记忆，等于指望草稿纸不擦。
//   · 两者生命周期不同：social-v2.json 会被 /api/socialV2/reset 与 /api/session/reset
//     整体删除，而归档是「这个群说过什么」的账本，重置一次上下文不该把它一起清掉。
//   · 归档是 append-only 纯文本：出问题能直接 grep / tail，不需要额外工具，
//     也不像二进制索引那样「一坏就全丢」。
//
// 为什么不上 SQLite：见 index.mjs 顶部（检索只有一次/唤醒，线性扫描足够，
// 而 node:sqlite 在 engines 允许的 node 22 上还要 --experimental-sqlite）。

import fs from 'node:fs';
import path from 'node:path';

/** 归档文件名的安全化：key 形如 `group:123456789` / `private:987654321`。 */
export function archiveFileFor(stateDir, key) {
  const safe = String(key ?? '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!safe) return null;
  return path.join(stateDir, 'archive', `${safe}.jsonl`);
}

/**
 * 这条正文该不该进归档。
 *
 * `[拍一拍]` 一律不进：它是桥接合成的复述（「X 戳了戳你」），不含任何内容，
 * 却因为带着人名而在检索里稳定命中 —— 一个群里拍一拍能占消息总量的两成，
 * 全进归档的后果是【往事】段被「温德馨 戳了戳你」刷满（实测第一版就是这样）。
 * 拍一拍该由 live 消息流去表达社交信号，而不是长期记忆。
 */
function isNoiseBody(body) {
  if (/^\[拍一拍\]/.test(body)) return true;
  if (/^⏳ 当前任务运行中/.test(body)) return true;
  // 纯媒体占位符没有可检索的正文（`[表情:给你糖吃]` 这种带摘要的要保留）。
  if (/^\[(图片|表情|动画表情|语音|视频|文件)\]\s*$/.test(body)) return true;
  // 控制台回显的命令（`tts` / `sing` …）：它们会以「我: sing」的形式混进 recentMessages，
  // 但那是操作指令不是话，搜出来只会污染【往事】。
  if (/^(tts|sing|voice|status|ping|help|reset|poke|chime|sticker)\s*$/i.test(body)) return true;
  return false;
}

/**
 * 把一条消息压成归档记录。
 *
 * 接受两种输入：
 *   1. **桥接内部消息**（recentMessages 里的对象）：`{text, plain, sender, isSelf, time, ...}`
 *   2. **已经是归档格式的记录**（回填脚本从 DSH 会话记录里还原出来的）：`{t, n, u, m, s}`
 *
 * 第 2 种必须能原样通过：回填脚本和桥接热路径共用 appendArchive 的去重与写盘，
 * 如果这里只认第 1 种，回填会**静默地一条都写不进去**（body 取不到 → 返回 null →
 * 计入 skipped），而 skipped 在日志里看起来跟「本来就有」一模一样。
 *
 * 字段名刻意用单字符：这个文件只增不减，体积是长期成本。
 * 但**只压字段名、不压内容** —— 消息原文必须完整保留，否则检索出来的句子是断的。
 *
 * @returns {object|null} 无法归档（没有正文/是噪音）时返回 null
 */
export function toArchiveRecord(key, msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.m === 'string' && msg.m.trim() && Number.isFinite(Number(msg.t))) {
    const body = String(msg.m).trim();
    if (isNoiseBody(body)) return null;
    const rec = {
      t: Number(msg.t),
      n: String(msg.n ?? '未知').slice(0, 40) || '未知',
      u: msg.u != null ? String(msg.u) : null,
      m: body.slice(0, 500),
      s: Number(msg.s) === 1 ? 1 : 0,
    };
    if (msg.id != null) rec.id = String(msg.id);
    if (msg.q) rec.q = 1;
    if (msg.k) rec.k = String(msg.k);
    if (msg.hm) rec.hm = 1;
    return rec;
  }
  const body = String(msg.plain ?? msg.text ?? '').trim();
  if (!body) return null;
  if (isNoiseBody(body)) return null;
  const rec = {
    // 语音那条路径（recordVoiceSentV2）用的是 `at` 而不是 `time`。只看 time 会让
    // 它们的归档时间全变成「写入那一刻」，几十条语音挤在同一天，按时间检索就废了。
    t: Number(msg.time ?? msg.at) || Date.now(),
    n: String(msg.sender ?? '').slice(0, 40) || '未知',
    u: msg.userId != null ? String(msg.userId) : null,
    m: body.slice(0, 500),
    s: msg.isSelf ? 1 : 0,
  };
  if (msg.messageId != null) rec.id = String(msg.messageId);
  if (msg.quoteTargetIsSelf) rec.q = 1;
  if (msg.kind) rec.k = String(msg.kind);
  if (msg.hasMedia) rec.hm = 1;
  return rec;
}

/**
 * 去重键。QQ 的 messageId 在同一会话里唯一，优先用它；
 * 自己发出的话（recordSentMessagesV2 里造的对象）没有 messageId，
 * 退化成「时间 + 正文」—— 同一个时间戳发同样两句话的概率可以忽略。
 */
function dedupKey(rec) {
  return rec.id ? `id:${rec.id}` : `tm:${rec.t}:${rec.m}`;
}

/**
 * 已归档去重键的缓存。
 *
 * 为什么必须去重：同一条消息可能走两条入库路径（入站 appendSocialV2Message、
 * 出站 recordSentMessagesV2），而重启后的首次加载、控制台的重发也可能重复 append。
 * 不去重的后果不是「多占点空间」，而是检索结果里同一条消息出现三次，
 * 白烧 token 还让【往事】段读起来像复读机。
 */
const seenByFile = new Map(); // filePath -> Set<dedupKey>
const MAX_SEEN_PER_FILE = 200_000;

function loadSeen(filePath) {
  const cached = seenByFile.get(filePath);
  if (cached) return cached;
  const seen = new Set();
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 读不出来不等于「空文件」：宁可从空集合开始（会让本次重复 append 一次），
      // 也不要抛错把调用方的消息入库流程炸掉。
      return seen;
    }
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec) seen.add(dedupKey(rec));
  }
  seenByFile.set(filePath, seen);
  return seen;
}

/**
 * 追加一批消息到会话归档。
 *
 * 同步写、失败不抛：这条路径挂在 QQ 收发的热路径上，
 * 归档写不进去只该是一条日志，绝不能阻塞或中断一次真实的消息收发。
 *
 * @returns {{written:number, skipped:number, records:object[]}}
 *   `records` 是**真正写进文件的**那些记录（已归一化、已去重），
 *   调用方可以拿去喂检索索引的增量更新，省掉一次「重新读盘 + 重新统计 DF」。
 */
export function appendArchive(stateDir, key, messages, onError = null) {
  const list = Array.isArray(messages) ? messages : [messages];
  const filePath = archiveFileFor(stateDir, key);
  if (!filePath) return { written: 0, skipped: list.length, records: [] };
  const seen = loadSeen(filePath);
  const lines = [];
  const records = [];
  let skipped = 0;
  for (const msg of list) {
    const rec = toArchiveRecord(key, msg);
    if (!rec) { skipped += 1; continue; }
    const dk = dedupKey(rec);
    if (seen.has(dk)) { skipped += 1; continue; }
    seen.add(dk);
    lines.push(JSON.stringify(rec));
    records.push(rec);
  }
  if (!lines.length) return { written: 0, skipped, records: [] };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  } catch (error) {
    onError?.(error);
    return { written: 0, skipped: list.length, records: [] };
  }
  // 缓存无界增长同样是漏：一个群聊一年几十万条，Set 里全是短字符串，问题不大，
  // 但保留上限能让「跑几年」不至于缓慢涨到失控。
  if (seen.size > MAX_SEEN_PER_FILE) {
    const keep = [...seen].slice(-Math.floor(MAX_SEEN_PER_FILE / 2));
    seenByFile.set(filePath, new Set(keep));
  }
  return { written: lines.length, skipped, records };
}

/** 读取一个会话的全部归档记录（解析失败的行跳过，不中断）。 */
export function readArchive(stateDir, key) {
  const filePath = archiveFileFor(stateDir, key);
  if (!filePath) return [];
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.m === 'string' && rec.m) out.push({ ...rec, key });
    } catch { /* 半截写入的行跳过 */ }
  }
  return out;
}

/** 列出所有已归档的会话 key（从文件名反推，仅用于诊断/统计）。 */
export function listArchives(stateDir) {
  const dir = path.join(stateDir, 'archive');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const base = n.slice(0, -'.jsonl'.length);
      const m = /^(group|private)_(\d+)$/.exec(base);
      return { file: path.join(dir, n), key: m ? `${m[1]}:${m[2]}` : base };
    });
}
