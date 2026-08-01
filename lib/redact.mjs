/**
 * 脱敏。本地先做一遍，任何地方要展示/落盘/提交都必须过这里。
 * 原则：宁可多删，不可漏。看不懂的东西一律当敏感处理。
 */

const RULES = [
  // API Key / Token：各家前缀
  [/\b(sk|xai|ghp|gho|ghs|ghu|glpat|xoxb|xoxp|AIza)[-_][A-Za-z0-9_-]{10,}\b/g, "<API_KEY>"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<API_KEY>"],
  [/(authorization\s*:\s*bearer\s+)\S+/gi, "$1<TOKEN>"],
  [/\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|pwd)(\s*[=:]\s*)\S+/gi, "$1$2<REDACTED>"],
  [/([?&](?:token|key|api_key|access_token|sig|signature)=)[^&#\s]+/gi, "$1<REDACTED>"],
  // 路径里的用户名
  [/([A-Za-z]:\\Users\\)[^\\/\s"']+/g, "$1<USER>"],
  [/(\/(?:home|Users)\/)[^/\s"']+/g, "$1<USER>"],
  // 身份
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<EMAIL>"],
  [/\b1[3-9]\d{9}\b/g, "<PHONE>"],
  // 内网地址
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, "<PRIVATE_IP>"],
  // 机器标识常见形态
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>"],
];

export function redact(text) {
  if (typeof text !== "string") return text;
  return RULES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
