#!/usr/bin/env node
/**
 * 自动采集：从多个来源抓「疑似环境故障」，产出**候选草稿**到 inbox/。
 *
 * 架构照抄 OSV（google/osv.dev）：源适配器 → 归一化到统一 schema → 人工过审 → 入库。
 *
 * ★ 铁律：harvest 永远不写 cases/，只写 inbox/。
 *   自动抓来的 issue 里通常只有症状、没有验证过的解法。把它直接当病例发出去，
 *   等于告诉用户「这里有答案」然后让他扑空 —— 那比没有这条更坏，
 *   而且会一次性毁掉整个库最值钱的东西（可信度）。
 *   inbox 里的草稿必须由人补上 cause / fix / verify，验证过才移进 cases/。
 *
 * ★ 去重靠 aliases（照抄 rustsec/advisory-db）。没有 alias，同一个上游 issue
 *   每跑一次采集就会被抓成一条新病例。
 *
 * 用法：
 *   node scripts/harvest.mjs                     # 全部公开源
 *   node scripts/harvest.mjs --source codex --limit 30
 *   node scripts/harvest.mjs --source uking      # 需要 GITHUB_TOKEN（私有仓）
 *   node scripts/harvest.mjs --since 2026-07-01 --json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadCases, ROOT } from "../lib/cases.mjs";
import { redactDeep, redact } from "../lib/redact.mjs";

const INBOX = join(ROOT, "inbox");

const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");

const log = (...a) => { if (!JSON_OUT) console.error(...a); };

/** 源适配器。加一个新工具＝加一条记录，不改主流程。 */
const SOURCES = {
  codex: {
    repo: "openai/codex",
    tool: "codex",
    private: false,
    labels: [],
  },
  "claude-code": {
    repo: "anthropics/claude-code",
    tool: "claude-code",
    private: false,
    labels: ["bug"],
  },
  // 我们自己的 bug 库。私有，且**含真实客户机信息** —— 采集时强制脱敏，
  // 且草稿一律标记 needs_scrub，人工再看一遍才准往外发。
  uking: {
    repo: "dongsheng123132/u-king-mini",
    tool: "shared",
    private: true,
    labels: ["bug-report"],
    scrub: true,
  },
};

/**
 * 分类器。松一点就会把功能请求当故障收进来 —— 第一版 15 条里放行 9 条，
 * 里面混着「GitHub plugin should expose…」这种，等于把噪音塞给人工。
 * 现在分强/弱信号：强信号一条即可，弱信号要凑够两条。
 */
