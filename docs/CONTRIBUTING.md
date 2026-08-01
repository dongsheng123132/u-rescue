# 贡献一条病例

## 一条好病例长什么样

不是「我遇到了 X 报错」，而是：

> **什么症状** → **为什么会这样（机制，不是「可能是环境问题」）** → **怎么修（每步的风险和撤回办法）** → **怎么证明真修好了**

「怎么证明真修好了」这一条最常被省略，也最重要。命令退出码是 0 不代表问题解决了。

## 动手

```bash
git clone https://github.com/dongsheng123132/u-rescue
cd u-rescue          # 零依赖，不用 npm install
cp cases/codex/update-eperm-leftover.json cases/codex/my-case.json
$EDITOR cases/codex/my-case.json
node scripts/validate.mjs
```

字段定义看 [`schema/case.schema.json`](../schema/case.schema.json)，里面每个字段都有中文说明。

## 几条会被打回的写法

**「evidence 填 field 但你其实没验过」。**
`field` 的意思是你在一台真实机器上，让问题复现、按方案修好、并且验证通过了。
只是在网上看到的，填 `upstream-issue` 并附上出处链接。这个区分是整个库可信度的地基，
填错等于把别人的机器押上去。

**「修复步骤会改机器却没写 rollback」。**
CI 直接挂。想不出怎么撤回，说明这步风险你自己也没评估清楚。

**「探针写的是前提条件」。**
`role: precondition` 是「不成立就说明这条不适用」（是不是 Windows、装没装 npm）；
`role: evidence` 是「只有真出问题时才成立」。
如果你的病例拿不出一条有鉴别力的证据，**就别写 diagnose**，让它只能靠搜报错找到。
编一个查不准的探针，比承认查不出来更坏 —— 我们在第一版上栽过这个跟头：
18 条病例报了 16 条「高度怀疑」，等于算命。

**「fix.auto 填 true 但没写 uking_action」。**
`auto` 的意思是「这个修复能作为白名单动作被自动执行」，那就必须指明是哪个动作。
拿不准就填 `false`，默认值也是 `false`。

**「只有报错，没有解法」。**
欢迎开 issue，我们会跟着上游看。但它不会直接变成病例 —— 一条没有解法的病例
对用户是负价值：他搜到了，然后发现没有下文。

## 提交前

```bash
node scripts/validate.mjs      # 必须绿
node bin/u-rescue.mjs doctor   # 确认你的新探针没有对所有人都报警
node bin/u-rescue.mjs search "你病例里的报错原文"   # 确认搜得到
```

第二条特别重要：在你自己**没有**这个问题的机器上跑 `doctor`，
如果它报了你新加的病例，说明探针写宽了。

## 报告一个还没解法的问题

开 issue，尽量带上：

- 完整报错原文（**把 key、token、邮箱、内网地址删掉**）
- 操作系统 + 工具版本
- 什么时候开始的、之前改过什么
- 已经试过什么、结果如何

`npx u-rescue doctor --json` 的输出可以直接贴 —— 它已经做过脱敏。
