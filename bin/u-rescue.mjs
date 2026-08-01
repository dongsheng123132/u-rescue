#!/usr/bin/env node
/**
 * u-rescue —— AI 工具环境急救：查病例、跑只读体检。
 *
 * 设计约束（这个工具要在**已经坏掉的机器**上跑，所以）：
 *   - 零依赖，只用 Node 内置模块
 *   - 默认只读：不改配置、不装东西、不联网（联网要 --net）
 *   - stdout 只放结果，日志一律 stderr；非 TTY 不上色 —— 方便被 AI 和脚本调用
 *   - 退出码：0=没发现问题 / 1=命中了病例 / 2=用法错误
 */

import { loadCases, searchCases, isStale } from "../lib/cases.mjs";
import { runProbe, currentOs } from "../lib/probes.mjs";
import { redact } from "../lib/redact.mjs";
import { fetchRemote, cachedCases, cacheAgeDays, CACHE_TTL_DAYS, REMOTE_SOURCES } from "../lib/remote.mjs";

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith("--")));
const ARGS = argv.filter((a) => !a.startsWith("--"));
const JSON_OUT = FLAGS.has("--json");
const ALLOW_NET = FLAGS.has("--net");

const TTY = process.stdout.isTTY && !JSON_OUT;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s);
const red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s), cyan = (s) => c(36, s);

const log = (...a) => console.error(...a);      // 日志走 stderr
const out = (...a) => console.log(...a);        // 结果走 stdout

const SEVERITY_LABEL = { blocker: "完全不能用", major: "功能受损", minor: "体验问题" };
const EVIDENCE_LABEL = {
  field: "真机验证",
  reproduced: "已复现",
  "upstream-issue": "上游记录（我们未复现）",
  reported: "仅用户报告",
};

function usage() {
  out(`u-rescue —— AI 工具环境急救（只读，不会动你的机器）

用法：
  npx u-rescue doctor [--net] [--json]     跑一遍只读体检，列出这台机器可能命中的病例
  npx u-rescue search "<报错原文或症状>"    按报错/症状找病例（把报错整段粘进来最准）
  npx u-rescue show <病例ID> [--json]      看某条病例的完整修复方案
  npx u-rescue list [--tool codex] [--json] 列出全部病例
  npx u-rescue update [--json]             拉取最新病例库

开关：
  --fresh     本次先拉一遍最新病例再执行
  --offline   本次完全不联网，只用本地的
  --net       允许 doctor 做网络探测（默认不做）

说明：
  只做诊断，不会替你执行修复命令 —— 步骤打印出来，你看懂了自己敲。
  doctor 默认不联网：机器坏掉时网络本身可能就是病因，卡在那儿会把唯一能用的工具也毁掉。
  病例库：https://github.com/dongsheng123132/u-rescue
`);
}

function fmtCase(cse, { withFix = false } = {}) {
  const stale = isStale(cse);
  const lines = [];
  lines.push(`${bold(cse.title)}`);
  lines.push(dim(`  ${cse.id}  ·  ${cse.tool}  ·  ${SEVERITY_LABEL[cse.severity] ?? cse.severity}  ·  ${EVIDENCE_LABEL[cse.evidence] ?? cse.evidence}`));
  if (stale) {
    lines.push(yellow(`  ⚠ 这条方案上次验证是 ${cse.verified_on.date}，已超过半年没复核。上游可能早改了 —— 当参考读，别闭眼执行。`));
  }
  lines.push(`  ${dim("为什么：")}${cse.cause}`);
  if (withFix) {
    lines.push("");
    lines.push(`  ${bold("怎么修：")}`);
    cse.fix.steps.forEach((s, i) => {
      const risk = s.risk === "read-only" ? green("[只读]")
        : s.risk === "high" ? red("[高风险]")
        : s.risk === "medium" ? yellow("[中风险]") : dim("[低风险]");
      lines.push(`   ${i + 1}. ${risk} ${s.desc}`);
      if (s.cmd) s.cmd.split("\n").forEach((l) => lines.push(cyan(`        ${l}`)));
      if (s.rollback) lines.push(dim(`        撤回：${s.rollback}`));
    });
    lines.push("");
    lines.push(`  ${bold("怎么算修好了：")}${cse.fix.verify}`);
    if (cse.differential?.length) {
      lines.push("");
      lines.push(`  ${bold("别跟这些搞混：")}`);
      for (const d of cse.differential) {
        lines.push(`   · ${cyan(d.case)}`);
        lines.push(`     区别：${d.distinguish}`);
        if (d.decisive_test) lines.push(green(`     一刀切开：${d.decisive_test}`));
      }
    }
    if (cse.uking) lines.push(dim(`\n  省事的话：${cse.uking}`));
    if (cse.sources?.length) lines.push(dim(`  出处：${cse.sources.join("  ")}`));
  }
  return lines.join("\n");
}

