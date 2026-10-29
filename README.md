# dsh-session-link

> **一句话**：让"一个 QQ 会话一个 agent 会话"不再等于失忆 —— 路由、近况、往事、关系，四层各管一件事。
>
> 从 `qq-bridge` 抽出的独立项目，对应成本统计里 **「联通会话 + 群聊私聊行为调优」** 这条线（也是这套东西里最花 token 的一段：她在线聊天占 47.3%）。

---

## 为什么需要"联通"

DSH 是**一个会话一个上下文**。接进 QQ 之后，每个群、每个私聊都是独立的窗口，于是立刻出现四种"她明明该知道却不知道"：

| 症状 | 缺的是哪一层 |
|---|---|
| 私聊里被问「你刚才在群里说的那个」，回"我这边看不到别的群" | **跨会话近况**（cross-talk） |
| 同一句"我们上次聊到哪了"，三个月前的结论翻不出来 | **长期往事**（RAG） |
| 群里叫"皮蛋"的人私聊叫"老王"，她当成两个人 | **关系图**（relation-graph） |
| 换个群之后语气、称呼、能不能发表情全变了 | **会话路由 + 模式**（router） |

四层刻意不合并成一个"记忆库"：它们的**过期策略完全不同** —— 近况按小时过期，往事永不过期，关系按天淡化，路由是即时判定。混在一起就会出现"三天前的寒暄被当成关系亲密"这种事。

## 安装

### 三种装法（挑一个）

```bash
# 1) 零安装，先跑一次试试（需要 node ≥ 20 和 git）
npx github:whatxin7/dsh-session-link keys --state state/

# 2) 装成全局命令（日常用这个）
npm i -g github:whatxin7/dsh-session-link

# 3) 想改代码 / 跑测试
git clone https://github.com/whatxin7/dsh-session-link.git
cd dsh-session-link && npm install && npm test
```

> ⚠️ npm 上的 `dsh-session-link` 这个名字**已被他人占用**（PwnKY 的 dsh:// 深链工具，不是本项目），所以不要 `npm i dsh-session-link`。
> 本项目只通过 `github:whatxin7/...` 或源码安装；以后发 npm 会用 `@whatxin7/...` scope。


```bash
git clone https://github.com/whatxin7/dsh-session-link.git
cd dsh-session-link
node --test        # 60 个用例
```

无依赖，Node ≥ 20。所有数据都是本地 append-only 文本，坏了只损失一行。

## 用法

```bash
# 有哪些会话的归档
session-link keys --state state/

# 在这个会话里翻往事（用当前这轮的话当检索词）
session-link recall --state state/ --key group:123 --query "上次说的那个表情包叫什么"

# 跨会话翻：从别的窗口里找
session-link across --state state/ --from group:123 --keys private:20002 --query "显卡那事"

# 关系图：这个会话里都有谁、还在哪儿见过
session-link relations --state state/ --key group:123

# 会话 key 规范化 + 模式判定（不读磁盘）
session-link route --key group:123 --mode closed-agent
```

真实输出：

```
· 10-29 15:54 群友A：你上次问的那个表情包叫熊猫人洋洋得意

（候选 2 条，检索词：那个表情 / 情包叫 / 个表 / 表情 / 情包）
```

## 四层各自的取舍

### 1. 会话路由 `session-router.mjs`

`canonicalConversationKey()` 把 `group:0123`、`group:123`、`private:000456` 统一成 `group:123`；`migrateLegacyMode()` 兼容老配置里的模式写法。路由本身是纯函数：同一个 key 永远映射到同一个 agent 会话，**不允许"这次分到一个新会话"** —— 那等于每次醒来都失忆。

### 2. 跨会话近况 `cross-talk.mjs`

- 三份索引：按会话、按全局时间、按人（身份同一性）；
- 去重只查"同 key 尾部 12 条"（归档已去过重，这里防启动播种与热路径重叠）；
- **隐私边界分两条线**：内容（群聊里默认看不到私聊正文）、身份（群里仍知道"这人和我私聊过"）。混成一条就会二选一翻车；
- 管理员私聊**默认对其它会话隐身** —— 那里是操作者本人的原话，被复述出去不可撤销。

### 3. 长期往事 `rag/`

