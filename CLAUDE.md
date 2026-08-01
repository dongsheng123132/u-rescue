# CLAUDE.md

给 Claude Code 的项目说明。**本目录是完全独立的仓库**，不属于 U-Claw / U-King 工作区，
不要从父目录继承上下文，也不要去改那边的代码。

## 这是什么

`dongsheng123132/u-rescue`（公开，Apache-2.0）——
AI 编程工具（Codex / Claude Code）环境故障的**病例库**：症状 → 机制 → 可回滚的修复 → 验证。

一份 `cases/*.json` 出四个消费端：中文网页、AI skill、U-King 热下发、命令行。

```
cases/*.json ──→ build-site       ──→ dist/site/    ──→ u-claw.org.cn/rescue/（小白入口，GEO）
             ├─→ build-skill      ──→ dist/skill/   ──→ GitHub / clawhub.ai / skillhub.cn
             ├─→ build-uking-feed ──→ dist/uking/   ──→ U-King 热下发
             └─→ npx u-rescue                       ──→ 开发者 / AI / 远程排障
```

## 常用命令

```bash
node scripts/validate.mjs      # 病例校验（CI 门禁，必须绿）
node scripts/smoke.mjs         # CLI 冒烟测试（真跑，不 mock）
node scripts/harvest.mjs       # 从上游采集候选 → inbox/
node scripts/build-site.mjs    # 出中文静态网页
node scripts/build-skill.mjs   # 出 SKILL.md / AGENTS.md / manifest.json
node scripts/build-uking-feed.mjs  # 出 U-King 下发 JSON（两种格式）
node bin/u-rescue.mjs doctor   # 本机只读体检
```

**零依赖，没有 `npm install` 这一步。** 这是刻意的：这个工具要能在**已经坏掉的机器**上跑起来，
所以 `path_has` 用纯 Node 解析 PATH 而不是 spawn `where`/`which`。别引任何第三方包。

## 不可协商的规则（每条都是踩过坑换来的）

**1. 病例数据永远不是可执行内容。**
探针只能用白名单 `kind`；`cmd_ok` 的可执行名必须命中 `lib/probes.mjs` 的 `SAFE_BINS`，
参数只允许 `[A-Za-z0-9._\-=:/@]`。`fix.steps[].cmd` 是**给人看的**，CLI 只打印从不执行。
仓库被投毒、下发链被篡改，最坏也只是给出一条错误建议，不构成 RCE。**这条比多支持几种自动修复重要得多。**

**2. 探针分 precondition / evidence，只有 evidence 能下结论。**
第一版 18 条病例报了 16 条「高度怀疑」，因为探针写的全是「是不是 Windows」这种谁都成立的前提。
**全员告警等于没有告警。** 修完在同一台机器上降到 2 条，且两条都是真的。
拿不出有鉴别力的证据？**就别写 `diagnose`**，让这条只能靠搜报错找到。
编一个查不准的探针，比承认查不出来更坏。CI 会挡。

**3. `evidence` 字段不许灌水。**
`field` = 我们在真实机器上让问题复现、按方案修好、验证通过。
只是网上看来的填 `upstream-issue` 并附出处。**这个分级是全库的地基，填错等于拿别人机器赌。**

**4. 会改机器的步骤必须写 `rollback`。** CI 强制。

**5. 写了探针就必须写 `falsepositives`。**
探针一定会在某些正常机器上亮，区别只在于你有没有承认。这个字段只增不减。

**6. harvest 永远不写 `cases/`，只写 `inbox/`。**
自动抓来的 issue 通常只有症状、没有验证过的解法。直接当病例发出去等于让用户扑空，
**比没有这条更坏**。补不出解法的就让它留在 inbox 里。

**7. 私有源（U-King bug 库）采来的东西绝不自动公开。**
强制 `redactDeep` → 标 `_needs_scrub` → `.gitignore` 挡住 `inbox/uking-*.json`。
必须人工逐字复核。

**8. ID 一经发布永不改名。**
用的是语义 ID（对 URL 和搜索友好），代价就是必须自律。改名 = 换一条病例，旧 URL 权重全丢。

**9. 不静默截断。**
`build-uking-feed` 掉了哪几条、为什么，每次都打印。
`doctor` 会说清「能查 N 条、另 M 条查不出来」。
否则「没发现问题」会被读成「机器没事」，那是骗人。

## 随时间增值的部分（设计意图，别改坏）

| 层 | 寿命 | 说明 |
|---|---|---|
| `cause` | **长** | 机制。「Windows 上运行中的 exe 被锁住」十年后仍成立 |
| `differential` | **长** | 鉴别诊断。条目谁都能抄，鉴别关系随规模平方增长 |
| `falsepositives` | **只增不减** | 每误报一次加一条 |
| `fix.steps` | **短** | 具体命令，上游一改就烂 |

超过 180 天未复核时**只降级 `fix.steps`，不降级 `cause`** —— 所以库越老，机制层越厚。

## 导流边界

`uking` 字段是病例里**唯一**允许提 U-King 的地方：只写「U-King 能替你做掉这一步」这类事实，
不写营销语；病例本身必须给出不依赖 U-King 也能走通的完整方案；没有对应能力就不写这个字段。

`git grep '"uking":' cases` 一行能数清全部广告位。
**开源库一旦读起来像软文，信誉先没了，导流也跟着没了。**

## 站在谁的肩膀上

| 项目 | 抄了什么 |
|---|---|
| SigmaHQ/sigma | `falsepositives`；一份规则编译到多后端 |
| rustsec/advisory-db | `aliases` 交叉引用；一条一文件 + CI + PR 入库 |
| google/osv.dev | 多源 ingestion → 归一化 → 人工审核 |

没抄：流水号 ID（要 URL 友好）、YAML（JSON 对前端和 AI 更省事）、
任何形式的「客户端静默拉取并执行远程规则」。

## 与 U-King 的关系

**这个仓库不依赖 U-King，U-King 订阅这个仓库。**
接入方式见 `docs/SPEC.md` 第 4 节。要给 U-King 改代码，去它自己的仓库改，别在这里动。

完整规范：[`docs/SPEC.md`](docs/SPEC.md)。贡献规范：[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)。
