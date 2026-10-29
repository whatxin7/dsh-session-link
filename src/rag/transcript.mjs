// 从 DSH 会话记录（session.v4.jsonl.zstd）里把「群聊真实对话」还原出来。
//
// 为什么需要这一层：桥接自己只把最近 100 条留在 state/social-v2.json 里（环形缓冲），
// 更早的对话在桥接这边已经不存在了。但 DSH 的会话记录里有 —— 而且不是零散的：
// 每次唤醒都会把一批消息以 `【本次消息快照】` + JSON 内联进 prompt，
// 里面带着 sender / userId / messageId / text / at / ago，正好是可以还原的结构化数据。
// 这是目前唯一能补回历史语料的来源。
//
// ── 会话文件为什么不能直接 zstdDecompress ────────────────────────────────
// 它是 append 式写入的**多帧** zstd：每次追加一个独立帧（实测 897KB 里 578 帧）。
// zlib.zstdDecompressSync 只解第一帧就停下（结果只有 0.2KB），
// createZstdDecompress 碰到第二帧直接抛 `prefix_unknown`。
// 所以这里解析 zstd 帧头 + block header 自己算帧边界，逐帧解压再拼接。

import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;

/** 算出一个 zstd 帧的字节长度（不依赖解压，纯结构解析）。 */
function zstdFrameLength(buf, off) {
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`no zstd magic @${off}`);
  let p = off + 4;
  const fhd = buf[p]; p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) p += 1;                       // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];                      // Dictionary_ID
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];   // Frame_Content_Size
  for (;;) {
    if (p + 3 > buf.length) throw new Error(`truncated block header @${p}`);
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) throw new Error(`reserved block type @${p}`);
    p += size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p - off;
}

/** 解压一个 session.v4.jsonl.zstd，返回完整 JSONL 文本。 */
export function decompressSession(file) {
  const buf = fs.readFileSync(file);
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const len = zstdFrameLength(buf, off);
    // 单帧坏掉不该让整个会话读不出来：跳过这一帧继续。
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)));
    } catch { /* 跳过损坏帧 */ }
    off += len;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 把快照里的相对时间（`8s` / `7m` / `2h` / `刚刚`）换算成毫秒。 */
export function parseAgoMs(ago) {
  const s = String(ago ?? '').trim();
  if (!s || s === '刚刚' || s === 'now') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
  return n * unit;
}

const SNAPSHOT_HEAD = '【本次消息快照】';

/**
 * 从一段 prompt 文本里抠出消息快照。
 *
 * 必须按括号配平扫，而不是 `/\{[\s\S]*\}/`：快照后面紧跟着的说明里
 * 含有 `partial=true`、`afterSeq=readThroughSeq` 这样的花括号/等号混杂文本，
 * 贪婪匹配会把尾巴一起吞掉，JSON.parse 必然失败 —— 而失败是静默的（返回 null），
 * 表现就是「历史补不回来」却没有任何报错。
 */
export function extractSnapshot(text) {
  const src = String(text ?? '');
  const at = src.indexOf(SNAPSHOT_HEAD);
  if (at < 0) return null;
  let i = src.indexOf('{', at);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1));
          return obj && typeof obj === 'object' ? obj : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 桥接/控制台自己合成进消息流、但并不是「谁说了什么」的内容。
 *
 * 为什么要滤掉：`tts` / `sing` 这类是操作者在控制台的输入被回显成 isSelf 消息，
 * 归档进去会让 RAG 检索出「我：tts」这种对理解往事毫无用处、还占注入预算的片段。
 */
const SYNTHETIC_RE = /^(tts|sing|voice|status|ping|help|reset|poke|chime|sticker)\s*$/i;