const STRONG = [
  /\b(EPERM|EACCES|ENOENT|EEXIST|E404|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|SIGILL|ERR_[A-Z_]+)\b/,
  /\b0x[0-9A-Fa-f]{8}\b/,
  /command not found|not recognized as an internal|cannot find module|no such file or directory/i,
  /self[- ]signed|certificate|unable to get local issuer|SSL_ERROR|TLS handshake/i,
  /connection (error|closed|refused|reset)|unable to connect|failed to connect/i,
  /\b(401|403|407|429|502|503)\b.{0,40}(error|failed|denied|forbidden|unauthorized)/i,
  /(fails?|failed|unable|can'?t|cannot) to (install|start|launch|update|connect)/i,
  /(install|installation|update|startup|launch)\s+(fails?|failed|error|broken)/i,
  /装不上|连不上|闪退|打不开|用不了|没反应|报错/,
];

const WEAK = [
  /\bproxy\b/i, /\bPATH\b/, /\bWSL\b/i, /git\s?bash/i, /\bshell\b/i,
  /\bsandbox\b/i, /\bnpm\b/i, /firewall/i, /\bDNS\b/i, /\bTLS\b|\bSSL\b/i,
  /代理|路径|防火墙|杀毒|安装/,
];

/** 标题长这样的基本是功能请求或产品吐槽，不是环境故障。 */
const FEATURE_SHAPED = [
  /^\s*(\[?(feature|feat|rfc|proposal|enhancement|idea|question|docs?)\]?)\b/i,
  /\bshould\b|\bwould be nice\b|\bplease add\b|\bsupport for\b|\badd support\b/i,
  /\b(expose|allow|provide|introduce|consider)\b.{0,30}\b(option|api|setting|flag|link)\b/i,
];

/**
 * 一律不收：这些确实是问题，但**用户在自己机器上做不了任何事**。
 * 收进来只会让人工审核多读一遍然后删掉。
 * 第一轮 9 条草稿人工审下来只留 2 条，漏进来的就是这几类。
 */
const NOT_ACTIONABLE = [
  /\b(credit|credits|quota|usage limit|rate limit|billing|pricing|subscription|plan)\b.{0,40}\b(drain|burn|exhaust|fast|charge|cost)/i,
  /额度|计费|扣费|套餐|用量/,
  /\b(infinite loop|extension host|memory leak|stack overflow)\b/i, // 上游代码 bug，用户改不了
];

function hasToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

async function ghSearch(repo, { labels = [], since, limit }) {
  const token = hasToken();
  const q = [
    `repo:${repo}`, "is:issue",
    ...labels.map((l) => `label:${l}`),
    since ? `created:>=${since}` : "",
  ].filter(Boolean).join(" ");

  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${Math.min(limit, 100)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "u-rescue-harvest",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 403) throw new Error("GitHub 限流了（未登录时每小时很少）。设 GITHUB_TOKEN 或先 gh auth login。");
  if (res.status === 422) throw new Error(`查询被拒：${q}`);
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  return (await res.json()).items ?? [];
}

function looksLikeEnvFailure(issue) {
  const title = issue.title ?? "";
  const hay = `${title}\n${issue.body ?? ""}`;
  if (FEATURE_SHAPED.some((re) => re.test(title))) return false;
  if (NOT_ACTIONABLE.some((re) => re.test(hay))) return false;
  if (STRONG.some((re) => re.test(hay))) return true;
  return WEAK.filter((re) => re.test(hay)).length >= 2;
}

/** 从正文里扒出报错原文 —— 用户粘报错时靠它匹配，是草稿里最有价值的部分。 */
function extractErrors(body = "") {
  const out = [];
  for (const m of body.matchAll(/```[a-z]*\n([\s\S]{0,600}?)```/g)) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (t.length >= 12 && t.length <= 200 && /error|fail|cannot|denied|refused|not found|EPERM|EACCES|ENOENT|ECONN|\d{3}\b/i.test(t)) {
        out.push(t);
      }
    }
  }
  return [...new Set(out)].slice(0, 6);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
}

function toDraft(issue, src) {
  const alias = `${src.repo.split("/")[1]}#${issue.number}`;
  const scrub = src.scrub === true;
  const body = issue.body ?? "";

  const draft = {
    _draft: true,
    _needs: ["cause", "fix.steps", "fix.verify", "platforms", "severity", "title(改成用户说得出口的话)"],
    ...(scrub ? { _needs_scrub: "来自私有 bug 库，含真实客户机信息。人工逐字复核后才能公开。" } : {}),
    id: `${src.tool}.TODO.${slug(issue.title)}`,
    tool: src.tool,
    title: issue.title.slice(0, 80),
    symptoms: [issue.title.slice(0, 200)],
    errors: extractErrors(body),
    platforms: [],
    severity: "major",
    cause: "TODO：写清楚机制。写不出机制就别收这条 —— 「可能是环境问题」不是病因。",
    fix: {
      steps: [{ desc: "TODO：填修复步骤。非只读的步骤必须写 rollback。", risk: "read-only" }],
      verify: "TODO：怎么证明真修好了。命令退出码为 0 不算。",
      auto: false,
    },
    evidence: "reported",
    verified_on: { date: new Date().toISOString().slice(0, 10), note: `自动采集自 ${alias}，尚未验证` },
    aliases: [alias],
    sources: [issue.html_url],
    tags: [],
    _upstream: {
      state: issue.state,
      comments: issue.comments,
      reactions: issue.reactions?.total_count ?? 0,
      created: issue.created_at?.slice(0, 10),
      body_excerpt: (scrub ? redact(body) : body).slice(0, 1200),
    },
  };
  // 私有源整份再过一次脱敏 —— 本地先脱一遍，是不能省的那一遍。
  return scrub ? redactDeep(draft) : draft;
}

