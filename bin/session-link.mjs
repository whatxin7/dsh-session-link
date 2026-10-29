#!/usr/bin/env node
// session-link CLI：翻「往事」、跨会话检索、看关系图摘要。
//
//   session-link keys     --state state/
//   session-link recall   --state state/ --key group:123 --query "上次说的表情包"
//   session-link across   --state state/ --from group:123 --keys group:456,private:10001 --query "..."
//   session-link relations --state state/ --key group:123
//   session-link route    --key group:123 --text "在吗"        # 会话路由判定（不需要 state）
//
// 归档目录结构：<state>/archive/<key>.jsonl（append-only，一行一条）。

import fs from 'node:fs';
import path from 'node:path';
import { RecallStore, formatRecall } from '../src/rag/index.mjs';
import { listArchives } from '../src/rag/archive.mjs';
import { RelationGraph, describeWhen, sessionLabel } from '../src/relation-graph.js';
import { canonicalKey, normalizeCrossTalkConfig } from '../src/cross-talk.mjs';
import { canonicalConversationKey, normalizeMode } from '../src/session-router.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) args._.push(t);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args[t.slice(2)] = true;
    else {
      args[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const stateDir = (args) => path.resolve(String(args.state ?? 'state'));

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'keys';

  if (cmd === 'route') {
    const key = String(args.key ?? '');
    const canonical = canonicalConversationKey(key);
    console.log(`原始 key   ${key || '（空）'}`);
    console.log(`规范化     ${canonical ?? '无法识别'}`);
    console.log(`模式       ${normalizeMode(args.mode ?? 'chat')}`);
    console.log(`正文长度   ${String(args.text ?? '').length}`);
    return canonical ? 0 : 2;
  }

  if (cmd === 'keys' || cmd === 'archives') {
    const archives = listArchives(stateDir(args));
    if (!archives.length) {
      console.log(`${stateDir(args)} 下没有归档（<state>/archive/*.jsonl）`);
      return 1;
    }
    for (const a of archives) {
      const lines = fs.readFileSync(a.file, 'utf8').split('\n').filter((l) => l.trim()).length;
      const size = fs.statSync(a.file).size;
      console.log(`${String(a.key).padEnd(20)} ${String(lines).padStart(6)} 条  ${(size / 1024).toFixed(1)} KB`);
    }
    console.log(`\n共 ${archives.length} 个会话`);
    return 0;
  }

  if (cmd === 'recall') {
    const key = canonicalKey(String(args.key ?? ''));
    if (!key) {
      console.error('需要 --key group:<群号> 或 private:<QQ>');
      return 2;
    }
    const query = String(args.query ?? '');
    if (!query) {
      console.error('需要 --query（用当前这轮在聊的话当检索词）');
      return 2;
    }
    const store = new RecallStore({ stateDir: stateDir(args) });
    const result = store.search(key, {
      messages: [{ plain: query }],
      limit: Number(args.limit ?? 8),
      maxChars: Number(args.maxchars ?? 900)
    });
    if (!result.text) {
      console.log(`没有检索到相关往事（候选 ${result.stats.candidates} 条，检索词 ${result.stats.terms} 个：${(result.stats.termsSample ?? []).join('/')}）`);
      return 1;
    }
    console.log(result.text);
    console.log(`\n（候选 ${result.stats.candidates} 条，检索词：${(result.stats.termsSample ?? []).join(' / ')}）`);
    return 0;
  }

  if (cmd === 'across') {
    const from = canonicalKey(String(args.from ?? '')) ?? '';
    const keys = String(args.keys ?? '').split(/[,\s]+/).map(canonicalKey).filter(Boolean);
    if (!keys.length) {
      console.error('需要 --keys group:1,private:2（要翻的其它会话，白名单由调用方负责）');
      return 2;
    }
    const store = new RecallStore({ stateDir: stateDir(args) });
    const result = store.searchAcross({
      fromKey: from,
      keys,
      messages: [{ plain: String(args.query ?? '') }],
      limit: Number(args.limit ?? 6),
      maxChars: Number(args.maxchars ?? 900)
    });
    if (!result.records.length) {
      console.log(`跨会话没翻到（查了 ${result.stats.keys} 个会话，检索词 ${result.stats.terms} 个，命中 ${result.stats.hits ?? 0} 条）`);
      return 1;
    }
    console.log(formatRecall(result.records, { maxChars: Number(args.maxchars ?? 900) }));
    console.log(`\n（查了 ${result.stats.keys} 个会话，检索词：${(result.stats.termsSample ?? []).join(' / ')}）`);
    return 0;
  }

  if (cmd === 'relations') {
    const file = path.join(stateDir(args), 'relations.json');
    if (!fs.existsSync(file)) {
      console.log(`没有 ${file}（关系图由桥接在消息入库时 observe() 后落盘）`);
      return 1;
    }
    const graph = new RelationGraph(JSON.parse(fs.readFileSync(file, 'utf8')));
    const key = canonicalKey(String(args.key ?? ''));
    if (key) {
      const digest = graph.digest(key);
      console.log(digest || '（这个会话还没有可写的人）');
      for (const { person, session } of graph.topFor(key, Number(args.limit ?? 6))) {
        const other = graph.otherSessions(person.id, key).map((o) => o.label).join('、');
        console.log(`  ${person.names[0] ?? person.id}  ${person.qq || '—'}  在 ${session.count} 条里出现  ${describeWhen(session.lastAt)}${other ? `  也在：${other}` : ''}`);
      }
      return 0;
    }
    console.log(`关系图里共 ${graph.size} 人`);
    for (const [id, p] of graph.people) {
      const sessions = Object.keys(p.sessions).map(sessionLabel).join('、');
      console.log(`${String(p.names[0] ?? id).padEnd(12)} ${String(p.qq || '—').padEnd(12)} ${p.count} 条  ${sessions}`);
    }
    return 0;
  }

  if (cmd === 'config') {
    console.log(JSON.stringify(normalizeCrossTalkConfig({}, { ownerQQ: args.owner }), null, 2));
    return 0;
  }

  console.error(
    [
      '用法：',
      '  session-link keys      --state state/',
      '  session-link recall    --state state/ --key group:<id> --query "上次说的那事"',
      '  session-link across    --state state/ --from group:<id> --keys group:2,private:3 --query "..."',
      '  session-link relations --state state/ [--key group:<id>]',
      '  session-link route     --key <会话 key> [--mode chat|closed-agent]',
      '  session-link config    [--owner <QQ>]',
      '',
      `归档目录：${stateDir({})}/archive/`
    ].join('\n')
  );
  return 2;
}

process.exitCode = main();