/**
 * doctor 不自动联网（网络可能就是病因），所以得**主动告诉用户他手上的库可能是旧的**。
 * 不说的话，「没发现问题」会被读成「机器没事」，而真相可能只是这条病例还没同步下来。
 */
function staleLibHint() {
  const age = cacheAgeDays();
  if (age <= CACHE_TTL_DAYS) return "";
  return dim(age === Infinity
    ? "  提示：本机还没同步过病例库。跑 npx u-rescue update 拉一次最新的，可能就有你这条了。"
    : `  提示：病例库是 ${Math.round(age)} 天前同步的，跑 npx u-rescue update 更新一下。`);
}

async function cmdDoctor(cases) {
  log(dim(`u-rescue 体检中（只读${ALLOW_NET ? " + 网络探测" : "，未启用网络探测，加 --net 打开"}）…`));

  const results = [];
  const onThisOs = cases.filter((c) => c.platforms.includes(currentOs()) || c.platforms.includes("wsl"));
  // 没有 evidence 探针的病例，体检查不出来 —— 如实统计，最后说明白，不假装覆盖了全部。
  const searchOnly = onThisOs.filter((c) => !(c.diagnose ?? []).some((d) => d.role === "evidence"));

  for (const cse of onThisOs) {
    if (searchOnly.includes(cse)) continue;

    const probeResults = [];
    for (const probe of cse.diagnose) {
      const r = await runProbe(probe, { allowNet: ALLOW_NET });
      probeResults.push({ id: probe.id, label: probe.label ?? probe.id, role: probe.role, expect: probe.expect, ...r });
    }

    // 前提不成立 → 这条压根不适用，直接跳过，不进结论也不刷屏。
    const preconditions = probeResults.filter((p) => p.role === "precondition" && p.status !== "skipped");
    if (preconditions.some((p) => p.status !== p.expect)) continue;

    // 只有 evidence 决定结论。全 skipped（比如需要 --net 却没开）→ 不下结论。
    const evidence = probeResults.filter((p) => p.role === "evidence" && p.status !== "skipped");
    if (!evidence.length) continue;
    const hit = evidence.filter((p) => p.status === p.expect);
    if (!hit.length) continue;
    // 默认「全部证据都得命中」。只有明确写了 any 的病例才允许单条证据成立就报。
    const mode = cse.diagnose_match ?? "all";
    if (mode === "all" && hit.length !== evidence.length) continue;

    const confidence = hit.length === evidence.length ? "high" : "medium";
    results.push({ case: cse, confidence, probes: probeResults, evidenceHit: hit.length, evidenceTotal: evidence.length });
  }

  results.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));

  const coverage = {
    total: cases.length,
    on_this_os: onThisOs.length,
    checkable: onThisOs.length - searchOnly.length,
    search_only: searchOnly.map((c) => c.id),
  };

  if (JSON_OUT) {
    out(JSON.stringify({
      ok: true,
      os: currentOs(),
      net_probes: ALLOW_NET,
      coverage,
      matched: results.map((r) => ({
        id: r.case.id, title: r.case.title, tool: r.case.tool,
        severity: r.case.severity, evidence: r.case.evidence,
        stale: isStale(r.case), confidence: r.confidence,
        evidence_hit: `${r.evidenceHit}/${r.evidenceTotal}`,
        probes: r.probes.map((p) => ({ id: p.id, role: p.role, status: p.status, expect: p.expect, detail: redact(p.detail) })),
      })),
    }, null, 2));
    return results.length ? 1 : 0;
  }

  out("");
  // 覆盖率如实说 —— 不说的话，「没发现问题」会被读成「机器没事」，那是骗人。
  const coverageLine = dim(`  体检能查的是 ${coverage.checkable} 条；另外 ${searchOnly.length} 条查不出来（只能靠报错原文搜），因为它们没有能在本机验证的判据。`);

  if (!results.length) {
    out(green("✓ 能自动查的这些项目里，没发现问题。"));
    out(coverageLine);
    out(staleLibHint());
    out(dim(`  还是坏的？把报错整段粘进来搜：npx u-rescue search "报错原文"`));
    return 0;
  }

  out(bold(`发现 ${results.length} 条命中的病例：`));
  out("");
  for (const r of results) {
    const tag = r.confidence === "high" ? red("● 高度怀疑") : yellow("○ 值得一看");
    out(`${tag}  ${fmtCase(r.case)}`);
    for (const p of r.probes) {
      if (p.status === "skipped") { out(`      ${dim("－")} ${p.label}：${dim(redact(p.detail))}`); continue; }
      const isHit = p.status === p.expect;
      const mark = p.role === "evidence" ? (isHit ? red("✗") : green("✓")) : dim("·");
      const note = p.role === "evidence" && isHit ? red(" ← 就是这里") : "";
      out(`      ${mark} ${p.label}：${redact(p.detail)}${note}`);
    }
    // 误报可能性和命中一起给出 —— 只报「你中招了」不报「什么时候这是正常的」，
    // 就是把误判的代价转嫁给用户。
    if (r.case.falsepositives?.length) {
      out(yellow(`      ⚠ 以下情况这条是误报：`));
      r.case.falsepositives.forEach((f) => out(dim(`        · ${f}`)));
    }
    out(dim(`      看完整修复方案：npx u-rescue show ${r.case.id}`));
    out("");
  }
  out(coverageLine);
  out(staleLibHint());
  out(dim("  修不好？把病例 ID 发给我们，或用 https://u-king.org 的图形界面一键修。"));
  return 1;
}

