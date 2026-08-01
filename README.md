# U-Rescue · AI 工具故障病例库

> Codex / Claude Code 装不上、连不上、报错了怎么修。
> 每条病例都写清楚：**什么症状 → 为什么 → 怎么修 → 怎么撤回 → 怎么验证真修好了。**

国内用 AI 编程工具，卡住的往往不是模型，是环境：梯子、杀软、PATH、中文路径、npm 镜像、WSL。
这些坑散落在几万条 GitHub issue 和各种过期博客里，小白根本捞不出来。这个库把它们整理成结构化病例。

**现在有 18 条病例。** 全部标注了来源可信度 —— 我们真机验过的，和只是上游 issue 记录的，
在这里是**两种东西**，不会混着卖给你。

---

## 直接用（不用装，不会动你的机器）

```bash
# 只读体检：看看这台机器命中了哪些已知问题
npx u-rescue doctor

# 把报错原文整段粘进来搜
npx u-rescue search "self-signed certificate detected"

# 看某条病例的完整修复方案
npx u-rescue show codex.proxy.localhost-elevated-sandbox

# 给脚本/AI 调用
npx u-rescue doctor --json
```

需要 Node 18+。**这个工具只诊断，不替你执行修复** —— 步骤打印出来，你看懂了自己敲。

网页版（不用命令行）：<https://u-claw.org.cn/rescue/>

---

## 病例从哪来（收集机制）

```
GitHub (openai/codex)           ─┐
GitHub (anthropics/claude-code)  ├─→ harvest ─→ inbox/ 草稿 ─→ 人工补解法+验证 ─→ cases/
我们自己的客户机排障（强制脱敏） ─┘                          ↑ 这一步不能自动化
```

```bash
npm run harvest                              # 从上游 issue 采集候选
npm run harvest -- --source codex --limit 30
```

**采集永远不直接写进病例库。** 抓来的 issue 通常只有症状、没有验证过的解法 ——
直接当病例发出去等于让用户扑空，比没有这条更坏。草稿必须由人补上机制和方案、
验证过，才移进 `cases/`。补不出解法的就留在 inbox 里。

分类器宁可漏不可滥：强信号（错误码、`command not found`、`装不上`）命中一条即收，
弱信号要凑够两条，功能请求形状的标题直接排除。实测 25 条上游 issue 放行 2 条。

去重靠 `aliases`（`codex#30538` 这种），CI 会查重复 —— 没有它，同一个 issue
每次采集都会被抓成新病例。

## 它为什么值得信

这类库最容易变成「一堆看着有理、实则没人验证过的偏方」。我们用四条硬约束挡住：

**① 分清「我们验过」和「网上说的」。**
每条病例必填 `evidence` 字段：`field`（我们在真实机器上验过）/ `reproduced`（我们复现过）/
`upstream-issue`（上游 issue 记录，我们没复现）/ `reported`（只是有人报告）。
网页和 skill 里都会把这个标出来。**没验过就说没验过。**

**② 方案会过期，所以每条都带验证日期。**
超过 180 天没复核的病例，在网页和 AI skill 里自动降级成「当参考读，别闭眼执行」。
上游天天在改，一年前的命令可能已经害人。

**③ 诊断只读，且不做算命式告警。**
第一版跑出来 18 条病例报了 16 条「高度怀疑」—— 因为探针写的全是「是不是 Windows」
「装没装 npm」这种谁都成立的**前提条件**。全员告警等于没有告警。
现在探针分 `precondition`（前提）和 `evidence`（真有鉴别力的证据），**只有证据能下结论**；
拿不出证据的病例老实标成「只能靠搜报错找到」，并在体检结果里如实说明覆盖了多少条。

**④ 每个会改机器的步骤都必须写撤回办法。**
这是 CI 强制的，写了 `risk: low/medium/high` 却没写 `rollback` 的 PR 直接挂。

