#!/usr/bin/env node
/**
 * 病例 → U-King 可消费的下发文件。
 *
 * U-King 里已经有一条热下发链（advice.rs）：拉服务器 JSON、白名单只读探针、
 * version+1 就到全部客户机、不发 exe。这个脚本产出的就是那条链的新数据源 ——
 * **不是给 U-King 加一套新机制，是给已有机制换个更厚的源**。
 *
 * 出两份，因为它们的成本不一样，别混着谈：
 *
 *   1. advice-compat.json —— 严格贴合 advice.rs 现有格式和现有三种探针。
 *      U-King **一行代码都不用改**，改个 URL 就能用。代价是探针表达力弱，
 *      只有一部分病例能映射进来。
 *
 *   2. rescue-feed.json —— 完整病例（含鉴别诊断、误报说明、可回滚步骤）。
 *      要用它，advice.rs 需要补几种探针。脚本会把「缺哪几种」直接打出来，
 *      不用去翻文档。
 *
 * ★ 掉了多少条会明说。静默截断会让「下发了 N 条」被读成「覆盖了全部」。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, isStale, ROOT } from "../lib/cases.mjs";

const OUT = join(ROOT, "dist", "uking");
const SITE_BASE = process.env.URESCUE_SITE_BASE || "https://u-claw.org.cn/rescue";
// 下发版本号：U-King 只在服务器版本更大时才采用（和 advice.rs 现有判据一致）。
const FEED_VERSION = Number(process.env.URESCUE_FEED_VERSION || "1");

/** advice.rs 现有支持的三种探针。超出这三种的病例进不了 compat 文件。 */
function toAdviceProbe(p) {
  if (p.kind === "file_exists") return { kind: "file_exists", path: p.path };
  if (p.kind === "path_has") return p.expect === "pass"
    ? { kind: "tool_installed", name: p.name }
    : { kind: "tool_missing", name: p.name };
  return null; // os_is 走 advice 的 os 字段，不算探针
}

const cases = loadCases();
mkdirSync(OUT, { recursive: true });

// ---------- 1. 零改动兼容格式 ----------
const compat = [];
const dropped = [];

for (const c of cases) {
  const diag = c.diagnose ?? [];
  const evidence = diag.filter((p) => p.role === "evidence");
  if (!evidence.length) { dropped.push({ id: c.id, why: "没有本机可验证的证据探针（只能靠搜报错找到）" }); continue; }

  const os = diag.filter((p) => p.kind === "os_is").map((p) => p.name);
  const probes = [];
  let unsupported = null;
  for (const p of diag) {
    if (p.kind === "os_is") continue;
    const mapped = toAdviceProbe(p);
    if (!mapped) { unsupported = p.kind; break; }
    probes.push(mapped);
  }
  if (unsupported) { dropped.push({ id: c.id, why: `用了 advice.rs 还不支持的探针：${unsupported}` }); continue; }

  compat.push({
    id: `rescue.${c.id}`,
    os,
    title: c.title,
    detail: `${c.cause}\n\n怎么修：${c.fix.steps.map((s, i) => `${i + 1}. ${s.desc}`).join(" ")}\n\n验证：${c.fix.verify}`
      + (c.falsepositives?.length ? `\n\n注意，以下情况属于误报：${c.falsepositives.join("；")}` : ""),
    url: `${SITE_BASE}/${c.id}.html`,
    severity: c.severity === "blocker" ? "warn" : "info",
    when: probes,
  });
}

writeFileSync(join(OUT, "advice-compat.json"),
  JSON.stringify({ version: FEED_VERSION, advices: compat }, null, 2) + "\n", "utf8");

// ---------- 2. 完整格式 ----------
writeFileSync(join(OUT, "rescue-feed.json"), JSON.stringify({
  version: FEED_VERSION,
  schema: "u-rescue/case@1",
  updated: new Date().toISOString().slice(0, 10),
  site: SITE_BASE,
  repo: "https://github.com/dongsheng123132/u-rescue",
  // 客户端拿到后应当自行判断：过期的病例只展示、不提供「一键修」按钮。
  stale_policy: { after_days: 180, action: "只展示，不提供一键修" },
  cases: cases.map(({ _file, ...c }) => ({ ...c, stale: isStale(c), url: `${SITE_BASE}/${c.id}.html` })),
}, null, 2) + "\n", "utf8");

// ---------- 报告 ----------
const needed = [...new Set(dropped.map((d) => d.why.match(/：(.+)$/)?.[1]).filter(Boolean))];

console.log(`U-King 下发文件已生成：${OUT}`);
console.log("");
console.log(`  advice-compat.json —— ${compat.length}/${cases.length} 条（U-King 零改动可用）`);
console.log(`  rescue-feed.json   —— ${cases.length}/${cases.length} 条（需要扩展探针）`);
console.log("");
console.log(`  ⚠ compat 版掉了 ${dropped.length} 条，原因如下（不静默截断）：`);
for (const d of dropped) console.log(`      ${d.id}\n        ${d.why}`);
if (needed.length) {
  console.log("");
  console.log(`  要把这些捞回来，advice.rs 需要补这几种只读探针：`);
  needed.forEach((k) => console.log(`      ${k}`));
  console.log(`  实现可以直接照搬 lib/probes.mjs 里的同名分支，都是纯只读、不到 20 行。`);
}