function cmdSearch(cases, query) {
  const hits = searchCases(cases, query);
  if (JSON_OUT) {
    out(JSON.stringify({
      ok: true, query: redact(query), count: hits.length,
      results: hits.slice(0, 10).map((h) => ({
        id: h.case.id, title: h.case.title, tool: h.case.tool, score: h.score,
        stale: isStale(h.case), why_matched: h.hits,
      })),
    }, null, 2));
    return hits.length ? 1 : 0;
  }
  out("");
  if (!hits.length) {
    out(yellow("没找到匹配的病例。"));
    out(dim("  换个说法再试，或者只粘报错里最独特的那一句。"));
    out(dim("  确实是新问题的话，欢迎提给我们：https://github.com/dongsheng123132/u-rescue/issues"));
    return 0;
  }
  out(bold(`找到 ${hits.length} 条，最相关的在最前面：`));
  out("");
  for (const h of hits.slice(0, 5)) {
    out(fmtCase(h.case));
    h.hits.forEach((x) => out(dim(`      匹配到 ${x}`)));
    out(dim(`      看完整修复方案：npx u-rescue show ${h.case.id}`));
    out("");
  }
  return 1;
}

function cmdShow(cases, id) {
  const cse = cases.find((x) => x.id === id);
  if (!cse) {
    log(red(`没有这条病例：${id}`));
    log(dim("用 npx u-rescue list 看全部。"));
    return 2;
  }
  if (JSON_OUT) { const { _file, ...clean } = cse; out(JSON.stringify(clean, null, 2)); return 0; }
  out("");
  out(fmtCase(cse, { withFix: true }));
  out("");
  return 0;
}

function cmdList(cases) {
  const toolIdx = argv.indexOf("--tool");
  const tool = toolIdx >= 0 ? argv[toolIdx + 1] : null;
  const filtered = tool ? cases.filter((x) => x.tool === tool) : cases;
  if (JSON_OUT) {
    out(JSON.stringify({
      ok: true, count: filtered.length,
      cases: filtered.map((x) => ({
        id: x.id, tool: x.tool, title: x.title, severity: x.severity,
        evidence: x.evidence, platforms: x.platforms, stale: isStale(x),
      })),
    }, null, 2));
    return 0;
  }
  out("");
  let lastTool = null;
  for (const x of filtered) {
    if (x.tool !== lastTool) { out(bold(`\n【${x.tool}】`)); lastTool = x.tool; }
    out(`  ${x.id}`);
    out(dim(`    ${x.title}`));
  }
  out("");
  out(dim(`共 ${filtered.length} 条。看某一条：npx u-rescue show <ID>`));
  return 0;
}

