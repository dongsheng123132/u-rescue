#!/usr/bin/env node
/**
 * 生成仓库根目录的 cases.json —— 全量病例的机器可读索引。
 *
 * 为什么要提交进版本库（而不是只放 dist/）：
 *   raw.githubusercontent.com 只能服务仓库里真实存在的文件。这份索引是
 *   `npx u-rescue update` 的兜底源，站点挂了也还能更新。
 *
 * CI 会检查它有没有过期（生成后 git diff 必须为空），所以改完病例记得跑一次
 * `npm run build`，否则 PR 会红。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, isStale, STALE_AFTER_DAYS, ROOT } from "../lib/cases.mjs";

const SITE_BASE = process.env.URESCUE_SITE_BASE || "https://u-claw.org.cn/rescue";
const cases = loadCases();

const index = {
  schema: "u-rescue/case@1",
  version: 1,
  // 用最新病例的验证日期，而不是当前时间 —— 否则每次跑都产生 diff，
  // CI 的「有没有过期」检查就永远是红的。
  updated: cases.map((c) => c.verified_on.date).sort().at(-1),
  count: cases.length,
  site: SITE_BASE,
  repo: "https://github.com/dongsheng123132/u-rescue",
  stale_after_days: STALE_AFTER_DAYS,
  cases: cases.map(({ _file, ...c }) => ({ ...c, stale: isStale(c), url: `${SITE_BASE}/${c.id}.html` })),
};

writeFileSync(join(ROOT, "cases.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
console.log(`cases.json 已更新：${cases.length} 条，最新验证日期 ${index.updated}`);
