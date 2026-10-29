// 群聊长期记忆检索（RAG）：把归档的聊天记录做成可查询的「往事」，在唤醒时按相关度取几条。
//
// ── 为什么是内存线性扫描，而不是 SQLite / 向量库 ──────────────────────────
// 需求规模决定了实现：
//   · 一个活跃群一天几百条，一年约十万条，正文总计几 MB；
//   · 检索频率是「每次唤醒一次」（最多几十次/天），不是高频查询；
//   · 十万条 × 几个关键词的 includes 检查在几十毫秒量级，而一次 LLM 调用要几秒。
// 所以这里选最不容易坏的那个方案：append-only 文本 + 启动时载入内存 + 线性扫描。
// 换成 node:sqlite 的代价是：engines 允许 node 22.13，而 node:sqlite 在那版还要
// --experimental-sqlite；且 `.db` 一坏就是全丢，而这里坏一个字节只损失一行。
//
// ── 什么情况下该换成正经索引 ──────────────────────────────────────────────
// 单会话归档超过约 20 万条、或一次 search 实测超过 200ms 时。届时换 FTS5 即可，
// 接口（search / formatRecall）不用动 —— 这也是为什么检索和存储被拆成两个文件。

import { readArchive, listArchives } from './archive.mjs';

/** 高频虚词/语气词的 bigram：它们几乎出现在每条消息里，作为检索词只会拉满噪音。 */
const STOP_BIGRAMS = new Set([
  '的是', '是的', '了这', '这不', '这个', '那个', '就是', '不是', '我们', '你们',
  '他们', '什么', '怎么', '可以', '没有', '一个', '现在', '已经', '因为', '所以',
  '但是', '然后', '如果', '还是', '这样', '那样', '知道', '觉得', '时候', '自己',
  '一下', '这些', '那些', '有点', '真的', '其实', '应该', '可能', '不过', '而且',
  '还有', '只是', '直接', '一直', '起来', '出来', '过来', '上去', '下去', '不要',
  '行了', '好了', '吧啊', '呢啊', '了啊', '吗啊', '嗯嗯', '哈哈', '呵呵', '嘿嘿',
  '我来', '你去', '他来', '她说', '他说', '话说', '说的', '话就', '就这',
  // 下面这批是「跨会话检索」实测补的：聊天里问"上次/之前/那张/是啥"时，
  // 这些词看着稀有（因为被 3~4 字窗口切得古怪），拿去检索却只会捞回一堆无关的话。
  '上次', '之前', '那张', '这张', '是啥', '来着', '哪来', '哪一', '去那', '这儿',
  '没事', '有点', '一点', '一起', '一样', '一会儿', '的话', '了吧', '了吗', '么样',
]);

/** 取一段文本里的中文 bigram（含 2 字整词），过滤停用词。 */
export function chineseBigrams(text) {
  const out = new Set();
  const runs = String(text ?? '').match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of runs) {
    if (run.length < 2) continue;
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bi = run.slice(i, i + 2);
      if (STOP_BIGRAMS.has(bi)) continue;
      out.add(bi);
    }
  }
  return out;
}

/** 英文/数字 token：比中文更容易是专有名词（yyds、GPT、版本号 169861005）。 */
function asciiTokens(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/[A-Za-z0-9_]{2,20}/g)) out.add(m[0].toLowerCase());
  return out;
}

/**
 * 中文 3~4 字词。
 *
 * 存在理由就是 bigram 的固有缺陷：两字窗口必然跨词边界，产出 `我不`、`来了`、`是一`
 * 这种既不是词、又在语料里高频的碎片。3 字以上跨词边界的概率低得多，
 * 所以检索时用它做「高精度主力」，bigram 退居「兜底召回」。
 */
export function chineseNgrams(text) {
  const out = new Set();
  const runs = String(text ?? '').match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of runs) {
    for (let n = 3; n <= 4 && n <= run.length; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) out.add(run.slice(i, i + n));
    }
  }
  return out;
}

/** 控制台回显的命令（`tts` / `sing` …）被存进 recentMessages 后会被当成「一句话」。 */
const QUERY_NOISE_RE = /^(tts|sing|voice|status|ping|help|reset|poke|chime|sticker)\s*$/i;