- 存储：append-only JSONL，一行一条，坏一个字节只损失一行（对比 SQLite 一坏全丢）；
- 检索：中文按 3~4 字词（高精度）+ bigram（兜底召回）+ 英文 token，配 IDF 过滤高频碎片；
- **df=0 的词压到最低权重**：用户这句话里的词在历史里可能一个都没有，纯 IDF 会把它们当"最稀有"顶到前面，结果必然 0 命中；
- 打分后再做**多样性限制**（同一人最多 2 条）—— 否则【往事】6 条全是自己说过的话，读起来像照镜子。

### 4. 关系图 `relation-graph.js`

记"这个人在哪些会话出现过、换过几个名字、多少条、多久没说话"。

- 不记内容摘要（那是 cross-talk 的活）；
- 自己的话不进图 —— 否则"你"会变成一个群友；
- 按 `maxAgeMs`（默认 30 天）淡化，按 `maxPeople` 淘汰，落盘 `state/relations.json`。

## 数据结构

```
state/
  archive/
    group_123.jsonl        # 一行一条 {t,m,n,u,s}
    private_20002.jsonl
  relations.json           # {v:1, updatedAt, people:{...}}
```

归档记录：`t` 时间戳、`m` 正文、`n` 发送者名、`u` QQ 号、`s` 是否自己说的（1/0）。

`rag/transcript.mjs` 还能直接解析 DSH 的会话日志（zstd 帧 + JSONL），用于把历史会话回灌成归档。

## 作为库用

```js
import { SessionRouter, canonicalConversationKey } from 'dsh-session-link/router';
import { CrossTalkStore, normalizeCrossTalkConfig } from 'dsh-session-link/cross-talk';
import { RecallStore } from 'dsh-session-link/rag';
import { appendArchive } from 'dsh-session-link/archive';

appendArchive('state', 'group:123', [{ t: Date.now(), m: '在吗', n: '群友A', u: '20002' }]);

const recall = new RecallStore({ stateDir: 'state' });
const { text } = recall.search('group:123', { messages: [{ plain: '刚才说到哪了' }] });

const crossTalk = new CrossTalkStore();
crossTalk.ingest('group:123', [{ t: Date.now(), m: '在吗', n: '群友A', u: '20002' }]);
const digest = crossTalk.digest({ key: 'group:123', cfg: normalizeCrossTalkConfig({}, { ownerQQ: '10001' }) });
```

## 已知边界

- 检索是**内存线性扫描**：单会话超过约 20 万条、或一次 search 超过 200ms 时才值得换 FTS5（接口不用动）。
- 不做向量检索：中文短句 + IDF 在这个规模上足够，向量库的运维成本换不来相应收益。
- 跨会话检索的**白名单由调用方负责**（这一层只管检索，不管谁有权看谁）。
- 关系图不推断"关系亲疏"的分值，只给事实（条数、最近时间、共同会话）；怎么用是提示词的事。

## 项目家族

| 项目 | 对应成本条目 |
|---|---|
| **dsh-session-link**（本仓库） | 联通会话 / 行为调优 |
| [dsh-token-meter](https://github.com/whatxin7/dsh-token-meter) | 用量与成本核算 |
| [dsh-qq-access](https://github.com/whatxin7/dsh-qq-access) | 好友 / 白名单 / 权限 |
| [dsh-qq-voice](https://github.com/whatxin7/dsh-qq-voice) | 语音 / 唱歌 / 音色 |
| [dsh-qq-stickers](https://github.com/whatxin7/dsh-qq-stickers) | 表情包 / 斗图 |
| [dsh-mcp-safe-tools](https://github.com/whatxin7/dsh-mcp-safe-tools) | 能力扩展（视觉 / 搜索 / 语感） |
| [dsh-persona-kit](https://github.com/whatxin7/dsh-persona-kit) | 人格 / 角色卡 |
| [qq-bridge](https://github.com/whatxin7/qq-bridge) | 桥接内核（旗舰仓库） |

## English

Cross-session continuity for a QQ ↔ DSH agent in four independent layers: deterministic session routing, short-window cross-talk digests with split content/identity privacy boundaries, append-only archive retrieval with IDF-filtered Chinese n-grams, and a cross-session relation graph. 60 offline tests.

## License

MIT © whatxin7


