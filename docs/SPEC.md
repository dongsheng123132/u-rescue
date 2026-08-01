# 规范

病例格式、采集流程、进库标准、U-King 接入、导流边界。

---

## 1. 一条病例的字段规范

完整定义在 [`schema/case.schema.json`](../schema/case.schema.json)（每个字段带中文说明），
这里只讲**为什么这么定**。

### 分层：机制层长寿，步骤层易腐

| 字段 | 寿命 | 说明 |
|---|---|---|
| `cause` | **长** | 机制。「Windows 上运行中的 exe 被锁住 → npm 清理失败」十年后仍成立 |
| `differential` | **长** | 鉴别诊断。区分逻辑比具体命令活得久 |
| `falsepositives` | **只增不减** | 每误报一次就加一条 |
| `fix.steps` | **短** | 具体命令，上游一改就烂 |
| `verified_on` | — | 记录 steps 是什么时候验的 |

超过 180 天未复核时，**只降级 `fix.steps`，不降级 `cause`**。
所以库越老，机制层越厚 —— 它是随时间增值的那一半。

### 可信度分级（`evidence`）

| 值 | 含义 |
|---|---|
| `field` | 我们在真实机器上让问题复现、按方案修好、验证通过 |
| `reproduced` | 我们复现了问题，方案有效但环境不是真实客户机 |
| `upstream-issue` | 上游 issue 记录，**我们没复现过**，方案是原报告者验证的 |
| `reported` | 只是有人报告，没人验证过。**采集产出的草稿默认是这一档** |

**这个分级是整个库的地基。填错等于拿别人的机器赌。**
网页、skill、CLI 三个出口都会把它显示出来。

### 探针分角色（`diagnose[].role`）

- `precondition` —— 不成立说明这条压根不适用（是不是 Windows、装没装 npm）
- `evidence` —— **只在真出问题时才成立**，只有它能下结论

这条是被真事故逼出来的：第一版 18 条病例报了 16 条「高度怀疑」，因为探针全是前提条件。
**全员告警等于没有告警。** 修完在同一台机器上降到 2 条，且两条都是真的。

拿不出有鉴别力的证据？**就别写 `diagnose`**，让这条只能靠搜报错找到。
编一个查不准的探针，比承认查不出来更坏。

### 安全边界（不可协商）

病例数据**永远不是可执行内容**：

- 探针只能用白名单 `kind`；`cmd_ok` 的可执行名必须命中 `SAFE_BINS`，参数只允许 `[A-Za-z0-9._\-=:/@]`
- `fix.steps[].cmd` 是**给人看的**，CLI 只打印，从不执行
- 非 `read-only` 的步骤必须写 `rollback`（CI 强制）

结论：仓库被投毒、分发链被篡改，最坏也只是给出一条错误建议，不构成任意命令执行。

### 稳定 ID

用语义 ID（`codex.proxy.localhost-elevated-sandbox`）而不是流水号（rustsec 用的是
`RUSTSEC-2016-0001`）。取舍：语义 ID 对 URL 和搜索友好，这对我们更重要；
代价是必须自律 —— **ID 一经发布永不改名**，改名等于换一条病例，旧 URL 的权重全丢。

---

## 2. 采集流程

架构照抄 OSV（google/osv.dev）：源适配器 → 归一化 → **人工过审** → 入库。

```
GitHub (openai/codex)          ─┐
GitHub (anthropics/claude-code) ├─→ harvest.mjs ─→ inbox/*.json ─→ 人工补解法+验证 ─→ cases/
U-King bug 库（私有，强制脱敏） ─┘      （草稿）        （这一步不能自动化）
```

```bash
node scripts/harvest.mjs                        # 全部公开源
node scripts/harvest.mjs --source codex --limit 30
node scripts/harvest.mjs --source uking         # 私有，需 GITHUB_TOKEN
node scripts/harvest.mjs --since 2026-07-01 --json
```

### 铁律：harvest 永远不写 `cases/`

自动抓来的 issue 里通常只有症状、没有验证过的解法。直接当病例发出去，等于告诉用户
「这里有答案」然后让他扑空 —— **比没有这条更坏**，而且一次性毁掉本库最值钱的东西。

草稿必须由人补上 `cause` / `fix.steps` / `fix.verify`，验证过、把 `evidence` 从
`reported` 改成 `reproduced` 或 `field`，才准移进 `cases/`。
**补不出解法的就让它留在 inbox 里。**

### 去重靠 `aliases`

照抄 rustsec/advisory-db 的做法。每条草稿带 `codex#30538` 这样的 alias，
采集时先比对 `cases/` 和 `inbox/` 里已有的全部 alias。
没有它，同一个上游 issue 每跑一次采集就会被抓成一条新病例。CI 也会查 alias 重复。

### 分类器

强信号（错误码、`command not found`、`certificate`、`装不上`…）命中一条即收；
弱信号（`proxy`、`PATH`、`WSL`…）要凑够两条；标题是功能请求形状的直接排除。

第一版没分强弱，25 条里放行 9 条，混进来一堆功能请求。现在同样 25 条放行 2 条。
**分类器宁可漏，不可滥** —— 漏了下次采集还能捞回来，滥了是把噪音塞给人工。

