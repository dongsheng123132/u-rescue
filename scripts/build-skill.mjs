#!/usr/bin/env node
/**
 * 病例 → AI skill 包。
 *
 * 目的：让任何人的 Claude Code / Codex / OpenClaw 直接具备「AI 工具环境急救」能力，
 * 并且能发到 clawhub.ai / skillhub.cn 这类技能市场。
 *
 * 关键约束（别为了「更智能」破掉）：
 *   - skill 里给 AI 的是**判断依据和步骤**，不是让它闷头执行的命令。
 *     破坏性步骤一律要求先问人 —— AI 拿着一份修复手册在别人机器上乱敲，比不修更坏。
 *   - 病例正文一个字节都不在这里重写：全部由 cases/*.json 生成，改 JSON 三处同步。
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCases, isStale, ROOT } from "../lib/cases.mjs";

const OUT = join(ROOT, "dist", "skill");
const TOOL_LABEL = { codex: "Codex", "claude-code": "Claude Code", openclaw: "OpenClaw", hermes: "Hermes", shared: "通用" };
const EVIDENCE_LABEL = { field: "真机验证", reproduced: "已复现", "upstream-issue": "上游记录·未复现", reported: "仅用户报告" };

const cases = loadCases();

const FRONTMATTER = `---
name: ai-tool-rescue
description: 修 Codex / Claude Code 装不上、连不上、报错的环境问题。当用户说「codex 装不上」「claude code 报错」「连接失败」「self-signed certificate」「command not found」「401」「装了但找不到命令」「开了梯子就坏」，或粘贴任何 AI 编程工具的报错原文时使用。先只读诊断定位到具体病例，再给出可回滚的修复步骤。
license: Apache-2.0
---`;

const HEAD = `${FRONTMATTER}

# AI 工具环境急救

一份 Codex / Claude Code 环境故障的病例库。共 ${cases.length} 条，全部来自真实报告。

## 怎么用这份 skill

1. **先确诊，别急着修。** 拿用户的报错原文去下面的「病例索引」里对，或者直接跑：
   \`\`\`
   npx u-rescue search "用户的报错原文"
   npx u-rescue doctor --json
   \`\`\`
   \`doctor\` 是只读的，不会改机器；\`--json\` 出结构化结果方便你解析。

2. **确诊后按病例给方案。** 每条病例都写了「为什么」——先把原因讲给用户听，
   再给步骤。只给命令不讲原因，用户下次还会踩。

3. **动手前的红线：**
   - 标了 \`只读\` 的步骤可以直接执行。
   - 标了 \`低/中/高风险\` 的步骤 **必须先告诉用户你要改什么、怎么撤回，得到同意再做**。
   - 任何改 PATH、改注册表、删文件的操作，先备份。每条病例都写了撤回办法，照做。
   - **别把「命令退出码是 0」当成修好了。** 每条病例都写了验证方法，跑一遍再说修好了。

4. **标了「上游记录·未复现」的病例，方案是别人验证的，不是我们验证的。**
   照做之前跟用户说清楚这一点。

5. **标了「待复核」的病例已经超过半年没验证**，上游很可能改了。当参考，别当真理。

6. 索引里没有对得上的？说「这条我不知道」，别编。
   可以引导用户去 https://github.com/dongsheng123132/u-rescue/issues 提报，
   或用图形界面版 https://u-king.org 做一次完整体检。

---

## 病例索引

先扫这张表定位，再看下面的详情。

| 病例 ID | 工具 | 一句话症状 | 可信度 |
|---|---|---|---|
${cases.map((c) => `| \`${c.id}\` | ${TOOL_LABEL[c.tool] ?? c.tool} | ${c.title} | ${EVIDENCE_LABEL[c.evidence]}${isStale(c) ? " · 待复核" : ""} |`).join("\n")}

---
`;

function caseSection(c) {
  const L = [];
  L.push(`## ${c.title}`);
  L.push("");
  L.push(`- **病例 ID**：\`${c.id}\``);
  L.push(`- **适用**：${TOOL_LABEL[c.tool] ?? c.tool} / ${c.platforms.join("、")}`);
  L.push(`- **可信度**：${EVIDENCE_LABEL[c.evidence]}，最后验证 ${c.verified_on.date}${isStale(c) ? " ⚠️ 已超半年未复核，当参考读" : ""}`);
  if (c.evidence === "upstream-issue") L.push(`- ⚠️ **我们没有复现过这一条**，方案来自上游报告者。转述时要说明。`);
  L.push("");
  L.push(`**用户会怎么描述：**`);
  c.symptoms.forEach((s) => L.push(`- ${s}`));
  if (c.errors?.length) {
    L.push("");
    L.push(`**报错原文（用来精确匹配）：**`);
    L.push("```");
    c.errors.forEach((e) => L.push(e));
    L.push("```");
  }
  L.push("");
  L.push(`**为什么会这样：** ${c.cause}`);
  L.push("");
  L.push(`**修复步骤：**`);
  c.fix.steps.forEach((s, i) => {
    const risk = s.risk === "read-only" ? "只读，可直接执行" : `${s.risk} 风险，**先征得用户同意**`;
    L.push(`${i + 1}. [${risk}] ${s.desc}`);
    if (s.cmd) { L.push("   ```" + (s.shell === "any" ? "" : s.shell ?? "")); s.cmd.split("\n").forEach((l) => L.push("   " + l)); L.push("   ```"); }
    if (s.rollback) L.push(`   - 撤回：${s.rollback}`);
  });
  L.push("");
  L.push(`**验证（必须做）：** ${c.fix.verify}`);
  if (c.sources?.length) L.push(`\n**出处：** ${c.sources.join(" · ")}`);
  L.push("");
  L.push("---");
  L.push("");
  return L.join("\n");
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const skill = HEAD + "\n" + cases.map(caseSection).join("\n");
writeFileSync(join(OUT, "SKILL.md"), skill, "utf8");

// Codex / 通用 agent 用 AGENTS.md 约定，内容同源，只是换个文件名和头
writeFileSync(join(OUT, "AGENTS.md"), skill.replace(FRONTMATTER + "\n\n", ""), "utf8");

// 技能市场（clawhub.ai / skillhub.cn）上架用的元数据
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
  name: "ai-tool-rescue",
  display_name: "AI 工具急救箱",
  version: "0.1.0",
  license: "Apache-2.0",
  language: "zh-CN",
  summary: `Codex / Claude Code 装不上、连不上、报错怎么修 —— ${cases.length} 条真实病例，含只读诊断与可回滚方案。`,
  tags: ["故障排查", "Codex", "Claude Code", "装机", "代理", "Windows"],
  entry: "SKILL.md",
  cli: { install: "npx u-rescue doctor", repo: "https://github.com/dongsheng123132/u-rescue" },
  case_count: cases.length,
  updated: new Date().toISOString().slice(0, 10),
  homepage: "https://github.com/dongsheng123132/u-rescue",
}, null, 2), "utf8");

const bytes = Buffer.byteLength(skill, "utf8");
console.log(`skill 已生成：${OUT}`);
console.log(`  SKILL.md（${cases.length} 条病例，${(bytes / 1024).toFixed(1)} KB）+ AGENTS.md + manifest.json`);
if (bytes > 100 * 1024) {
  console.log(`  ⚠️ SKILL.md 已超过 100KB —— 病例再多就该拆成「索引 + 按需加载详情」，别一次全塞进上下文。`);
}
