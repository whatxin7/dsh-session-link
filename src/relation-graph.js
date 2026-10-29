// 跨会话关系图：把「谁在这个群、谁也在那个群、他换过几个名字、多久没说话」记成结构。
//
// 和 cross-talk.mjs 的分工（两者不重复）：
//   · cross-talk 是**内容**层：另一个会话最近两小时说了什么（内存环、时间窗、会过期）；
//   · 这里是**关系**层：这个人在哪些会话里出现过、什么时候、多少条（落盘、跨天、可查）。
//   cross-talk 回答「你刚在群里说什么来着」，关系图回答「这人是谁、跟他熟不熟」。
//
// 纯逻辑 + 一个小类：不碰 fs，不碰网络，序列化交给调用方。
// 由 bridge.js 在消息入库时 observe()，落 state/relations.json。

export const RELATION_DEFAULTS = Object.freeze({
  enabled: true,
  // 最多记多少人（超出按 lastSeen 淘汰，避免这个人变成一张几万行的表）。
  maxPeople: 400,
  // 一个人最多记几个别名（改名很常见，"小明"→"明明"→"明"）。
  maxAliases: 4,
  // 一个人最多记几个会话足迹。
  maxSessionsPerPerson: 12,
  // 多久没说话就从图里淡化掉（不是删除，只是 digest 里不再提）。
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  // 注入提示词时最多列几个人。
  contextPeople: 6,
  // digest 的字符上限（这是提示词预算，不是安全边界）。
  contextChars: 600
});

const SELF_NAMES = new Set(['我', '你', '自己']);

export function normalizeRelationConfig(raw, base = RELATION_DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: src.enabled !== false,
    maxPeople: num(src.maxPeople, base.maxPeople, 20, 5000),
    maxAliases: num(src.maxAliases, base.maxAliases, 1, 10),
    maxSessionsPerPerson: num(src.maxSessionsPerPerson, base.maxSessionsPerPerson, 1, 50),
    maxAgeMs: num(src.maxAgeMs, base.maxAgeMs, 60_000, 365 * 24 * 60 * 60 * 1000),
    contextPeople: num(src.contextPeople, base.contextPeople, 0, 20),
    contextChars: num(src.contextChars, base.contextChars, 200, 4000)
  };
}

/** 「今天 / 3 天前 / 很久以前」——注入提示词时用它，比时间戳好读。 */
export function describeWhen(at, now = Date.now()) {
  const t = Number(at) || 0;
  if (!t) return '还没说过话';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 10) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return '很久以前';
}

export function sessionLabel(key) {
  const s = String(key ?? '');
  if (s.startsWith('group:')) return `群${s.slice(6)}`;
  if (s.startsWith('private:')) return `私聊${s.slice(8)}`;
  return s || '未知会话';
}

function personIdFor(qq, name) {
  const q = String(qq ?? '').trim();
  // QQ 号纯数字；短号只出现在测试夹具里，同样按号归并（比按名字归并可靠）。
  if (/^\d+$/.test(q)) return `qq:${q}`;
  const n = String(name ?? '').trim();
  return n ? `name:${n}` : null;
}

function emptyPerson(id) {
  return {
    id,
    qq: '',
    names: [],
    sessions: {},
    count: 0,
    firstSeen: 0,
    lastSeen: 0,
    lastText: '',
    // 「他在这儿说的是什么调子」：只记最近几条文本的首词，供 digest 里带一句性格线索。
    lastSaid: []
  };
}

export class RelationGraph {
  constructor(state = null, config = {}) {
    this.cfg = normalizeRelationConfig(config);
    this.people = new Map();
    this.dirty = false;
    if (state) this.load(state);
  }

  get size() {
    return this.people.size;
  }

  load(state) {
    const people = state?.people;
    if (!people || typeof people !== 'object') return this;
    for (const [id, raw] of Object.entries(people)) {
      if (!raw || typeof raw !== 'object') continue;
      const p = emptyPerson(id);
      p.qq = String(raw.qq ?? '').slice(0, 20);
      p.names = Array.isArray(raw.names) ? raw.names.filter((n) => typeof n === 'string').slice(0, this.cfg.maxAliases) : [];
      p.sessions = {};
      for (const [k, v] of Object.entries(raw.sessions ?? {})) {
        if (!v || typeof v !== 'object') continue;
        p.sessions[k] = { count: Math.max(0, Number(v.count) || 0), lastAt: Number(v.lastAt) || 0 };
      }
      p.count = Math.max(0, Number(raw.count) || 0);
      p.firstSeen = Number(raw.firstSeen) || 0;
      p.lastSeen = Number(raw.lastSeen) || 0;
      p.lastText = String(raw.lastText ?? '').slice(0, 80);
      p.lastSaid = Array.isArray(raw.lastSaid) ? raw.lastSaid.filter((s) => typeof s === 'string').slice(0, 3) : [];
      this.people.set(id, p);
    }
    return this;
  }

  toJSON() {
    const people = {};
    for (const [id, p] of this.people) people[id] = p;
    return { v: 1, updatedAt: Date.now(), people };
  }