### 私有源（U-King bug 库）

`dongsheng123132/u-king-mini` 的 `bug-report` issue 含真实客户机信息。采集时：

1. 整份过 `redactDeep()`（key / token / 邮箱 / 用户名路径 / 内网 IP / 手机号 / UUID）
2. 草稿强制带 `_needs_scrub` 标记
3. **人工逐字复核后才准公开**

绝不把未经复核的客户日志变成公开病例。

---

## 3. 扩展到新工具

加一个工具 = 改两处，没有第三处：

1. `schema/case.schema.json` 的 `tool` 枚举加一个值
2. `scripts/harvest.mjs` 的 `SOURCES` 加一条记录（repo / tool / labels / 是否私有）

然后 `cases/<新工具>/` 下放病例即可。网页、skill、CLI、U-King feed 全部自动跟上。

已就绪：`codex`、`claude-code`、`shared`。
枚举里预留了：`openclaw`、`hermes`。

---

## 4. U-King 接入规范

U-King 里已经有一条热下发链（`advice.rs`）：拉服务器 JSON、白名单只读探针、
`version` 更大才采用、不发 exe。**这里不是给 U-King 加新机制，是给已有机制换个更厚的源。**

```bash
node scripts/build-uking-feed.mjs
```

出两份，成本不同，别混着谈：

### A. `advice-compat.json` —— 零改动

严格贴合 `advice.rs` 现有格式和现有三种探针（`tool_installed` / `tool_missing` /
`file_exists`）。U-King **一行代码都不用改**，把下发 URL 指过来就行。

代价：探针表达力弱，**当前 18 条里只有 2 条能映射进来**。

### B. `rescue-feed.json` —— 完整

含鉴别诊断、误报说明、可回滚步骤、`stale` 标记。要用它，`advice.rs` 需要补这几种只读探针：

| 探针 | 作用 | 参考实现 |
|---|---|---|
| `env_present` | 环境变量存在 | `lib/probes.mjs` 同名分支 |
| `env_contains` | 环境变量含某字面子串（不是正则，不做求值） | 同上 |
| `env_nonascii` | 环境变量含非 ASCII（中文路径） | 同上 |
| `path_duplicates` | PATH 上有多个同名命令（命令撞名） | 同上 |
| `npm_prefix_on_path` | npm 全局目录在不在 PATH 上 | 同上 |
| `http_reach` | 能否连通某地址（**必须默认关，显式开启才跑**） | 同上 |

每个都是纯只读、不到 20 行。补完覆盖从 2 条到 8 条（即全部带证据探针的病例）。

`build-uking-feed.mjs` 每次都会打印掉了哪几条、为什么 —— **不静默截断**，
否则「下发了 N 条」会被读成「覆盖了全部」。

### 客户端应当遵守

- `stale: true` 的病例**只展示、不提供「一键修」按钮**
- `fix.auto !== true` 的病例不提供自动执行
- 展示时必须带上 `evidence` 和 `falsepositives`，让用户知道这条有多可信、什么时候是误报

---

## 5. 导流边界

`uking` 字段是病例里**唯一**允许提 U-King 的地方，写法有硬约束：

- 只写「U-King 能替你做掉这一步」这类事实，不写营销语
- 病例本身必须给出**不依赖 U-King 也能走通**的完整方案，`uking` 只是省事选项
- 没有对应能力的病例**不写这个字段**，别硬塞

理由很直接：开源库一旦读起来像软文，信誉先没了，导流也就跟着没了。
当前 18 条里 9 条带 `uking` 字段，`git grep '"uking":'` 一行就能数清全部广告位。

站点页脚和 README 各有一处 U-King 链接，同样是低调署名，不是横幅。

---

## 6. 发布链路

```
cases/*.json  ──→ build-site.mjs   ──→ dist/site/     ──→ u-claw.org.cn/rescue/   （小白入口，GEO）
              ├─→ build-skill.mjs  ──→ dist/skill/    ──→ GitHub / clawhub.ai / skillhub.cn
              ├─→ build-uking-feed ──→ dist/uking/    ──→ U-King 热下发
              └─→ npx u-rescue                        ──→ 开发者 / AI / 远程排障
```

四个出口，一份数据。改一处，四处同步。

顺序建议：**先把站点挂起来**（小白不逛 GitHub，他们搜索或问 AI），
再开公开仓库，最后才上技能市场。

---

## 7. 前人参考

设计时对照过的四个成熟范式，以及各自抄了什么：

| 项目 | 抄了什么 |
|---|---|
| [SigmaHQ/sigma](https://github.com/SigmaHQ/sigma) | `falsepositives` 字段；一份规则编译到多个后端 |
| [rustsec/advisory-db](https://github.com/rustsec/advisory-db) | `aliases` 交叉引用；一条一文件 + CI 校验 + PR 入库 |
| [google/osv.dev](https://github.com/google/osv.dev) | 多源自动 ingestion → 归一化 → 审核的架构 |
| [github/advisory-database](https://github.com/github/advisory-database) | 「自动收 + 人工过」两段式 |

没抄的：流水号 ID（我们要 URL 友好）、YAML（JSON 对前端和 AI 更省事）、
以及任何形式的「客户端静默拉取并执行远程规则」。