**⑤ 承认误报。**
写了探针的病例必须写 `falsepositives`（这个字段抄自 [SigmaHQ/sigma](https://github.com/SigmaHQ/sigma)）：
什么情况下这条会误判。探针一定会在某些正常机器上亮，区别只在于你有没有承认。
**这个字段只增不减 —— 每误报一次加一条，是本库随时间增值最快的部分。**

**⑥ 鉴别诊断。**
症状像的病例之间互相链接，写清「区别是什么」和「哪个观察能一刀切开」。
用户看到「连不上」根本分不清是代理、证书还是端点不兼容，这一段就是替他分开的。
条目谁都能抄，鉴别关系随规模平方增长，抄不走。

安全上还有一条边界：**探针永远不接受可执行内容**。病例 JSON 里只能用白名单探针，
`cmd_ok` 的可执行名必须命中 `SAFE_BINS`。就算这个仓库被投毒，最坏也只是给出一条错误建议，
不构成任意命令执行。

---

## 怎么贡献一条病例

一条病例就是一个 JSON 文件，放在 `cases/<工具>/` 下。没有构建步骤，没有依赖。

```bash
git clone https://github.com/dongsheng123132/u-rescue
cd u-rescue
cp cases/codex/update-eperm-leftover.json cases/codex/我的新病例.json
# 改完跑校验
node scripts/validate.mjs
```

校验会检查：字段合法、ID 不重复、非只读步骤写了撤回、探针在白名单里、
`auto: true` 的病例指明了对应动作、声称真机验证的写清了环境。

**我们最想要的不是「又一个报错」，是「这个报错的根因和验证过的解法」。**
只有报错没有解法的，欢迎开 issue，但它不会直接进病例库。

详见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)，
完整规范（字段定义、采集流程、接入方式、导流边界）见 [docs/SPEC.md](docs/SPEC.md)。

## 站在谁的肩膀上

这类结构化知识库有成熟范式，我们照着抄而不是自创：

| 项目 | 抄了什么 |
|---|---|
| [SigmaHQ/sigma](https://github.com/SigmaHQ/sigma) | `falsepositives` 字段；一份规则编译到多个后端 |
| [rustsec/advisory-db](https://github.com/rustsec/advisory-db) | `aliases` 交叉引用；一条一文件 + CI 校验 + PR 入库 |
| [google/osv.dev](https://github.com/google/osv.dev) | 多源自动 ingestion → 归一化 → 人工审核 |
| [github/advisory-database](https://github.com/github/advisory-database) | 「自动收 + 人工过」两段式 |

---

## 生成产物

同一份病例 JSON 出三种东西，改一处三处同步：

| 命令 | 产物 | 给谁用 |
|---|---|---|
| `npm run build:site` | `dist/site/` 静态中文网页 + `sitemap.xml` + `cases.json` | 小白（搜索/AI 问答进来的人） |
| `npm run build:skill` | `dist/skill/SKILL.md` + `AGENTS.md` + `manifest.json` | 装进 Claude Code / Codex，或上架技能市场 |
| `npm run build:uking` | `dist/uking/` 热下发 JSON（两种格式） | U-King 图形界面版 |
| `npx u-rescue` | 命令行只读诊断 | 开发者、远程排障、AI 调用 |

网页带 JSON-LD 结构化数据（`TechArticle` + `Question/Answer`），
方便被搜索引擎和 AI 助手直接引用 —— 因为遇到问题的人会去问 AI，不会来逛 GitHub。

---

## 项目状态与期望值

**这首先是我们自己维护的规则库，公开出来是因为公开没坏处、还能帮到人。**

- 我们**不承诺**响应时间、不承诺合并你的 PR、不承诺路线图。
- 有价值的病例我们会合，写得不清楚或没验证过的会请你补，补不上就先放 issue 里。
- 如果哪天它长期没更新，就是没更新 —— 病例上的验证日期会诚实地告诉你这件事，
  不需要看 commit 记录去猜。

这样说清楚，是为了不让任何人产生「提了 issue 就该有人管」的错误预期。

---

## 关于 U-King

这个病例库开源免费，和任何商业产品都不绑定，clone 走随便用。

如果你不想自己一条条对着改，[U-King](https://u-king.org) 是我们做的图形界面版：
一键装好 Claude Code / Codex，装机流程内置了这里大部分坑的绕过方案，出问题能一键体检。
病例里凡是 U-King 能替你做掉的，都写在 `uking` 字段里，一眼能看出来那条是不是广告。

**不用 U-King 完全不影响这个库的使用** —— 上面的 `npx u-rescue` 是完整功能，不阉割。

---

## 许可

Apache-2.0。病例内容和代码都是。拿去改、拿去用、拿去做你自己的产品，都行。