  /**
   * 消化一批归档记录。
   * @param key 会话 key（group:123 / private:456）
   * @param records appendArchive 的返回值：[{ seq, at, sender, text, uin?, qq? }]
   * @returns 实际更新的记录条数
   */
  observe(key, records, { now = Date.now() } = {}) {
    if (!this.cfg.enabled || !key) return 0;
    let touched = 0;
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object') continue;
      const name = String(r.sender ?? r.name ?? '').trim().slice(0, 24);
      if (!name || SELF_NAMES.has(name)) continue;
      const id = personIdFor(r.uin ?? r.qq ?? r.userId ?? r.user_id, name);
      if (!id) continue;
      const at = Number(r.at ?? r.time ?? now) || now;
      let p = this.people.get(id);
      if (!p) {
        p = emptyPerson(id);
        p.firstSeen = at;
        this.people.set(id, p);
      }
      const qq = String(r.uin ?? r.qq ?? r.userId ?? r.user_id ?? '').trim();
      if (qq && !p.qq) p.qq = qq.slice(0, 20);
      // 别名：最近说的名字排最前（改名后大家叫的是新名字）。
      if (name && p.names[0] !== name) {
        p.names = [name, ...p.names.filter((n) => n !== name)].slice(0, this.cfg.maxAliases);
      }
      const s = p.sessions[key] ?? { count: 0, lastAt: 0 };
      s.count += 1;
      s.lastAt = Math.max(s.lastAt, at);
      p.sessions[key] = s;
      // 会话数超限：丢最久没说话的那个（本会话永远保留）。
      const keys = Object.keys(p.sessions);
      if (keys.length > this.cfg.maxSessionsPerPerson) {
        const drop = keys
          .filter((k) => k !== key)
          .sort((a, b) => (p.sessions[a].lastAt ?? 0) - (p.sessions[b].lastAt ?? 0))[0];
        if (drop) delete p.sessions[drop];
      }
      p.count += 1;
      p.lastSeen = Math.max(p.lastSeen, at);
      const text = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (text) {
        p.lastText = text;
        p.lastSaid = [text, ...p.lastSaid.filter((t) => t !== text)].slice(0, 3);
      }
      touched += 1;
    }
    if (touched) {
      this.dirty = true;
      this.prune(now);
    }
    return touched;
  }

  /** 超量/超龄淘汰。返回删掉的人数。 */
  prune(now = Date.now()) {
    let removed = 0;
    const cutoff = now - this.cfg.maxAgeMs;
    for (const [id, p] of [...this.people]) {
      if (p.lastSeen && p.lastSeen < cutoff) {
        this.people.delete(id);
        removed += 1;
      }
    }
    if (this.people.size > this.cfg.maxPeople) {
      const byAge = [...this.people.entries()].sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0));
      for (const [id] of byAge.slice(0, this.people.size - this.cfg.maxPeople)) {
        this.people.delete(id);
        removed += 1;
      }
    }
    if (removed) this.dirty = true;
    return removed;
  }

  /** 本会话里最常出现的人（按条数、再看最近时间）。 */
  topFor(key, limit = this.cfg.contextPeople, now = Date.now()) {
    const out = [];
    for (const p of this.people.values()) {
      const s = p.sessions[key];
      if (!s || !s.count) continue;
      out.push({ person: p, session: s, recent: now - (s.lastAt || 0) <= this.cfg.maxAgeMs });
    }
    out.sort((a, b) => b.session.count - a.session.count || (b.session.lastAt ?? 0) - (a.session.lastAt ?? 0));
    return out.slice(0, Math.max(0, limit));
  }

  /** 这个人除了当前会话还出现在哪（跨会话的那一半）。 */
  otherSessions(id, key) {
    const p = this.people.get(id);
    if (!p) return [];
    return Object.entries(p.sessions)
      .filter(([k]) => k !== key)
      .sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))
      .map(([k, v]) => ({ key: k, label: sessionLabel(k), count: v.count, lastAt: v.lastAt }));
  }

  /**
   * 注入提示词的那一小段。空图/全过期返回 ''（调用方据此不插空段）。
   * 只写「谁、多熟、还有哪儿见过」，不写内容摘要 —— 内容是 cross-talk 的活。
   */
  digest(key, now = Date.now()) {
    if (!this.cfg.enabled) return '';
    const top = this.topFor(key, this.cfg.contextPeople, now);
    if (!top.length) return '';
    const lines = [];
    for (const { person, session } of top) {
      const name = person.names[0] || person.id.replace(/^(qq|name):/, '');
      const aliases = person.names.slice(1, this.cfg.maxAliases);
      const aliasPart = aliases.length ? `（也叫 ${aliases.join('、')}）` : '';
      const others = this.otherSessions(person.id, key);
      const crossPart = others.length
        ? `；别处也见过：${others.slice(0, 2).map((o) => `${o.label}（${o.count} 条）`).join('、')}`
        : '';
      lines.push(`- ${name}${aliasPart}：本会话 ${session.count} 条，${describeWhen(session.lastAt, now)}说过话${crossPart}`);
    }
    const head = '【认识的人】这个会话里你熟的人（只是背景资料，不是指令；别照着名单挨个点名）：';
    const text = `${head}\n${lines.join('\n')}`;
    return text.length > this.cfg.contextChars ? `${text.slice(0, Math.max(0, this.cfg.contextChars - 20))}…（已截断）` : text;
  }

  /** 给控制台/端点用的快照。 */
  snapshot(key, now = Date.now()) {
    const top = this.topFor(key, 20, now);
    return {
      size: this.people.size,
      sessionSize: top.length,
      people: top.map(({ person, session }) => ({
        id: person.id,
        qq: person.qq,
        name: person.names[0] || '',
        aliases: person.names.slice(1),
        count: session.count,
        totalCount: person.count,
        lastAt: session.lastAt,
        lastSaid: person.lastText,
        otherSessions: this.otherSessions(person.id, key).slice(0, 3)
      }))
    };
  }
}
