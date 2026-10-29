import test from 'node:test';
import assert from 'node:assert/strict';
import { RELATION_DEFAULTS, RelationGraph, describeWhen, normalizeRelationConfig, sessionLabel } from '../src/relation-graph.js';

// 注意：prune() 会按 maxAgeMs（默认 30 天）淘汰，所以夹具时间必须贴近现在，
// 否则 observe() 返回 1 条、图谱里却是空的（这正是第一版测试踩的坑）。
const now = Date.now();
const rec = (sender, text, { uin = '', at = now - 60_000 } = {}) => ({ sender, text, uin, at });

test('normalizeRelationConfig：区间收敛 + 默认值', () => {
  const c = normalizeRelationConfig({ maxPeople: 1, maxAliases: 99 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxPeople, 20, 'maxPeople 下限 20');
  assert.equal(c.maxAliases, 10);
  assert.equal(normalizeRelationConfig({ enabled: false }).enabled, false);
  assert.equal(RELATION_DEFAULTS.maxPeople, 400);
});

test('sessionLabel / describeWhen：给人看的短标签', () => {
  assert.equal(sessionLabel('group:123'), '群123');
  assert.equal(sessionLabel('private:456'), '私聊456');
  assert.equal(sessionLabel(''), '未知会话');
  assert.equal(describeWhen(now - 3 * 86_400_000, now), '3 天前');
  assert.equal(describeWhen(0), '还没说过话');
});

test('observe：记人、记会话、记最近一句；自己的话不进关系图谱', () => {
  const g = new RelationGraph();
  const touched = g.observe('group:1', [
    rec('皮蛋', '我先去吃饭', { uin: '20002' }),
    rec('我', '去吧', { uin: '10001' })
  ]);
  assert.equal(touched, 1, '自己说的话不该算进关系图谱');

  const top = g.topFor('group:1', 5);
  assert.equal(top.length, 1);
  assert.equal(top[0].person.qq, '20002');
  assert.equal(top[0].person.lastText, '我先去吃饭');
});

test('observe：改名后别名按最新在前，且同一人不重复计数成两个人', () => {
  const g = new RelationGraph();
  g.observe('group:1', [rec('皮蛋', 'a', { uin: '20002', at: now - 120_000 })]);
  g.observe('group:1', [rec('蛋总', 'b', { uin: '20002', at: now - 60_000 })]);
  const [entry] = g.topFor('group:1', 5);
  assert.equal(entry.person.names[0], '蛋总');
  assert.ok(entry.person.names.includes('皮蛋'));
  assert.equal(g.people.size, 1);
});

test('observe：没有 QQ 号时按名字归并（退路），空名字直接跳过', () => {
  const g = new RelationGraph();
  assert.equal(g.observe('group:1', [{ sender: '', text: 'x', at: now - 1000 }]), 0);
  g.observe('group:1', [rec('无名氏', '路过', { at: now - 60_000 })]);
  assert.equal(g.people.size, 1);
  assert.ok([...g.people.keys()][0].startsWith('name:'));
});

test('otherSessions：同一号在哪些别的会话出现过（跨会话身份）', () => {
  const g = new RelationGraph();
  g.observe('group:1', [rec('皮蛋', 'a', { uin: '20002', at: now - 120_000 })]);
  g.observe('private:20002', [rec('皮蛋', 'b', { uin: '20002', at: now - 60_000 })]);
  const other = g.otherSessions('qq:20002', 'group:1');
  assert.equal(other.length, 1);
  assert.equal(other[0].key, 'private:20002');
  assert.equal(other[0].label, '私聊20002');
  assert.equal(other[0].count, 1);
  assert.deepEqual(g.otherSessions('qq:99999', 'group:1'), [], '不认识的人返回空数组');
});

test('prune：超龄的人会被清掉', () => {
  const g = new RelationGraph(null, { maxAgeMs: 60_000 });
  g.observe('group:1', [rec('皮蛋', 'a', { uin: '20002', at: now - 30_000 })]);
  assert.equal(g.people.size, 1);
  assert.equal(g.prune(now + 30 * 86_400_000), 1);
  assert.equal(g.people.size, 0);
});

test('digest / snapshot：没有内容时返回空串；有内容时带名字与最近动态', () => {
  const g = new RelationGraph();
  assert.equal(g.digest('group:1'), '');
  g.observe('group:1', [rec('皮蛋', '我先去吃饭', { uin: '20002' })]);
  const digest = g.digest('group:1');
  assert.ok(digest.includes('皮蛋'));
  const snap = g.snapshot('group:1');
  assert.ok(snap && typeof snap === 'object');
});

test('toJSON / load：状态能持久化再读回', () => {
  const g = new RelationGraph();
  g.observe('group:1', [rec('皮蛋', 'a', { uin: '20002' })]);
  const state = g.toJSON();
  assert.equal(state.v, 1);
  const g2 = new RelationGraph(state);
  assert.equal(g2.people.size, 1);
  assert.equal(g2.topFor('group:1', 5)[0].person.qq, '20002');
});
