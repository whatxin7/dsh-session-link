import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CROSS_TALK_DEFAULTS,
  CrossTalkStore,
  canonicalKey,
  normalizeCrossTalkConfig
} from '../src/cross-talk.mjs';

const rec = (t, m, { n = '群友A', u = '20002', s = 0 } = {}) => ({ t, m, n, u, s });

test('canonicalKey：只认 group:/private: + 正整数，其余归一化或判无效', () => {
  assert.equal(canonicalKey('group:123'), 'group:123');
  assert.equal(canonicalKey(' private:456 '), 'private:456');
  assert.equal(canonicalKey('group:0'), null);
  assert.equal(canonicalKey('group:abc'), null);
  assert.equal(canonicalKey(''), null);
});

test('normalizeCrossTalkConfig：默认值与区间收敛（maxChars 下限 400，否则正文塞不进去）', () => {
  const c = normalizeCrossTalkConfig({ maxChars: 10, lookbackMs: 1, ambientKeys: 99 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxChars, 400);
  assert.equal(c.lookbackMs, 60_000);
  assert.equal(c.ambientKeys, 8);
  assert.equal(c.privateVisibleInGroups, false, '群聊里默认看不到私聊内容');
});

test('normalizeCrossTalkConfig：管理员私聊默认对其它会话隐身，可显式关闭', () => {
  const hidden = normalizeCrossTalkConfig({}, { ownerQQ: '10001' });
  assert.ok(hidden.hideKeysFromOthers.includes('private:10001'));
  assert.equal(hidden.hideOwnerPrivate, true);

  const open = normalizeCrossTalkConfig({ hideOwnerPrivate: false }, { ownerQQ: '10001' });
  assert.equal(open.hideKeysFromOthers.includes('private:10001'), false);

  const explicit = normalizeCrossTalkConfig({ hideKeysFromOthers: ['group:9', 'bad'] });
  assert.deepEqual(explicit.hideKeysFromOthers, ['group:9'], '非法 key 不该混进隐藏表');
});

test('ingest：同一条重复喂入只收一次，乱序喂入后仍按时间有序', () => {
  const store = new CrossTalkStore();
  assert.equal(store.ingest('group:1', [rec(2000, '第二条'), rec(1000, '第一条')]), 2);
  assert.equal(store.ingest('group:1', [rec(2000, '第二条')]), 0, '重复消息必须去重');

  const list = store.recent('group:1', 10);
  assert.deepEqual(list.map((r) => r.m), ['第一条', '第二条']);
  assert.deepEqual(store.keys(), ['group:1']);
});

test('ingest：非法记录（没有 t / 没有 m / 非法 key）直接丢弃', () => {
  const store = new CrossTalkStore();
  assert.equal(store.ingest('group:1', [{ t: 0, m: 'x' }, { t: 1000, m: '' }, { m: 'x' }]), 0);
  assert.equal(store.ingest('', [rec(1000, 'x')]), 0);
  assert.equal(store.recent('group:999', 5).length, 0);
});

test('ingest：每个会话有上限，超出的从最旧的开始挤掉', () => {
  const store = new CrossTalkStore({ perKeyLimit: 10 });
  for (let i = 0; i < 25; i += 1) store.ingest('group:1', [rec(1000 + i, `m${i}`)]);
  const list = store.recent('group:1', 100);
  assert.equal(list.length, 10);
  assert.equal(list[list.length - 1].m, 'm24');
});

test('userInfo：跨会话身份同一性 —— 同一个号在不同群的不同昵称都能查到', () => {
  const store = new CrossTalkStore();
  store.ingest('group:1', [rec(1000, '在群里说话', { n: '皮蛋' })]);
  store.ingest('private:20002', [rec(2000, '私聊我', { n: '私聊' })]);
  const info = store.userInfo('20002');
  assert.equal(info.userId, '20002');
  assert.deepEqual(info.names.map((n) => n.name), ['皮蛋'], '「私聊」是占位标签，不是名字');
  assert.deepEqual(info.keys.map((k) => k.key).sort(), ['group:1', 'private:20002']);
  assert.equal(info.lastRec.key, 'private:20002');
});

test('digest：没有可写内容时返回空串（绝不返回只有标题的空壳）', () => {
  const store = new CrossTalkStore();
  const cfg = normalizeCrossTalkConfig({});
  assert.equal(store.digest({ key: 'group:1', cfg }), '');
  assert.equal(store.digest({ key: 'bad', cfg }), '');
  assert.equal(store.digest({ key: 'group:1', cfg: { ...cfg, enabled: false } }), '');
});

test('digest：跨会话能看见别的会话，但群聊里不搬运私聊正文', () => {
  const store = new CrossTalkStore();
  const now = 10_000_000;
  store.ingest('group:1', [rec(now - 5000, '群里刚说的', { n: '群友A' })]);
  store.ingest('private:20002', [rec(now - 4000, '私聊里的小秘密', { n: '私聊' })]);
  const cfg = normalizeCrossTalkConfig({ lookbackMs: 60 * 60 * 1000 });

  const inGroup = store.digest({ key: 'group:2', cfg, now });
  assert.ok(inGroup.includes('群里刚说的'), '群里的内容可以看到');
  assert.equal(inGroup.includes('私聊里的小秘密'), false, '群聊里不能出现私聊正文');

  const inPrivate = store.digest({ key: 'private:30003', cfg, now });
  assert.ok(inPrivate.includes('私聊里的小秘密'), '私聊里看私聊是允许的');
});

test('reset：清空后统计归零', () => {
  const store = new CrossTalkStore();
  store.ingest('group:1', [rec(1000, 'x')]);
  store.reset();
  assert.deepEqual(store.keys(), []);
  assert.deepEqual(store.stats(), { keys: 0, records: 0, users: 0 });
});
