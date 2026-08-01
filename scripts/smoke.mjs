#!/usr/bin/env node
/**
 * 冒烟测试：真跑 CLI 的每条路径，断言输出形状。
 * 不 mock —— 这个工具的价值就在于它能在真实机器上跑起来，mock 掉就什么都没测。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadCases } from "../lib/cases.mjs";
import { redact } from "../lib/redact.mjs";
import { verifyPayload } from "../lib/remote.mjs";

const CLI = join(ROOT, "bin", "u-rescue.mjs");
let failed = 0;

function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message}`); failed++; }
}

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: err.status ?? -1, out: String(err.stdout ?? "") };
  }
}

console.log("冒烟测试：");

check("doctor --json 出合法 JSON 且带覆盖率", () => {
  const r = run(["doctor", "--json"]);
  const j = JSON.parse(r.out);
  if (j.ok !== true) throw new Error("ok 不是 true");
  if (typeof j.coverage?.checkable !== "number") throw new Error("缺 coverage.checkable —— 覆盖率必须如实上报，否则「没发现问题」会被读成「机器没事」");
  if (!Array.isArray(j.matched)) throw new Error("matched 不是数组");
  if (![0, 1].includes(r.code)) throw new Error(`退出码应为 0 或 1，实际 ${r.code}`);
});

check("doctor 命中时退出码为 1、没命中为 0", () => {
  const r = run(["doctor", "--json"]);
  const j = JSON.parse(r.out);
  const expected = j.matched.length ? 1 : 0;
  if (r.code !== expected) throw new Error(`命中 ${j.matched.length} 条，退出码应为 ${expected}，实际 ${r.code}`);
});

check("search 能搜到已知报错", () => {
  const r = run(["search", "self-signed certificate detected", "--json"]);
  const j = JSON.parse(r.out);
  if (!j.results.some((x) => x.id === "claude-code.net.self-signed-certificate")) {
    throw new Error("搜不到 claude-code.net.self-signed-certificate —— errors 原文匹配坏了");
  }
});

check("search 搜中文症状也能命中", () => {
  const r = run(["search", "装成功了但是找不到命令", "--json"]);
  const j = JSON.parse(r.out);
  if (!j.results.length) throw new Error("中文症状一条都没搜到");
});

check("show 能取出完整病例", () => {
  const r = run(["show", "shared.win.path-broken-system32", "--json"]);
  const j = JSON.parse(r.out);
  if (!j.fix?.steps?.length) throw new Error("缺 fix.steps");
  if (!j.fix.verify) throw new Error("缺 fix.verify");
});

check("show 不存在的 ID 退出码为 2", () => {
  const r = run(["show", "no.such.case"]);
  if (r.code !== 2) throw new Error(`应为 2，实际 ${r.code}`);
});

check("list --json 覆盖全部病例", () => {
  const r = run(["list", "--json"]);
  const j = JSON.parse(r.out);
  if (j.count !== loadCases().length) throw new Error(`list 报 ${j.count} 条，实际 ${loadCases().length} 条`);
});

check("未知命令退出码为 2", () => {
  if (run(["frobnicate"]).code !== 2) throw new Error("应为 2");
});

check("--json 时 stdout 只有 JSON（不掺日志）", () => {
  const r = run(["doctor", "--json"]);
  JSON.parse(r.out); // 掺了日志这里就炸
  if (r.out.includes("体检中")) throw new Error("日志漏进了 stdout —— 会污染 | jq");
});

check("脱敏：key / 邮箱 / 用户名路径都拦得住", () => {
  // 断言的是「原文没了」，不是「换成了哪个占位符」—— 换哪个标记不影响安全性，
  // 把占位符写死进测试只会让以后调整标记时误报。
  const cases = [
    ["sk-abcdefghijklmnop1234", "sk-abcdefghijklmnop1234"],
    ["someone@example.com", "someone@example.com"],
    ["C:\\Users\\张三\\file.txt", "张三"],
    ["/Users/zhangsan/x", "zhangsan"],
    ["ANTHROPIC_API_KEY=sk-live-xyz789abcdef", "sk-live-xyz789abcdef"],
    ["authorization: Bearer abc123def456ghi", "abc123def456ghi"],
    ["手机 13800138000", "13800138000"],
  ];
  for (const [input, secret] of cases) {
    const got = redact(input);
    if (got.includes(secret)) throw new Error(`「${secret}」没被脱掉，输出仍是「${got}」`);
    if (got === input) throw new Error(`「${input}」原样通过了，脱敏没生效`);
  }
});

check("每条病例都能被自己的报错原文搜到", () => {
  const bad = [];
  for (const c of loadCases()) {
    if (!c.errors?.length) continue;
    const r = run(["search", c.errors[0], "--json"]);
    const j = JSON.parse(r.out);
    if (!j.results.some((x) => x.id === c.id)) bad.push(c.id);
  }
  if (bad.length) throw new Error(`这些病例搜自己的报错都搜不到：${bad.join(", ")}`);
});

check("--offline 不联网也能正常工作", () => {
  const r = run(["list", "--offline", "--json"]);
  const j = JSON.parse(r.out);
  if (j.count !== loadCases().length) throw new Error("offline 模式下病例数不对");
});

check("远端数据校验：混进白名单外的可执行文件必须整包拒绝", () => {
  const bad = {
    cases: [{
      id: "evil.test.case", cause: "x", fix: { steps: [{ desc: "x" }], verify: "x" },
      diagnose: [{ id: "p", role: "evidence", kind: "cmd_ok", cmd: "curl-evil", args: [], expect: "pass" }],
    }],
  };
  const v = verifyPayload(bad);
  if (v.ok) throw new Error("白名单外的 cmd 竟然通过了校验 —— 这是远程投毒的入口");
});

check("远端数据校验：探针参数带 shell 注入必须整包拒绝", () => {
  const bad = {
    cases: [{
      id: "evil.test.inject", cause: "x", fix: { steps: [{ desc: "x" }], verify: "x" },
      diagnose: [{ id: "p", role: "evidence", kind: "cmd_ok", cmd: "node", args: ["-e", "require('fs')"], expect: "pass" }],
    }],
  };
  if (verifyPayload(bad).ok) throw new Error("带空格/括号的参数通过了校验");
});

check("远端数据校验：未知探针类型必须整包拒绝", () => {
  const bad = {
    cases: [{
      id: "evil.test.kind", cause: "x", fix: { steps: [{ desc: "x" }], verify: "x" },
      diagnose: [{ id: "p", role: "evidence", kind: "run_shell", expect: "pass" }],
    }],
  };
  if (verifyPayload(bad).ok) throw new Error("未知探针类型通过了校验");
});

check("远端数据校验：合法数据要能通过", () => {
  const good = { cases: loadCases().map(({ _file, ...c }) => c) };
  const v = verifyPayload(good);
  if (!v.ok) throw new Error(`自己的病例库没通过自己的远端校验：${v.reason}`);
});

check("cases.json 索引和病例库一致", () => {
  const idx = JSON.parse(readFileSync(join(ROOT, "cases.json"), "utf8"));
  if (idx.count !== loadCases().length) {
    throw new Error(`cases.json 说 ${idx.count} 条，实际 ${loadCases().length} 条 —— 跑 npm run build:index`);
  }
});

console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