function knownAliases() {
  const set = new Set();
  for (const c of loadCases()) for (const a of c.aliases ?? []) set.add(a);
  if (existsSync(INBOX)) {
    for (const f of readdirSync(INBOX).filter((x) => x.endsWith(".json"))) {
      try { for (const a of JSON.parse(readFileSync(join(INBOX, f), "utf8")).aliases ?? []) set.add(a); } catch { /* 坏文件跳过 */ }
    }
  }
  return set;
}

async function main() {
  const only = flag("source");
  const limit = Number(flag("limit", "40"));
  const since = flag("since");
  const picked = only ? { [only]: SOURCES[only] } : SOURCES;

  if (only && !SOURCES[only]) {
    console.error(`没有这个源：${only}。可选：${Object.keys(SOURCES).join(" / ")}`);
    process.exit(2);
  }

  mkdirSync(INBOX, { recursive: true });
  const seen = knownAliases();
  const report = { ok: true, sources: {}, new_drafts: [], skipped_dup: 0, skipped_noise: 0 };

  for (const [name, src] of Object.entries(picked)) {
    if (src.private && !hasToken()) {
      log(`跳过私有源 ${name}：没有 GITHUB_TOKEN，也没登录 gh。`);
      report.sources[name] = { error: "需要认证" };
      continue;
    }
    log(`采集 ${name}（${src.repo}）…`);
    let issues;
    try {
      issues = await ghSearch(src.repo, { labels: src.labels, since, limit });
    } catch (err) {
      log(`  ✗ ${err.message}`);
      report.sources[name] = { error: err.message };
      continue;
    }

    let added = 0, dup = 0, noise = 0;
    for (const issue of issues) {
      const alias = `${src.repo.split("/")[1]}#${issue.number}`;
      if (seen.has(alias)) { dup++; continue; }
      if (!looksLikeEnvFailure(issue)) { noise++; continue; }

      const draft = toDraft(issue, src);
      const file = join(INBOX, `${name}-${issue.number}.json`);
      writeFileSync(file, JSON.stringify(draft, null, 2) + "\n", "utf8");
      seen.add(alias);
      added++;
      report.new_drafts.push({ alias, title: issue.title, file: `inbox/${name}-${issue.number}.json`, url: issue.html_url });
    }
    report.sources[name] = { fetched: issues.length, added, dup, noise };
    report.skipped_dup += dup;
    report.skipped_noise += noise;
    log(`  拉到 ${issues.length} 条 → 新草稿 ${added}，已收录跳过 ${dup}，判定为噪音 ${noise}`);
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return report.new_drafts.length ? 1 : 0; }

  console.log("");
  if (!report.new_drafts.length) {
    console.log("没有新草稿。");
    return 0;
  }
  console.log(`${report.new_drafts.length} 条新草稿落在 inbox/：`);
  for (const d of report.new_drafts) console.log(`  ${d.alias}  ${d.title.slice(0, 60)}`);
  console.log("");
  console.log("接下来（这一步没法自动化，也不该自动化）：");
  console.log("  1. 逐条读 inbox/*.json，判断是不是真的环境故障");
  console.log("  2. 补 cause（机制）+ fix.steps（含 rollback）+ fix.verify");
  console.log("  3. 自己复现并验证一遍，把 evidence 从 reported 改成 reproduced 或 field");
  console.log("  4. 删掉 _draft / _needs / _upstream 字段，移进 cases/<tool>/");
  console.log("  5. node scripts/validate.mjs");
  console.log("");
  console.log("补不出解法的，就让它留在 inbox 里 —— 没有解法的病例对用户是负价值。");
  return 1;
}

main().then((c) => process.exit(c ?? 0)).catch((err) => {
  console.error(`采集失败：${redact(String(err?.message || err))}`);
  process.exit(2);
});
