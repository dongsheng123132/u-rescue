#!/usr/bin/env node
/**
 * 病例校验。CI 跑这个，PR 过不了就合不进来。
 *
 * 手写而不是上 ajv，是为了保住「零依赖」这条 —— 病例库要能在任何机器上 clone 下来直接跑。
 * 除了 schema 形状，这里还查几条 schema 表达不了、但**真出过事**的规则（见 EXTRA_RULES）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, ROOT } from "../lib/cases.mjs";
import { SAFE_BINS } from "../lib/probes.mjs";

const schema = JSON.parse(readFileSync(join(ROOT, "schema", "case.schema.json"), "utf8"));
const errors = [];
const warnings = [];

function fail(id, msg) { errors.push(`${id}: ${msg}`); }
function warn(id, msg) { warnings.push(`${id}: ${msg}`); }

function checkShape(obj, spec, path, id) {
  if (spec.type === "object" || spec.properties) {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return fail(id, `${path} 应为对象`);
    for (const req of spec.required ?? []) {
      if (obj[req] === undefined) fail(id, `${path}.${req} 是必填的`);
    }
    if (spec.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (k.startsWith("_")) continue; // 内部字段
        if (!spec.properties?.[k]) fail(id, `${path}.${k} 不是允许的字段（打错字了？）`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (spec.properties?.[k]) checkShape(v, spec.properties[k], `${path}.${k}`, id);
    }
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(obj)) return fail(id, `${path} 应为数组`);
    if (spec.minItems && obj.length < spec.minItems) fail(id, `${path} 至少 ${spec.minItems} 项`);
    if (spec.maxItems && obj.length > spec.maxItems) fail(id, `${path} 最多 ${spec.maxItems} 项`);
    obj.forEach((it, i) => spec.items && checkShape(it, spec.items, `${path}[${i}]`, id));
    return;
  }
  if (spec.enum) {
    if (!spec.enum.includes(obj)) fail(id, `${path} 必须是 ${spec.enum.join(" / ")}，实际是 ${JSON.stringify(obj)}`);
    return;
  }
  if (spec.type === "string") {
    if (typeof obj !== "string") return fail(id, `${path} 应为字符串`);
    if (spec.minLength && obj.length < spec.minLength) fail(id, `${path} 太短（至少 ${spec.minLength} 字）`);
    if (spec.maxLength && obj.length > spec.maxLength) fail(id, `${path} 太长（最多 ${spec.maxLength} 字，实际 ${obj.length}）`);
    if (spec.pattern && !new RegExp(spec.pattern).test(obj)) fail(id, `${path} 不符合格式 ${spec.pattern}`);
    return;
  }
  if (spec.type === "boolean" && typeof obj !== "boolean") fail(id, `${path} 应为布尔值`);
}

/** schema 管不到、但踩过坑的规则。 */
const EXTRA_RULES = [
  {
    name: "非只读步骤必须写回滚",
    check: (c) => c.fix.steps
      .filter((s) => s.risk !== "read-only" && !s.rollback)
      .map((s) => `修复步骤「${s.desc.slice(0, 24)}…」是 ${s.risk} 风险却没写 rollback`),
  },
  {
    name: "cmd_ok 探针只能用白名单里的可执行文件",
    check: (c) => (c.diagnose ?? [])
      .filter((d) => d.kind === "cmd_ok" && !SAFE_BINS.has(d.cmd))
      .map((d) => `探针 ${d.id} 想跑 ${d.cmd}，不在 SAFE_BINS 白名单里`),
  },
  {
    name: "探针必填字段要对得上 kind",
    check: (c) => (c.diagnose ?? []).flatMap((d) => {
      const need = { cmd_ok: "cmd", path_has: "name", file_exists: "path", env_present: "name", env_absent: "name", os_is: "name", http_reach: "url" }[d.kind];
      return need && !d[need] ? [`探针 ${d.id} 是 ${d.kind}，缺少 ${need}`] : [];
    }),
  },
  {
    // 被真事故逼出来的：第一版 18 条病例里 16 条报「高度怀疑」，因为探针全是
    // 「是不是 Windows」「装没装 npm」这种谁都成立的前提。全员告警 = 没有告警。
    name: "写了探针就必须至少有一条有鉴别力的证据",
    check: (c) => {
      const d = c.diagnose ?? [];
      if (!d.length) return [];
      return d.some((p) => p.role === "evidence")
        ? []
        : ["diagnose 里全是 precondition，没有一条 evidence —— 这样的探针对谁都成立，会让体检变成算命。要么补一条真有鉴别力的证据，要么整块删掉改成只能搜索"];
    },
  },
  {
    name: "any 模式只在多条证据时才有意义",
    check: (c) => {
      const ev = (c.diagnose ?? []).filter((p) => p.role === "evidence");
      return c.diagnose_match === "any" && ev.length < 2
        ? ["diagnose_match=any 但只有一条 evidence，等同于 all，删掉这个字段"]
        : [];
    },
  },
  {
    name: "auto=true 必须指明对应的动作 ID",
    check: (c) => (c.fix.auto && !c.fix.uking_action) ? ["fix.auto 为 true 但没写 uking_action"] : [],
  },
  {
    name: "声称真机验证的病例应当写清在什么环境验的",
    check: (c) => (c.evidence === "field" && !c.verified_on.os) ? ["evidence=field 但 verified_on.os 空着"] : [],
  },
];

const cases = loadCases();
const seen = new Set();

for (const cse of cases) {
  const id = cse.id ?? cse._file;
  if (seen.has(cse.id)) fail(id, "病例 ID 重复");
  seen.add(cse.id);

  const { _file, ...clean } = cse;
  checkShape(clean, schema, "", id);

  for (const rule of EXTRA_RULES) {
    for (const msg of rule.check(cse) ?? []) fail(id, `[${rule.name}] ${msg}`);
  }

  // 过期不算失败 —— 它是事实，不是 bug。但必须说出来，否则「全绿」会骗人。
  const days = Math.round((Date.now() - new Date(cse.verified_on.date)) / 86400000);
  if (days > 180) warn(id, `上次验证是 ${days} 天前，该复核了`);
  if (!cse.errors?.length && cse.evidence !== "field") warn(id, "没写 errors 原文，用户粘报错时匹配不到");
}

console.log(`校验了 ${cases.length} 条病例`);
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 条提醒（不阻断）：`);
  warnings.forEach((w) => console.log(`  - ${w}`));
}
if (errors.length) {
  console.error(`\n✗ ${errors.length} 条错误：`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log("\n✓ 全部通过");