/** 快照里的一条消息 → 平台无关的对话记录。 */
function normalizeSnapshotMessage(m, recordTime, seqInBatch = 0) {
  if (!m || typeof m !== 'object') return null;
  const body = String(m.plain ?? m.text ?? '').trim();
  if (!body) return null;
  // 只保留「人话」：纯占位符对检索没价值，还占归档空间。
  if (/^\[(图片|表情|动画表情|语音|视频|文件)\]$/.test(body)) return null;
  if (/^\[表情包[:：]/.test(body)) return null;
  // 桥接自己的排队提示不是对话内容。
  if (body.startsWith('⏳ 当前任务运行中')) return null;
  if (SYNTHETIC_RE.test(body)) return null;
  // 自己拍的拍一只是操作痕迹，别人拍的拍一拍才是社交信号。
  if (m.isSelf && /^\[拍一拍\]/.test(body)) return null;

  // 时间来源有两个，优先用绝对时间戳：
  //   · `at` 是毫秒数时（桥接内部合成记录会这样写）直接就是绝对时间；
  //   · 否则 `at` 是 "22:20" 这种墙上时钟，配合 `ago`（"36m"）反推。
  // 反推的精度只到分钟，所以同一批消息会坍塌到同一毫秒 —— 这会让「谁先说的」
  // 彻底丢失，而检索回来的往事一旦顺序错乱，因果就讲反了。因此按批内序号补偏移。
  let t;
  if (typeof m.at === 'number' && Number.isFinite(m.at) && m.at > 1e12) {
    t = m.at;
  } else {
    const agoMs = parseAgoMs(m.ago);
    t = Math.max(0, Number(recordTime) - agoMs) || Number(recordTime) || 0;
  }
  const name = String(m.sender ?? '').trim() || '未知';
  return {
    t: t + seqInBatch,
    n: name,
    u: m.userId != null ? String(m.userId) : null,
    m: body.slice(0, 500),
    s: m.isSelf ? 1 : 0,
    id: m.messageId != null ? String(m.messageId) : null,
    q: m.quoteTargetIsSelf ? 1 : undefined,
  };
}

/** 从 tool/call 的 qq_send_* 参数里拿到「小鲸鱼发出去的话」。 */
function messagesFromSendCall(rec) {
  const name = String(rec?.data?.name ?? '');
  if (!/qq_send_message|qq_send_burst|qq_reply|qq_send_group_message|qq_send_private_message/.test(name)) return [];
  let args;
  try {
    args = typeof rec.data.arguments === 'string' ? JSON.parse(rec.data.arguments) : rec.data.arguments;
  } catch {
    return [];
  }
  if (!args || typeof args !== 'object') return [];
  const raw = args.messages ?? args.message;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const t = Number(rec.time) || 0;
  return list
    .map((s, idx) => {
      const body = String(s ?? '').trim();
      if (!body) return null;
      return { t: t + idx * 1000, n: '我', u: null, m: body.slice(0, 500), s: 1, id: null };
    })
    .filter(Boolean);
}

/** 从 tool/call 的参数里读会话 key（形如 group:123456789）。 */
function keyFromCall(rec) {
  let args;
  try {
    args = typeof rec?.data?.arguments === 'string' ? JSON.parse(rec.data.arguments) : rec?.data?.arguments;
  } catch {
    return null;
  }
  const key = args?.key ?? (args?.groupId ? `group:${args.groupId}` : null) ?? (args?.userId ? `private:${args.userId}` : null);
  return typeof key === 'string' && /^(group|private):\d+$/.test(key) ? key : null;
}

/** prompt 文本里的会话 key（唤醒 prompt 第一行就写着 `【唤醒】group:xxx`）。 */
function keyFromPrompt(text) {
  const m = /【[^】]*】\s*((?:group|private):\d+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 解析一个会话记录文件，产出 `{key, records}`。
 *
 * key 的判定顺序（都失败就跳过该文件，不猜）：
 *   1. session 头里的 cwd 帮不上忙（所有聊天会话共用一个 cwd），所以看内容；
 *   2. tool/call 参数里的 `key` / `groupId` / `userId`，取出现最多的那个；
 *   3. 唤醒 prompt 里的 `【唤醒】group:xxx`；
 *   4. 快照里只有一个 userId 且不含群上下文 ⇒ private:<uid>。
 */
export function parseSessionFile(file) {
  const text = decompressSession(file);
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    recs.push(o);
  }
  recs.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));

  const keyVotes = new Map();
  const vote = (k) => { if (k) keyVotes.set(k, (keyVotes.get(k) ?? 0) + 1); };

  const out = [];
  const seenPromptHash = new Set();

  for (const rec of recs) {
    if (rec.type === 'tool/call') {
      vote(keyFromCall(rec));
      for (const m of messagesFromSendCall(rec)) out.push(m);
      continue;
    }
    // 快照出现在 user/message（真正投递给模型的）与 agent/inbox/spliced（同一份内容的另一条记录）。
    // 两条都要读：不同 DSH 版本只写其中一种。用正文哈希去重，避免同一批消息进两遍。
    let texts = [];
    if (rec.type === 'user/message') {
      texts = (rec.data?.content ?? []).map((c) => c?.text ?? '');
    } else if (rec.type === 'agent/inbox/spliced') {
      for (const ins of rec.data?.inserted ?? []) {
        for (const c of ins?.content ?? []) texts.push(c?.text ?? '');
      }
    } else {
      continue;
    }
    for (const t of texts) {
      if (!t) continue;
      vote(keyFromPrompt(t));
      if (!t.includes(SNAPSHOT_HEAD)) continue;
      const h = `${t.length}:${t.slice(0, 64)}:${t.slice(-64)}`;
      if (seenPromptHash.has(h)) continue;
      seenPromptHash.add(h);
      const snap = extractSnapshot(t);
      if (!snap) continue;
      const time = Number(rec.time) || 0;
      const batch = [...(snap.messages ?? []), ...(snap.recent ?? [])];
      for (let idx = 0; idx < batch.length; idx += 1) {
        const n = normalizeSnapshotMessage(batch[idx], time, idx);
        if (n) out.push(n);
      }
    }
  }

  const key = [...keyVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  out.sort((a, b) => a.t - b.t);
  return { key, records: out, rawRecords: recs.length };
}