async function cmdUpdate() {
  log(dim("拉取最新病例库…"));
  const r = await fetchRemote({ onLog: (m) => log(dim(`  ${m}`)) });

  if (!r.ok) {
    if (JSON_OUT) { out(JSON.stringify({ ok: false, tried: r.tried, fallback: "内置病例库" }, null, 2)); return 1; }
    out(yellow("没能更新，继续用内置的病例库（功能不受影响）。"));
    r.tried.forEach((t) => out(dim(`  ${t}`)));
    return 1;
  }

  const before = loadCases().length;
  const bundledIds = new Set(loadCases().map((c) => c.id));
  const fresh = r.entry.payload.cases.filter((c) => !bundledIds.has(c.id));

  if (JSON_OUT) {
    out(JSON.stringify({ ok: true, source: r.source, count: r.count, bundled: before, new_ids: fresh.map((c) => c.id) }, null, 2));
    return 0;
  }
  out(green(`✓ 已更新到 ${r.count} 条病例`));
  out(dim(`  来源：${r.source}`));
  if (fresh.length) {
    out(dim(`  比内置版新增 ${fresh.length} 条：`));
    fresh.slice(0, 10).forEach((c) => out(`    ${c.id}  ${c.title}`));
    if (fresh.length > 10) out(dim(`    …还有 ${fresh.length - 10} 条`));
  } else {
    out(dim("  内置版已经是最新的。"));
  }
  return 0;
}

/**
 * 决定这次用哪份病例：远端缓存还是内置。
 *
 * 取舍写在这里，别改坏：
 *  - doctor **永远不自动联网**。那是「机器已经坏了」的场景，网络本身可能就是病因。
 *  - search 在缓存过期时会自动拉一次（带 4 秒硬超时），拉不到就静静用内置的。
 *  - --offline 一律不联网；--fresh 一律先拉。
 */
async function resolveCases(cmd) {
  const bundled = loadCases();
  if (FLAGS.has("--offline")) return { cases: bundled, from: "内置" };

  if (FLAGS.has("--fresh")) {
    const r = await fetchRemote({ onLog: (m) => log(dim(`  ${m}`)) });
    if (!r.ok) log(dim("  拉取失败，用内置病例库继续。"));
  } else if (cmd === "search" && cacheAgeDays() > CACHE_TTL_DAYS) {
    // 「必要时自动获取」就是这一条：只在真的旧了、且当前命令用得上时才去拉。
    log(dim("本地病例库有点旧，顺手更新一下（最多等 4 秒）…"));
    await fetchRemote({ onLog: () => {} });
  }

  const remote = cachedCases();
  if (!remote) return { cases: bundled, from: "内置" };
  // 远端病例数不少于内置才采用，防止拿到一份被截断的旧索引把库缩水。
  if (remote.cases.length < bundled.length) return { cases: bundled, from: "内置（远端比本地还少，已忽略）" };
  return { cases: remote.cases, from: `远端 ${remote.meta.updated ?? ""}（${new Date(remote.meta.fetched_at).toLocaleDateString("zh-CN")} 拉取）` };
}

async function main() {
  const cmd = ARGS[0];
  if (!cmd || FLAGS.has("--help") || FLAGS.has("-h")) { usage(); return 0; }
  if (cmd === "update") return await cmdUpdate();

  let cases, from;
  try {
    ({ cases, from } = await resolveCases(cmd));
  } catch (err) {
    log(red(`病例库加载失败：${err.message}`));
    return 2;
  }
  if (!JSON_OUT && from !== "内置") log(dim(`病例库来源：${from}`));

  switch (cmd) {
    case "doctor": return await cmdDoctor(cases);
    case "search": {
      const q = ARGS.slice(1).join(" ");
      if (!q) { log(red("要搜什么？例：npx u-rescue search \"self-signed certificate\"")); return 2; }
      return cmdSearch(cases, q);
    }
    case "show": {
      if (!ARGS[1]) { log(red("要看哪条？例：npx u-rescue show codex.proxy.websocket-system-proxy")); return 2; }
      return cmdShow(cases, ARGS[1]);
    }
    case "list": return cmdList(cases);
    default: log(red(`不认识的命令：${cmd}`)); usage(); return 2;
  }
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  log(red(`出错了：${redact(String(err?.stack || err))}`));
  process.exit(2);
});