/**
 * 这条消息值不值得拿去当检索词。
 *
 * 「嗯」「了」「…」「[图片]」「tts」这类消息的 bigram 全是垃圾（或者根本没有 bigram），
 * 但它们会占满 8 个检索词名额。实测混进来之后，一次关于「表情包」的提问
 * 被检索成了「回来了」——因为查询里有一句「戳回来了，有事直说」。
 */
function isInformativeBody(body) {
  const s = String(body ?? '').replace(/\[拍一拍\][^\n]*/g, '').trim();
  if (s.length < 4) return false;
  if (QUERY_NOISE_RE.test(s)) return false;
  if (/^\[[^\]]{1,12}\]$/.test(s)) return false;          // 纯媒体占位符
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return false;   // 纯标点/表情符号
  return true;
}

/**
 * 从「最近这轮在聊什么」提炼检索词。
 *
 * ── 为什么要 IDF（这是第二版踩过的坑）──
 * 第一版按「是谁说的 / 正文里的 bigram」平等取前 8 个词，结果几乎每条查询的检索词
 * 里都塞满 `现在`、`是在`、`两张` 这类到处都有的碎片，而真正有区分度的 `表情`、`情包`
 * 因为和它们同权重，排不进前 8 —— 于是「表情包那事」检索出来的是别人吵架。
 * 现在按 `基础权重 × IDF` 排序，并直接把 IDF 太低的词丢掉：
 * 一个词如果在本群一半消息里都出现，它就没有「检索」价值。
 *
 * @param {{messages?:object[], names?:Map<string,number>, selfName?:string,
 *          df?:Map<string,number>, docs?:number}} opts
 * @returns {{terms:string[], weights:Map<string,number>}}
 */
