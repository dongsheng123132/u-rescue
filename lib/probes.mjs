/**
 * 只读探针。这是整个项目的安全边界所在，改这里前先想清楚：
 *
 * 铁律 —— 探针**永远不接受可执行内容**。病例 JSON 里能写的只有白名单里的 kind，
 * cmd 必须命中 SAFE_BINS，args 只允许安全字符。这样即便病例仓库被投毒、或者下发链
 * 被中间人篡改，最坏结果也只是给出一条误导性提示，构不成任意命令执行。
 *
 * 另一条：path_has 用纯 Node 解析 PATH，不 spawn 任何东西 —— 因为这个工具要能在
 * 「PATH 已经坏了、where 都跑不起来」的机器上工作，那正是它最该派上用场的时候。
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";

/** cmd_ok 只允许这些可执行名。新增前问一句：它会不会改机器？会就别加。 */
export const SAFE_BINS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "git",
  "claude", "codex", "openclaw", "hermes", "ollama",
  "python", "python3", "curl", "where", "which",
]);

const ARG_OK = /^[A-Za-z0-9._\-=:/@]+$/;

export function currentOs() {
  const p = platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

/** 展开 ~ 与 %VAR%（Windows 风格），不做任何 shell 求值。 */
export function expandPath(p) {
  let out = String(p);
  if (out.startsWith("~")) out = join(homedir(), out.slice(1));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m);
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m);
  return out;
}

/** 纯 Node 版 which：不 spawn，PATH 坏了照样能用。返回全部命中，第一个是实际生效的。 */
export function resolveAllOnPath(name) {
  const raw = process.env.PATH || process.env.Path || "";
  const dirs = raw.split(delimiter).filter(Boolean);
  const exts = currentOs() === "windows"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hits = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try { if (existsSync(candidate)) hits.push(candidate); } catch { /* 目录不可读，跳过 */ }
    }
  }
  return hits;
}

export function resolveOnPath(name) {
  return resolveAllOnPath(name)[0] ?? null;
}

function runCmd(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || "").trim().split("\n")[0] || "" });
    });
    child.on("error", () => resolve({ ok: false, out: "" }));
  });
}

async function httpReach(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ac.signal, redirect: "manual" });
    return { ok: res.status < 500, out: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, out: err?.name === "AbortError" ? "超时" : "连不上" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一个探针。返回 {status: "pass"|"fail"|"skipped", detail}。
 * status 说的是**探针本身成不成立**，跟病例期望值的比对交给调用方。
 */
export async function runProbe(probe, { allowNet = false, timeoutMs = 5000 } = {}) {
  switch (probe.kind) {
    case "os_is":
      return { status: currentOs() === probe.name ? "pass" : "fail", detail: `当前系统 ${currentOs()}` };

    case "env_present": {
      const v = process.env[probe.name];
      return { status: v ? "pass" : "fail", detail: v ? `${probe.name} 已设置` : `${probe.name} 未设置` };
    }

    case "env_absent": {
      const v = process.env[probe.name];
      return { status: v ? "fail" : "pass", detail: v ? `${probe.name} 已设置` : `${probe.name} 未设置` };
    }

    case "file_exists": {
      const p = expandPath(probe.path);
      return { status: existsSync(p) ? "pass" : "fail", detail: existsSync(p) ? "存在" : "不存在" };
    }

    case "path_has": {
      const hit = resolveOnPath(probe.name);
      return { status: hit ? "pass" : "fail", detail: hit ? hit : `PATH 上找不到 ${probe.name}` };
    }

    // 以下四个是「有鉴别力」的专用探针 —— 前提条件（是不是 Windows、npm 装没装）
    // 谁都成立，拿它当证据会把体检变成人人中招的算命。这几个只在真出问题时才成立。

    case "env_contains": {
      const v = process.env[probe.name] ?? "";
      const hit = v.includes(probe.value);
      return { status: hit ? "pass" : "fail", detail: hit ? `${probe.name} 里含有 ${probe.value}` : `${probe.name} 里没有 ${probe.value}` };
    }

    case "env_nonascii": {
      const v = process.env[probe.name] ?? "";
      // eslint-disable-next-line no-control-regex
      const hit = /[^\x00-\x7F]/.test(v);
      return { status: hit ? "pass" : "fail", detail: hit ? `${probe.name} 含非 ASCII 字符（中文路径）` : `${probe.name} 是纯 ASCII` };
    }

    case "path_duplicates": {
      const hits = resolveAllOnPath(probe.name);
      return {
        status: hits.length > 1 ? "pass" : "fail",
        detail: hits.length > 1 ? `PATH 上有 ${hits.length} 个 ${probe.name}，实际生效的是 ${hits[0]}` : `只有一个${hits.length ? `：${hits[0]}` : ""}`,
      };
    }

    case "npm_prefix_on_path": {
      if (!resolveOnPath("npm")) return { status: "skipped", detail: "没装 npm，无从判断" };
      const r = await runCmd("npm", ["config", "get", "prefix"], timeoutMs);
      if (!r.ok || !r.out) return { status: "skipped", detail: "读不到 npm prefix" };
      const prefix = r.out.trim();
      const binDir = currentOs() === "windows" ? prefix : join(prefix, "bin");
      if (!existsSync(binDir)) {
        return { status: "pass", detail: `npm 全局目录 ${binDir} 根本不存在 —— 装了也找不到` };
      }
      const raw = (process.env.PATH || process.env.Path || "").toLowerCase();
      const onPath = raw.split(delimiter).some((d) => d.replace(/[\\/]+$/, "").toLowerCase() === binDir.replace(/[\\/]+$/, "").toLowerCase());
      return {
        status: onPath ? "fail" : "pass",
        detail: onPath ? `npm 全局目录已在 PATH 上（${binDir}）` : `npm 装到 ${binDir}，但它不在 PATH 上 —— 所以「装成功了却找不到命令」`,
      };
    }

    case "cmd_ok": {
      if (!SAFE_BINS.has(probe.cmd)) {
        return { status: "skipped", detail: `${probe.cmd} 不在白名单里，拒绝执行` };
      }
      const args = probe.args ?? [];
      if (!args.every((a) => ARG_OK.test(a))) {
        return { status: "skipped", detail: "参数含不安全字符，拒绝执行" };
      }
      if (!resolveOnPath(probe.cmd)) {
        return { status: "fail", detail: `${probe.cmd} 不在 PATH 上` };
      }
      const r = await runCmd(probe.cmd, args, timeoutMs);
      return { status: r.ok ? "pass" : "fail", detail: r.out || (r.ok ? "退出码 0" : "退出码非 0") };
    }

    case "http_reach": {
      if (!allowNet) return { status: "skipped", detail: "需要 --net 才做网络探测" };
      const r = await httpReach(probe.url, timeoutMs);
      return { status: r.ok ? "pass" : "fail", detail: r.out };
    }

    default:
      return { status: "skipped", detail: `未知探针类型 ${probe.kind}` };
  }
}
