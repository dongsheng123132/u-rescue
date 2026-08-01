#!/usr/bin/env node
/**
 * 病例 → 中文静态网页。
 *
 * 这才是给小白的入口：他们不逛 GitHub，遇到报错会去问 AI / 搜一下。
 * 所以每条病例出一个独立页面，标题就是用户会搜的那句话，报错原文原样出现在正文里，
 * 并带 JSON-LD 结构化数据，方便被搜索引擎和 AI 引用。
 *
 * 产物是纯静态 HTML，直接 scp 到站点目录即可，无需构建工具、无需 JS 框架。
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCases, isStale, ROOT } from "../lib/cases.mjs";

const OUT = join(ROOT, "dist", "site");
const SITE_BASE = process.env.URESCUE_SITE_BASE || "https://u-claw.org.cn/rescue";

const TOOL_LABEL = { codex: "Codex", "claude-code": "Claude Code", openclaw: "OpenClaw", hermes: "Hermes", shared: "通用环境" };
const SEVERITY_LABEL = { blocker: "完全不能用", major: "功能受损", minor: "体验问题" };
const EVIDENCE_LABEL = {
  field: "真机验证",
  reproduced: "已复现",
  "upstream-issue": "上游记录（未复现）",
  reported: "仅用户报告",
};
const RISK_LABEL = { "read-only": "只读", low: "低风险", medium: "中风险", high: "高风险" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const CSS = `
:root{--fg:#1a1a1a;--dim:#6b7280;--line:#e5e7eb;--bg:#fff;--accent:#b45309;--warn:#fef3c7;--code:#f6f7f9}
@media(prefers-color-scheme:dark){:root{--fg:#e5e7eb;--dim:#9ca3af;--line:#2d3138;--bg:#15181d;--accent:#fbbf24;--warn:#3a2f10;--code:#1d2127}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 80px}
a{color:var(--accent)}
h1{font-size:26px;line-height:1.4;margin:0 0 8px}
h2{font-size:19px;margin:36px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
.meta{color:var(--dim);font-size:13px;margin-bottom:24px}
.tag{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:4px;margin-right:6px;font-size:12px}
.warn{background:var(--warn);padding:12px 14px;border-radius:6px;font-size:14px;margin:16px 0}
pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6}
code{background:var(--code);padding:1px 5px;border-radius:3px;font-size:13px}
pre code{background:none;padding:0}
ul{padding-left:22px}
li{margin:6px 0}
.step{margin:18px 0;padding-left:14px;border-left:3px solid var(--line)}
.step .risk{font-size:12px;color:var(--dim)}
.rollback{font-size:13px;color:var(--dim);margin-top:6px}
.cases{list-style:none;padding:0}
.cases li{padding:14px 0;border-bottom:1px solid var(--line)}
.cases a{font-weight:600;text-decoration:none;font-size:16px}
.cases .sym{color:var(--dim);font-size:13px;margin-top:4px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.cta{margin:28px 0;padding:16px 18px;border:1px solid var(--line);border-radius:8px;font-size:14px}
`;

function page({ title, desc, body, jsonld, canonical }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<style>${CSS}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

function casePage(c) {
  const stale = isStale(c);
  const url = `${SITE_BASE}/${c.id}.html`;
  const desc = `${c.symptoms[0]}。原因与解决办法：${c.cause.slice(0, 60)}…`;

  const parts = [];
  parts.push(`<p style="font-size:13px"><a href="./index.html">← 全部病例</a></p>`);
  parts.push(`<h1>${esc(c.title)}</h1>`);
  parts.push(`<div class="meta">
    <span class="tag">${esc(TOOL_LABEL[c.tool] ?? c.tool)}</span>
    <span class="tag">${esc(SEVERITY_LABEL[c.severity])}</span>
    <span class="tag">${esc(EVIDENCE_LABEL[c.evidence])}</span>
    <span class="tag">${c.platforms.join(" / ")}</span>
    最后验证 ${esc(c.verified_on.date)}${c.verified_on.tool_version ? `（${esc(c.verified_on.tool_version)}）` : ""}
  </div>`);

  if (stale) {
    parts.push(`<div class="warn">⚠️ 这条方案已超过半年没复核，上游可能早改了。<strong>当参考读，别照着闭眼敲。</strong>如果你验证过还有效或已失效，欢迎告诉我们。</div>`);
  }
  if (c.evidence === "upstream-issue") {
    parts.push(`<div class="warn">这条来自上游 issue 的记录，<strong>我们没有在自己的机器上复现过</strong>。方案是原报告者验证的，供参考。</div>`);
  }

  parts.push(`<h2>是不是你遇到的问题</h2><ul>${c.symptoms.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
  if (c.errors?.length) {
    parts.push(`<p style="color:var(--dim);font-size:14px">典型报错原文：</p><pre><code>${c.errors.map(esc).join("\n")}</code></pre>`);
  }

  parts.push(`<h2>为什么会这样</h2><p>${esc(c.cause).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);

  parts.push(`<h2>怎么修</h2>`);
  c.fix.steps.forEach((s, i) => {
    let html = `<div class="step"><div><strong>第 ${i + 1} 步</strong> <span class="risk">[${RISK_LABEL[s.risk]}]</span></div><p>${esc(s.desc).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;
    if (s.cmd) html += `<pre><code>${esc(s.cmd)}</code></pre>`;
    if (s.rollback) html += `<div class="rollback">撤回办法：${esc(s.rollback)}</div>`;
    parts.push(html + `</div>`);
  });

  parts.push(`<h2>怎么算真修好了</h2><p>${esc(c.fix.verify)}</p>`);

  parts.push(`<div class="cta">
    <strong>自己修不下去？</strong><br>
    命令行一键排查（只读，不动你的机器）：<code>npx u-rescue doctor</code><br>
    ${c.uking ? `想省事：${esc(c.uking)} → <a href="https://u-king.org">u-king.org</a>` : `想要图形界面一键修，可以用 <a href="https://u-king.org">U-King</a>。`}
  </div>`);

  if (c.sources?.length) {
    parts.push(`<h2>出处</h2><ul>${c.sources.map((s) => `<li><a href="${esc(s)}" rel="nofollow noopener">${esc(s)}</a></li>`).join("")}</ul>`);
  }

  parts.push(`<footer>
    病例 ID <code>${esc(c.id)}</code> · 内容开源（Apache-2.0），欢迎纠错与补充：
    <a href="https://github.com/dongsheng123132/u-rescue">GitHub 仓库</a><br>
    本页由病例库自动生成，改一处 JSON 全渠道同步更新。
  </footer>`);

  // 结构化数据：让 AI 和搜索引擎能直接引用「问题→答案」这一对。
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: c.title,
    description: desc,
    inLanguage: "zh-CN",
    dateModified: c.verified_on.date,
    keywords: [...(c.tags ?? []), TOOL_LABEL[c.tool] ?? c.tool].join(","),
    mainEntity: {
      "@type": "Question",
      name: c.title,
      acceptedAnswer: {
        "@type": "Answer",
        text: `${c.cause}\n\n解决步骤：${c.fix.steps.map((s, i) => `${i + 1}. ${s.desc}${s.cmd ? ` 命令：${s.cmd}` : ""}`).join(" ")}\n\n验证：${c.fix.verify}`,
      },
    },
  };

  return page({ title: `${c.title} —— U-Rescue 病例库`, desc, body: parts.join("\n"), jsonld, canonical: url });
}

function indexPage(cases) {
  const byTool = {};
  for (const c of cases) (byTool[c.tool] ??= []).push(c);

  const parts = [];
  parts.push(`<h1>AI 工具坏了怎么修 —— 病例库</h1>`);
  parts.push(`<p style="color:var(--dim)">Codex、Claude Code 在 Windows / 国内网络下的真实故障病例：什么症状、为什么、怎么修、怎么验证修好了。每条都标了是我们真机验证过的，还是只是上游 issue 的记录 —— <strong>这个区别很重要，别把没验证过的方案当真理</strong>。</p>`);

  parts.push(`<div class="cta">
    <strong>不知道自己属于哪一条？</strong><br>
    装了 Node 的话，一条命令做只读体检（不会改你的机器）：<pre><code>npx u-rescue doctor</code></pre>
    或者把报错原文整段粘进来搜：<pre><code>npx u-rescue search "把报错粘这里"</code></pre>
  </div>`);

  for (const [tool, list] of Object.entries(byTool)) {
    parts.push(`<h2>${esc(TOOL_LABEL[tool] ?? tool)}（${list.length} 条）</h2>`);
    parts.push(`<ul class="cases">${list.map((c) => `<li>
      <a href="./${esc(c.id)}.html">${esc(c.title)}</a>
      ${isStale(c) ? '<span class="tag">待复核</span>' : ""}
      <span class="tag">${esc(EVIDENCE_LABEL[c.evidence])}</span>
      <div class="sym">${esc(c.symptoms[0])}</div>
    </li>`).join("")}</ul>`);
  }

  parts.push(`<div class="cta">
    <strong>都试过还是不行？</strong><br>
    <a href="https://u-king.org">U-King</a> 是我们做的图形界面版：一键装好 Claude Code / Codex，自动绕开上面这些坑，有问题能一键体检和修复。
    这个病例库本身是开源免费的，用不用 U-King 都不影响。
  </div>`);

  parts.push(`<footer>
    内容开源（Apache-2.0）· <a href="https://github.com/dongsheng123132/u-rescue">GitHub</a> ·
    发现新问题或有更好的方案，欢迎提 issue。<br>
    共 ${cases.length} 条病例，最后更新 ${new Date().toISOString().slice(0, 10)}。
  </footer>`);

  return page({
    title: "AI 工具坏了怎么修 —— Codex / Claude Code 故障病例库",
    desc: "Codex、Claude Code 在 Windows 和国内网络环境下的常见故障：报错原文、根本原因、可回滚的修复步骤、验证方法。开源病例库。",
    body: parts.join("\n"),
    canonical: `${SITE_BASE}/index.html`,
  });
}

const cases = loadCases();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

writeFileSync(join(OUT, "index.html"), indexPage(cases), "utf8");
for (const c of cases) writeFileSync(join(OUT, `${c.id}.html`), casePage(c), "utf8");

// sitemap：给搜索引擎和 AI 抓取用
const urls = ["index.html", ...cases.map((c) => `${c.id}.html`)];
writeFileSync(join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE_BASE}/${u}</loc></url>`).join("\n")}\n</urlset>\n`, "utf8");

// 机器可读的全量索引：AI 抓一个文件就能拿到全部病例
writeFileSync(join(OUT, "cases.json"),
  JSON.stringify({ version: 1, updated: new Date().toISOString().slice(0, 10), base: SITE_BASE, cases: cases.map(({ _file, ...c }) => c) }, null, 2), "utf8");

console.log(`站点已生成：${OUT}`);
console.log(`  ${cases.length} 个病例页 + index.html + sitemap.xml + cases.json`);
console.log(`  站点地址前缀：${SITE_BASE}（用 URESCUE_SITE_BASE 环境变量可改）`);