export function buildQueryTerms({ messages = [], names = new Map(), selfName = '我', df = new Map(), docs = 0 } = {}) {
  const base = new Map();
  const bump = (term, w) => {
    if (!term) return;
    base.set(term, Math.max(base.get(term) ?? 0, w));
  };

  // 先筛掉没信息量的消息：它们的 bigram 只会稀释检索词。
  const useful = messages.filter((m) => isInformativeBody(String(m?.plain ?? m?.text ?? '')));
  const bodies = useful.map((m) => String(m?.plain ?? m?.text ?? ''));

  // 1) 正文里点名叫到谁 —— 「你还记得皮蛋吗」才算在聊这个人。
  //
  // **刻意不收「这条是谁发的」**：那是「谁在说话」，不是「在说什么」。
  // 实测把发送者放进检索词后，一个群里发言最多的人会驻留在每个查询的第一名，
  // 于是一段关于「3000 字作业」的对话检索出来的全是「所有提到大肥鱼的消息」。
  for (let i = 0; i < useful.length; i += 1) {
    for (const name of names.keys()) {
      const n = String(name ?? '').trim();
      if (n.length < 2 || n.length > 12 || n === selfName) continue;
      if (bodies[i]?.includes(n)) bump(n, 2);
    }
  }

  // 2) 正文 3~4 字词 / bigram / ascii token：这才是「话题」本身。
  //
  // 为什么长词要单独给更高的权重：bigram 是「任何两个相邻汉字」，必然包含
  // `我不`、`来了`、`是一` 这类**跨词边界的碎片**。它们在高频语料里有足够低的 DF，
  // 于是能混进检索词，把「我不写作业」这种具体的话检索成「所有说过『我不』的消息」。
  // 3~4 字词（`我不写`、`表情包`）几乎不会跨词边界，精度高得多，所以加权让它优先。
  for (const body of bodies) {
    if (!body) continue;
    for (const tri of chineseNgrams(body, 3)) bump(tri, 1.5);
    for (const bi of chineseBigrams(body)) bump(bi, 1);
    for (const tok of asciiTokens(body)) bump(tok, 0.8);
  }

  // 3) 只有一个 sender、正文也没内容词时（比如对方只发了个表情或「嗯」），
  //    退回用该会话的高频人名兜底，否则无从检索。
  if (![...base.keys()].some((t) => !names.has(t))) {
    for (const [name, freq] of [...names.entries()].slice(0, 5)) bump(name, 1 + Math.min(freq, 20) / 20);
  }

  // 平滑 IDF：df=0（词不在库里）时取上限，避免出现 Infinity。
  //
  // ── df=0 为什么必须特殊对待（第三版的坑）──
  // 用户这句话里的词，很可能在历史里**一个都没有**（换了个说法、聊的是新事）。
  // 纯 IDF 会把这批「语料里不存在」的词算成最稀有、给最高权重、排进前几名 ——
  // 而它们检索时必然 0 命中，于是真正能匹配上的 `表情` 反被挤出前 8，整条查询「无结果」。
  // 所以 df=0 的词只做兜底（低权重、排在后面），永远不抢真正存在的词的位置。
  const idfAt = (d) => Math.min(4, Math.log((docs + 1) / (d + 0.5)) / Math.log(2));

  // 只留「够特殊」的词：一个出现在 >25% 消息里的词几乎不携带区分信息。
  // 人名例外：它不按 IDF 缩放，因为它不是「话题词」而是「实体锚点」——
  // 而且它天然稀缺（一个人名在几百条消息里只出现在几十条），IDF 会把
  // 「温德馨」抬到比「表情」还高，于是每条查询又都被某个人名带偏。
  const weights = new Map();
  const candidates = [];
  for (const [term, w] of base) {
    if (names.has(term)) {
      weights.set(term, w);
      candidates.push([term, w]);
      continue;
    }
    const d = df.get(term) ?? 0;
    if (d === 0) {
      // 语料里没这个词：留着（说话人可能只是换了个说法），但压到最低档。
      weights.set(term, Number((w * 0.3).toFixed(3)));
      candidates.push([term, w * 0.3]);
      continue;
    }
    const idf = idfAt(d);
    if (docs > 20 && idf < 1.0) continue;   // 太常见的词直接丢
    const score = w * Math.max(0.5, idf);
    weights.set(term, Number(score.toFixed(3)));
    candidates.push([term, score]);
  }
  // 全被 IDF 滤空了（比如整个群只说过几句话）就退回原始词表，别什么都不检索。
  if (!candidates.length) {
    for (const [term, w] of base) { weights.set(term, w); candidates.push([term, w]); }
  }

  // 名额分配：长词（高精度）→ bigram（兜底召回）→ 人名（实体锚点）。
  // 不用「统一按分数取前 8」：长词因为权重 ×1.5 本来就会挤掉 bigram，
  // 但一个长词命中都没有时，还需要 bigram 来保证「至少捞得到点东西」。
  //
  // 长词必须去重叠：3 字和 4 字窗口会在同一句里切出 `字作业你/作业你自/业你自己/你自己交`
  // 这样一串互相覆盖的片段，它们其实是**同一处文本**，全收进来等于把 5 个名额
  // 全花在一句话上，检索词的实际覆盖面反而变窄了。
  const sharesRun = (a, b) => {
    if (a === b || a.includes(b) || b.includes(a)) return true;
    for (let n = Math.min(a.length, b.length) - 1; n >= 2; n -= 1) {
      if (a.slice(-n) === b.slice(0, n) || b.slice(-n) === a.slice(0, n)) return true;
    }
    return false;
  };
  const byScore = (a, b) => b[1] - a[1] || b[0].length - a[0].length;
  const pickDistinct = (pool, want) => {
    const taken = [];
    for (const item of pool) {
      if (taken.length >= want) break;
      if (taken.some((t) => sharesRun(item[0], t[0]))) continue;
      taken.push(item);
    }
    return taken;
  };
  const isNamed = ([t]) => names.has(t);
  const longTerms = pickDistinct(candidates.filter((x) => !isNamed(x) && x[0].length >= 3).sort(byScore), 5);
  const shortTerms = pickDistinct(candidates.filter((x) => !isNamed(x) && x[0].length === 2).sort(byScore), 3);
  const namedTerms = candidates.filter(isNamed).sort(byScore).slice(0, 2);
  const terms = [...new Set([...longTerms, ...shortTerms, ...namedTerms].map(([t]) => t))];
  return { terms, weights };
}

