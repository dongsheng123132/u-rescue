/**
 * 病例库远程更新。
 *
 * 为什么需要：npx 装到的是发布那一刻的快照，但病例天天在补。没有这条链，
 * 用户手上的库会静静地过时，而他不会知道。
 *
 * 三条守住的边界（跟 docs/SECURITY.md 一致）：
 *
 *  1. **只拉数据，永不拉可执行内容。** 收到的每一条病例都要重新过一遍探针白名单
 *     和 SAFE_BINS；只要有一条不合规，**整包拒绝**，继续用内置的。
 *     远端被投毒 / 被中间人换包，最坏结果仍然只是「给出一条错误建议」。
 *
 *  2. **doctor 永远不联网。** 那是「机器已经坏了」的场景 —— 网络本身可能就是病因，
 *     在那儿卡 30 秒会把唯一能用的工具也毁掉。自动拉取只发生在 search / update。
 *
 *  3. **拉不到就闭嘴用内置的。** 网络问题不该变成用户的错误信息。
 *     最多在 stderr 提一行，绝不阻断，绝不抛错。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SAFE_BINS } from "./probes.mjs";

/** 按顺序试，第一个成功且合法的生效。国内可达域放第一位。 */
export const REMOTE_SOURCES = [
  "https://u-claw.org.cn/rescue/cases.json",
  "https://raw.githubusercontent.com/dongsheng123132/u-rescue/main/cases.json",
];

const CACHE_DIR = join(homedir(), ".u-rescue");
const CACHE_FILE = join(CACHE_DIR, "cases-cache.json");

/** 超过这个天数就算旧，search 时会自动去拉一次。 */
export const CACHE_TTL_DAYS = 7;
/** 硬超时。宁可用旧数据，也不能让用户对着光标等。 */
const FETCH_TIMEOUT_MS = 4000;

const PROBE_KINDS = new Set([
  "cmd_ok", "path_has", "file_exists", "env_present", "env_absent",
  "env_contains", "env_nonascii", "path_duplicates", "npm_prefix_on_path",
  "os_is", "http_reach",
]);
const ARG_OK = /^[A-Za-z0-9._\-=:/@]+$/;

/**
 * 把远端来的整包过一遍安全校验。
 * 返回 {ok:true, cases} 或 {ok:false, reason}。**任何一条不合规就整包拒绝** ——
 * 部分接受意味着攻击者只要混进一条就能得手。
 */
export function verifyPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "不是 JSON 对象" };
  if (!Array.isArray(payload.cases)) return { ok: false, reason: "缺 cases 数组" };
  if (payload.cases.length === 0) return { ok: false, reason: "cases 是空的" };
  if (payload.cases.length > 5000) return { ok: false, reason: "cases 数量异常（>5000）" };

  for (const c of payload.cases) {
    if (typeof c?.id !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(c.id)) {
      return { ok: false, reason: `病例 ID 不合法：${String(c?.id).slice(0, 40)}` };
    }
    if (typeof c.cause !== "string" || !c.fix?.steps?.length || typeof c.fix.verify !== "string") {
      return { ok: false, reason: `${c.id} 缺 cause / fix.steps / fix.verify` };
    }
    for (const p of c.diagnose ?? []) {
      if (!PROBE_KINDS.has(p?.kind)) return { ok: false, reason: `${c.id} 含未知探针类型 ${p?.kind}` };
      if (p.kind === "cmd_ok") {
        if (!SAFE_BINS.has(p.cmd)) return { ok: false, reason: `${c.id} 想执行白名单外的 ${p.cmd}` };
        if (!(p.args ?? []).every((a) => typeof a === "string" && ARG_OK.test(a))) {
          return { ok: false, reason: `${c.id} 的探针参数含不安全字符` };
        }
      }
    }
    // fix.steps[].cmd 只展示不执行，所以不限制内容，但要确保是字符串。
    for (const s of c.fix.steps) {
      if (s.cmd !== undefined && typeof s.cmd !== "string") return { ok: false, reason: `${c.id} 的 fix.cmd 不是字符串` };
    }
  }
  return { ok: true, cases: payload.cases };
}

export function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const j = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (!j?.payload || !j?.fetched_at) return null;
    return j;
  } catch { return null; }
}

export function cacheAgeDays(cache = readCache()) {
  if (!cache) return Infinity;
  return (Date.now() - new Date(cache.fetched_at).getTime()) / 86400000;
}

function writeCache(entry) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), "utf8");
}

async function fetchOne(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "u-rescue" } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, payload: await res.json() };
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "超时" : "连不上" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉一次远端病例库。**从不抛错** —— 失败就返回 {ok:false}，调用方继续用内置的。
 * onLog 只用于 stderr 提示，不影响 stdout。
 */
export async function fetchRemote({ onLog = () => {} } = {}) {
  const tried = [];
  for (const url of REMOTE_SOURCES) {
    onLog(`拉取 ${url} …`);
    const r = await fetchOne(url);
    if (!r.ok) { tried.push(`${url} → ${r.reason}`); continue; }

    const v = verifyPayload(r.payload);
    if (!v.ok) {
      // 拿到了但不合规 —— 这比连不上更值得说，可能是被投毒或被运营商劫持。
      tried.push(`${url} → 数据不合规并已拒绝：${v.reason}`);
      onLog(`⚠ ${url} 返回的数据没通过安全校验，已丢弃（${v.reason}）`);
      continue;
    }

    const entry = {
      fetched_at: new Date().toISOString(),
      source: url,
      version: r.payload.version ?? null,
      updated: r.payload.updated ?? null,
      payload: r.payload,
    };
    writeCache(entry);
    return { ok: true, entry, count: v.cases.length, source: url };
  }
  return { ok: false, tried };
}

/**
 * 取缓存里的病例（已通过校验才会写进缓存，这里再快速校一次防手改）。
 * 返回 null 表示没有可用缓存，调用方用内置的。
 */
export function cachedCases() {
  const cache = readCache();
  if (!cache) return null;
  const v = verifyPayload(cache.payload);
  if (!v.ok) return null;
  return { cases: v.cases, meta: { fetched_at: cache.fetched_at, source: cache.source, updated: cache.updated } };
}
