/** 病例加载 + 搜索匹配。纯 Node 内置，无依赖。 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CASES_DIR = join(ROOT, "cases");

/** 超过这个天数的病例，在网页和 skill 里降级为「仅供参考」。上游会改，方案会过期。 */
export const STALE_AFTER_DAYS = 180;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function loadCases() {
  return walk(CASES_DIR)
    .map((file) => {
      try {
        return { ...JSON.parse(readFileSync(file, "utf8")), _file: file };
      } catch (err) {
        throw new Error(`病例 JSON 解析失败: ${file}\n${err.message}`);
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 病例是否过期。过期不等于错，等于「没人最近验过，别闭眼执行」。 */
export function isStale(c, today = new Date()) {
  const d = new Date(c.verified_on?.date ?? "1970-01-01");
  return (today - d) / 86400000 > STALE_AFTER_DAYS;
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * 把查询切成可比对的片段。
 *
 * 中文没有空格，按空白切词等于没切 —— 用户搜「装成功了但是找不到命令」时，
 * 整串跟任何一条症状都不完全相等，于是一条都搜不到。所以中文段落额外出 3/4 字滑窗，
 * 让「找不到命令」这样的核心短语能命中。（冒烟测试里有一条专门守着这个。）
 */
function tokenize(q) {
  const terms = new Set([q]);
  for (const t of q.split(/[\s,，。:：;；|、（）()"'`]+/)) {
    if (t.length >= 3) terms.add(t);
  }
  for (const run of q.match(/[一-龥]{3,}/g) ?? []) {
    for (const n of [3, 4]) {
      for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n));
    }
  }
  return [...terms];
}

/**
 * 文本搜索。报错原文命中权重最高——用户最常做的事就是把报错整段粘进来。
 * 返回 [{case, score, hits}]，score>0 才算命中。
 */
export function searchCases(cases, query) {
  const q = norm(query);
  if (!q) return [];
  const terms = tokenize(q);

  // 按「匹配到的片段有多长」给分，而不是按命中在哪个字段给固定分。
  // 否则 3 字的「找不到」会和整段报错拿一样的权重，把真正对得上的病例挤下去。
  const best = (text) => {
    const nt = norm(text);
    let longest = 0;
    for (const t of terms) if (t.length > longest && nt.includes(t)) longest = t.length;
    return longest;
  };

  return cases
    .map((c) => {
      let score = 0;
      const hits = [];

      for (const e of c.errors ?? []) {
        const ne = norm(e);
        // 用户把报错整段粘进来 —— 这是最强信号，直接压过一切。
        if (ne.length >= 6 && (q.includes(ne) || ne.includes(q))) { score += 40; hits.push(`报错: ${e}`); continue; }
        const n = best(e);
        if (n) { score += n; hits.push(`报错: ${e}`); }
      }
      // 症状是用户自己的说法。用自然语言描述问题时，它比报错片段更该说话。
      for (const s of c.symptoms ?? []) {
        const n = best(s);
        if (n) { score += n * 1.5; hits.push(`症状: ${s}`); }
      }
      score += best(c.title);
      for (const tag of c.tags ?? []) if (best(tag)) score += 2;

      return { case: c, score, hits: [...new Set(hits)].slice(0, 3) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
