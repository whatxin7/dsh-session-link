import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendArchive, archiveFileFor, listArchives, readArchive } from '../src/rag/archive.mjs';
import {
  RecallStore,
  buildQueryTerms,
  chineseBigrams,
  formatRecall,
  scoreRecords
} from '../src/rag/index.mjs';
import { parseAgoMs } from '../src/rag/transcript.mjs';

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-link-'));

test('chineseBigrams / buildQueryTerms：中文按二元切分，英文按词', () => {
  const grams = chineseBigrams('表情包');
  assert.ok(grams.has('表情'));
  assert.ok(grams.has('情包'));
  assert.equal(grams.has('的吧'), false);

  const { terms, weights } = buildQueryTerms({
    messages: [{ plain: '上次说的那个表情包叫什么 sticker 来着' }],
    docs: 3
  });
  assert.ok(terms.length > 0);
  assert.ok(terms.some((t) => t.includes('表情') || '表情包'.includes(t)));
  assert.ok(terms.some((t) => /sticker/i.test(t)));
  assert.ok(weights.size > 0);
});

test('appendArchive / readArchive：往返一致，重复条目只写一次', () => {
  const dir = stateDir();
  const msgs = [
    { t: 1000, m: '今天好累', n: '群友A', u: '20002' },
    { t: 2000, m: '那就早点睡', n: '我', s: 1 }
  ];
  const first = appendArchive(dir, 'group:1', msgs);
  assert.equal(first.written, 2);

  const again = appendArchive(dir, 'group:1', [msgs[0]]);
  assert.equal(again.written, 0, '同一条消息重复归档必须被去重');

  const back = readArchive(dir, 'group:1');
  assert.deepEqual(back.map((r) => r.m), ['今天好累', '那就早点睡']);
  assert.equal(back[1].s, 1);
});

test('archiveFileFor / listArchives：key 会被净化成安全文件名', () => {
  const dir = stateDir();
  const file = archiveFileFor(dir, 'group:123');
  assert.ok(file.endsWith('group_123.jsonl'));
  appendArchive(dir, 'group:123', [{ t: 1000, m: 'x' }]);
  const list = listArchives(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'group:123');
});

test('scoreRecords：命中词的记录得分高，时间新的优先，excludeAfterTs 能挡住"未来"消息', () => {
  const records = [
    { t: 1000, m: '表情包在哪里' },
    { t: 3000, m: '表情包表情包表情包' },
    { t: 5000, m: '完全无关的话' }
  ];
  const hits = scoreRecords(records, { terms: ['表情', '表情包'], limit: 5, now: 6000 });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].m, '表情包表情包表情包');

  const capped = scoreRecords(records, { terms: ['表情'], excludeAfterTs: 4000, now: 6000 });
  assert.equal(capped.some((r) => r.t === 5000), false);
  assert.deepEqual(scoreRecords(records, { terms: [] }), [], '没有检索词就不该瞎给结果');
});

test('RecallStore：热路径 push 后立即可检索，formatRecall 把"我"标出来', () => {
  const dir = stateDir();
  const store = new RecallStore({ stateDir: dir });
  store.push('group:1', [
    { t: 1000, m: '你上次说的那个表情包叫什么来着', n: '群友A', u: '20002' },
    { t: 2000, m: '叫熊猫人洋洋得意', n: '我', s: 1 }
  ]);
  assert.equal(store.size('group:1'), 2);

  const found = store.search('group:1', { messages: [{ plain: '那个表情包叫什么' }], limit: 5, maxChars: 500 });
  assert.ok(found.text.includes('群友A'), '检索结果要带上说话人');
  assert.ok(found.text.includes('表情包'), '命中的旧话要原样带回');
  assert.ok(found.records.length >= 1);

  // 自己的话被检索到时必须带名字标出来，否则模型分不清是谁说的
  const withSelf = formatRecall(
    [{ t: 2000, m: '叫熊猫人洋洋得意', n: '我', s: 1 }],
    { maxChars: 200, selfName: store.selfName }
  );
  assert.ok(withSelf.includes(store.selfName));
  assert.ok(withSelf.includes('熊猫人洋洋得意'));

  const empty = store.search('group:1', { messages: [{ plain: '今天天气怎么样' }], limit: 5 });
  assert.equal(empty.text, '');
});

test('RecallStore：懒加载能读到磁盘上已有的归档', () => {
  const dir = stateDir();
  appendArchive(dir, 'group:77', [{ t: 1000, m: '归档里的老消息：我们在聊显卡', n: '群友B', u: '30003' }]);
  const store = new RecallStore({ stateDir: dir });
  const found = store.search('group:77', { messages: [{ plain: '显卡现在多少钱' }], limit: 5 });
  assert.ok(found.text.includes('显卡'));
  assert.ok(store.topNames('group:77') instanceof Map);
  assert.ok([...store.topNames('group:77').keys()].includes('群友B'));
});

test('formatRecall：空输入返回空串；多条按时间正序拼接', () => {
  assert.equal(formatRecall([]), '');
  const text = formatRecall([{ t: 2000, m: '后一句' }, { t: 1000, m: '前一句' }], { maxChars: 200 });
  assert.ok(text.indexOf('前一句') < text.indexOf('后一句'));
});

test('parseAgoMs：支持 h/d/m 与中文单位，非法输入返回 0', () => {
  assert.equal(parseAgoMs('7d'), 7 * 24 * 3600 * 1000);
  assert.equal(parseAgoMs('3h'), 3 * 3600 * 1000);
  assert.equal(parseAgoMs('30m'), 30 * 60 * 1000);
  assert.equal(parseAgoMs(''), 0);
  assert.equal(parseAgoMs('abc'), 0);
});