/**
 * 一条归档记录的时间衰减系数。
 *
 * 注意这里**故意衰减得很轻**：RAG 的价值恰恰在于「翻很久以前的账」。
 * 如果按天断崖式衰减，那和 recentMessages 就没区别了 —— 那个本来就在上下文里。
 */
function recencyFactor(ts, now) {
  const days = Math.max(0, (now - ts) / 86_400_000);
  return 0.75 + 0.25 / (1 + Math.log10(1 + days));
}

/**
 * 检索「往事」。
 *
 * @param {object} opts
 * @param {string} opts.key            会话 key（只在本会话里翻，不串群）
 * @param {string[]} opts.terms        检索词
 * @param {Map<string,number>} opts.weights
 * @param {number} [opts.excludeAfterTs] 排除此时间之后的消息（避开已在上下文里的近期消息）
 * @param {number} [opts.limit]
 * @param {number} [opts.now]
 * @returns {object[]} 按相关度排序的记录
 */
export function scoreRecords(records, { terms = [], weights = new Map(), excludeAfterTs = 0, limit = 12, now = Date.now(), withScore = false } = {}) {
  const list = terms.filter(Boolean);
  if (!list.length) return [];
  const totalWeight = list.reduce((s, t) => s + (weights.get(t) ?? 1), 0) || 1;
  const out = [];
  for (const rec of records) {
    if (excludeAfterTs && Number(rec.t) >= excludeAfterTs) continue;
    const body = String(rec.m ?? '');
    if (!body) continue;
    let hit = 0;
    let hits = 0;
    for (const term of list) {
      if (body.includes(term)) {
        hit += weights.get(term) ?? 1;
        hits += 1;
      }
    }
    if (!hits) continue;
    // 两个覆盖率都要：
    //   · coverageByCount  —— 命中了几个**不同**的查询词（话题覆盖广度）；
    //   · coverageByWeight —— 命中的那些词是不是更重要的词。
    // 只看权重会让「恰好命中了那个人名」的一条孤零零的拍一拍压过真正聊这件事的三四句话；
    // 只看计数则会让一串高频虚词命中盖过内容词命中。两个都要、再各自给个系数。
    const coverageByCount = hits / list.length;
    const coverageByWeight = hit / totalWeight;
    let score = coverageByCount * 3.2 + coverageByWeight * 1.8 + Math.min(hits, 4) * 0.35;
    if (rec.q) score += 0.35;                       // 这条是在跟你说话
    score += Math.min(body.length, 120) / 600;       // 长消息信息量大
    out.push({ rec, score: score * recencyFactor(Number(rec.t) || now, now) });
  }
  out.sort((a, b) => b.score - a.score || (Number(b.rec.t) || 0) - (Number(a.rec.t) || 0));

  // 多样性别丢：同一个人的连续碎话、同一句话的复读，占了名额却没增加信息。
  // 实测【往事】6 条全是自己说过的话 —— 那读起来不像「翻旧账」，像对着镜子说话。
  const capped = [];
  const perName = new Map();
  const PER_NAME_MAX = 2;
  for (const item of out) {
    const who = Number(item.rec.s) === 1 ? '__self__' : String(item.rec.n ?? '');
    const used = perName.get(who) ?? 0;
    if (used >= PER_NAME_MAX) continue;
    perName.set(who, used + 1);
    capped.push(withScore ? item : item.rec);
    if (capped.length >= Math.max(1, limit)) break;
  }
  return capped;
}

/**
 * 把检索结果的若干条整理成一段可直接注入提示词的文本。
 *
 * 排序刻意用**时间正序**：检索按相关度选，但人读一段旧对话时，倒序会把因果讲反。
 * 超过 maxChars 就从最早的那头截断 —— 丢掉最久远的上下文，保留离现在近的因果。
 */
export function formatRecall(records, { maxChars = 900, selfName = '我' } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r.m === 'string' && r.m)
    .sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  if (!list.length) return '';
  const dayOf = (ts) => {
    const d = new Date(Number(ts) || 0);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const lines = list.map((r) => `· ${dayOf(r.t)} ${Number(r.s) === 1 ? selfName : (r.n || '某人')}：${String(r.m).replace(/\s+/g, ' ').slice(0, 160)}`);
  // 从尾部（最近的）往前累加，保证截断时保留最近的因果。
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (used + lines[i].length > maxChars && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  return kept.join('\n');
}

/** 一条消息正文拆成的检索单元集合（bigram + 3~4 字词 + ascii token），DF 统计和查询共用同一套切分。 */
function docTerms(text) {
  const set = chineseBigrams(text);
  for (const t of chineseNgrams(text)) set.add(t);
  for (const t of asciiTokens(text)) set.add(t);
  return set;
}

/**
 * 一个会话的检索上下文：载入归档、统计文档频率、提供 search。
 *
 * 名频次与 DF 都来自归档本身而不是 memberImpressions：印象表可能是空的（现状就是空的），
 * 而「谁说话多、谁的名字总被提起、哪些词到处都是」这几种信号在原始记录里一定有。
 */
export class RecallStore {
  #stateDir;
  #records = new Map();      // key -> rec[]
  #nameFreq = new Map();     // key -> Map<name, count>
  #df = new Map();           // key -> Map<term, 含该词的消息条数>
  #loaded = new Set();
  #log;
  #selfName;

  constructor({ stateDir, log = null, selfName = '我' } = {}) {
    this.#stateDir = stateDir;
    this.#log = log;
    this.#selfName = selfName;
  }

  get selfName() { return this.#selfName; }
  set selfName(v) { if (v) this.#selfName = v; }

  #countDoc(key, body) {
    let df = this.#df.get(key);
    if (!df) { df = new Map(); this.#df.set(key, df); }
    for (const term of docTerms(body)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  /** 首次访问某个会话时载入它的归档（懒加载：没聊过的群不占内存）。 */
  #ensure(key) {
    if (this.#loaded.has(key)) return;
    this.#loaded.add(key);
    const recs = readArchive(this.#stateDir, key);
    this.#records.set(key, recs);
    const freq = new Map();
    const df = new Map();
    this.#df.set(key, df);
    for (const r of recs) {
      if (Number(r.s) === 1) continue;
      const n = String(r.n ?? '').trim();
      if (n) freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    // DF 统计要覆盖所有消息（包括自己说的）：它在回答「这个词在本群有多常见」。
    for (const r of recs) {
      const body = String(r.m ?? '');
      if (!body) continue;
      for (const term of docTerms(body)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    this.#nameFreq.set(key, freq);
  }

  /** 热路径追加（桥接刚归档的消息），避免下一轮还要从磁盘重读。 */
  push(key, records) {
    this.#ensure(key);
    const list = this.#records.get(key);
    const freq = this.#nameFreq.get(key);
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || !r.m) continue;
      list.push(r);
      if (Number(r.s) !== 1) {
        const n = String(r.n ?? '').trim();
        if (n) freq.set(n, (freq.get(n) ?? 0) + 1);
      }
      this.#countDoc(key, String(r.m));
    }
  }

  /** 该会话里说话最多的人（用于把 2 字昵称也纳入检索词）。 */
  topNames(key, limit = 30) {
    this.#ensure(key);
    const freq = this.#nameFreq.get(key) ?? new Map();
    return new Map([...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, limit)));
  }

  size(key) {
    this.#ensure(key);
    return (this.#records.get(key) ?? []).length;
  }

  allKeys() {
    const keys = new Set(listArchives(this.#stateDir).map((x) => x.key));
    for (const k of this.#records.keys()) keys.add(k);
    return [...keys];
  }

  /**
   * 检索入口。
   * @returns {{records:object[], text:string, stats:object}}
   */
  search(key, { messages = [], excludeAfterTs = 0, limit = 12, maxChars = 900 } = {}) {
    this.#ensure(key);
    const recs = this.#records.get(key) ?? [];
    if (!recs.length) return { records: [], text: '', stats: { candidates: 0, terms: 0 } };
    const names = this.topNames(key, 40);
    const df = this.#df.get(key) ?? new Map();
    const { terms, weights } = buildQueryTerms({
      messages, names, selfName: this.#selfName, df, docs: recs.length,
    });
    const hits = scoreRecords(recs, { terms, weights, excludeAfterTs, limit, now: Date.now() });
    const text = formatRecall(hits, { maxChars, selfName: this.#selfName });
    return { records: hits, text, stats: { candidates: recs.length, terms: terms.length, termsSample: terms.slice(0, 6) } };
  }

  /**
   * 跨会话检索：从**别的**会话的归档里翻相关旧话。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────
   * DSH 是「一个 QQ 会话一个会话」。私聊里被问「你刚才在别处说的那个 XX 是什么」，
   * 那段话根本不在本会话上下文里，模型只能编 —— 或者像实测那样干巴巴回一句
   * 「我这边只能翻这个群，别的私聊读不到」。记录其实一直躺在归档里，
   * 缺的只是「跨会话的翻法」。
   *
   * ── 为什么按会话分别打分再合并 ──────────────────────────────────────
   * DF（这个词在该会话多常见）本身是分群语义：同一个词在 A 群是口头禅、在 B 群是专名。
   * 用一套全局 DF 会让两边都失真，所以检索词权重取当前会话的语料（"现在在聊什么"），
   * 打分在各自会话内进行，最后按分数合并 + 每个会话限流，避免某一个大群把名额吃光。
   *
   * 隐私边界不在这一层做：调用方必须先按白名单筛过 keys。
   */
  searchAcross({ fromKey = '', keys = [], messages = [], limit = 8, maxChars = 900, perKeyMax = 3 } = {}) {
    const targets = (Array.isArray(keys) ? keys : []).filter((k) => k && k !== fromKey);
    if (!targets.length) return { records: [], stats: { keys: 0, terms: 0, hits: 0 } };
    if (fromKey) this.#ensure(fromKey);
    for (const k of targets) this.#ensure(k);

    const queryText = (Array.isArray(messages) ? messages : [])
      .map((m) => String(m?.plain ?? m?.text ?? m?.m ?? ''))
      .filter((s) => isInformativeBody(s))
      .join(' ');
    if (!queryText.trim()) return { records: [], stats: { keys: targets.length, terms: 0, hits: 0 } };

    // 检索词不用 buildQueryTerms 那套（它按"本会话 DF"定权，是给单会话设计的）。
    // 跨会话要回答的是「哪个词能把别的窗口那段话捞上来」，所以用**合并语料的 IDF**：
    //   · 哪儿都没出现过的词 = 捞不到，直接扔（df=0）；
    //   · 到处都有的词 = 噪音（df 高 → idf 低）；
    //   · 甜点区是"只在一两个窗口出现过"的词 —— 实测「胖黄蛋」正是这种。
    const mergedDf = new Map();
    let docs = 0;
    for (const k of targets) {
      const df = this.#df.get(k) ?? new Map();
      docs += (this.#records.get(k) ?? []).length;
      for (const [term, n] of df) mergedDf.set(term, (mergedDf.get(term) ?? 0) + n);
    }
    const N = Math.max(1, docs);
    // 「稀有」的绝对下限：一个词在合并语料里出现次数超过 max(6, 0.5%)，它就不是线索而是口头禅。
    // 只看 IDF 在这个尺度上不够用：语料上万条时「那个」的 IDF 只比专名低一点，仍然会占满名额。
    const rareCap = Math.max(6, Math.round(N * 0.005));
    const scoredTerms = [];
    for (const term of docTerms(queryText)) {
      const df = mergedDf.get(term) ?? 0;
      if (!df || df > rareCap) continue;
      // 3~4 字窗口会切出「的那个」「是不是」这种"含有虚词 bigram 的碎片"。
      // 它们恰好也可能很稀有（因为长），但只要含虚词就当噪音 —— 这是「胖黄蛋」能被留下的原因。
      if (term.length >= 3) {
        let noisy = false;
        for (let i = 0; i + 2 <= term.length; i += 1) {
          if (STOP_BIGRAMS.has(term.slice(i, i + 2))) { noisy = true; break; }
        }
        if (noisy) continue;
      }
      const idf = Math.log((N + 1) / (df + 0.5));
      // 长词更可信（3~4 字跨词边界的概率低），再乘 idf
      const weight = idf * (term.length >= 3 ? 1.5 : 1);
      scoredTerms.push([term, weight, idf]);
    }
    if (!scoredTerms.length) return { records: [], stats: { keys: targets.length, terms: 0, hits: 0 } };
    scoredTerms.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    const chosen = [];
    for (const item of scoredTerms) {
      if (chosen.length >= 8) break;
      // 同一处文本切出来的互相覆盖片段（胖黄蛋/黄蛋/胖黄）只留最长的那个
      if (chosen.some(([t]) => t.includes(item[0]) || item[0].includes(t))) continue;
      chosen.push(item);
    }
    const terms = chosen.map(([t]) => t);
    const weights = new Map(chosen.map(([t, w]) => [t, w]));

    const now = Date.now();
    const picked = [];
    for (const k of targets) {
      const recs = this.#records.get(k) ?? [];
      if (!recs.length) continue;
      const hits = scoreRecords(recs, { terms, weights, excludeAfterTs: 0, limit: perKeyMax * 4, now, withScore: true });
      for (const it of hits.slice(0, perKeyMax)) picked.push({ ...it.rec, __key: k, __score: it.score });
    }
    // 先按分数挑（跨会话竞争名额），再按时间排（读起来才像一段对话）。
    // 反过来做会让「排在前面那个群」把名额全占掉 —— 上面那版就是这么丢掉真正的命中的。
    const perKey = new Map();
    const winners = [];
    for (const r of picked.sort((a, b) => b.__score - a.__score)) {
      const used = perKey.get(r.__key) ?? 0;
      if (used >= 2) continue;
      perKey.set(r.__key, used + 1);
      winners.push(r);
      if (winners.length >= Math.max(1, limit)) break;
    }
    winners.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    const kept = winners;
    // 「稀有词」用来判断「这句话里有没有值得主动去别处翻的实体」。
    // 光看「出现次数少」不够：3~4 字窗口会把「群里有」「个表情」这种碎片切得很稀有。
    // 做法：把稀有候选的**首尾虚词剥掉**再判断形态 —— 「个胖黄蛋」→「胖黄蛋」（是真名），
    // 「群里有」→「群里」（剥完不够长，丢掉），「今天吃」含时间词（丢掉）。
    const FUNC = '个这那的了是把被给和又会就也都很有在从对向往再';
    const ENTITY_NOISE = /今天|明天|昨天|前天|现在|刚才|刚刚|时间|小时|分钟|多少|什么|怎么|为啥|哪个|一下/;
    const rareTerms = [];
    for (const term of docTerms(queryText)) {
      const raw = String(term);
      if (raw.length < 3) continue;
      const df = mergedDf.get(raw) ?? 0;
      // 只出现 1 次的片段几乎都是巧合切片（一段话里任意 3 连字都满足"只出现一次"）；
      // 出现 2~3 次的才是"被反复提起的同一个词" —— 外号、专名正是这个形态。
      if (df < 2 || df > 3) continue;
      let t = raw;
      while (t.length > 1 && FUNC.includes(t[0])) t = t.slice(1);
      while (t.length > 1 && FUNC.includes(t[t.length - 1])) t = t.slice(0, -1);
      if (t.length < 3) continue;
      if (ENTITY_NOISE.test(t)) continue;
      if (!rareTerms.includes(t)) rareTerms.push(t);
    }
    const budget = Math.max(200, maxChars);
    const out = [];
    let used = 0;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const body = String(kept[i].m ?? '').replace(/\s+/g, ' ').slice(0, 150);
      if (used + body.length > budget && out.length) break;
      out.unshift({ ...kept[i], __body: body });
      used += body.length + 1;
    }
    return { records: out, stats: { keys: targets.length, terms: terms.length, hits: out.length, rareTerms, termsSample: terms.slice(0, 6) } };
  }
}
