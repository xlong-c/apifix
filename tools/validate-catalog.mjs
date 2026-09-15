#!/usr/bin/env node
// validate-catalog.mjs — catalog.json 结构与取值校验（零依赖 / ESM，CI 使用）
//
// 与 legacy-python/tools/validate_catalog.py 1:1 对齐：相同的检查项、报告格式与退出码。
//
// 检查项：
//   1. 合法 JSON，顶层为 {version, updated_at, models: [...]}；
//   2. id 不重复（大小写不敏感），id/vendor 为合法字符串；
//   3. 每个条目具备必需键（merge-catalog.mjs 的 REQUIRED_TOP schema）；
//   4. 无明显畸形值（context_window 正整数、range 形状、枚举、sources 链接等）；
//   5. 每个 vendor 至少 1 条。
//
// 退出码：0 通过（可能有 warning）；1 有 error。
//
// 用法：
//   node tools/validate-catalog.mjs [catalog.json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PATH = path.join(ROOT, "catalog.json");

const REQUIRED_TOP = [
  "id", "vendor", "family", "api_protocol", "verified", "lifecycle", "lifecycle_note",
  "context_window", "max_output_tokens", "reasoning", "sampling", "tools",
  "structured_output", "vision", "pdf", "caching", "aliases", "legacy_ids",
  "gotchas", "sources", "confidence",
];
const REQUIRED_REASONING = ["supported", "effort_values", "default_effort", "summary_values",
  "can_disable", "thinking_budget"];
const REQUIRED_SAMPLING = ["temperature", "top_p", "top_k"];
const REQUIRED_TOOLS = ["function_calling", "parallel", "strict", "choice_modes"];
const REQUIRED_CACHING = ["mode", "min_tokens", "ttl_options"];
const LIFECYCLES = new Set(["current", "legacy", "retired", "unreleased"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\-]*$/;

// --------------------------------------------------------------------------
// 来源白名单：sources 只接受**第一方厂商域名**（详见 CONTRIBUTING.md「来源白名单」）
//
// 规则：
//   - URL host 等于某后缀，或是它的子域，即视为该 vendor 的官方来源；
//   - github.com 之类的通用托管平台用 PATH_RULES 限定（仅特定组织路径算官方）；
//   - 云平台文档（AWS/Azure）对**非**云厂商的模型不算官方来源；
//   - 第三方聚合站/中转站/博客一律不接受。
// 注意：sources 为空数组是合法的（条目可能尚无来源）；只对"有值但非官方"报错。
// --------------------------------------------------------------------------

const OFFICIAL_DOMAINS = {
  openai: ["openai.com"],
  anthropic: ["claude.com", "anthropic.com"],
  google: ["google.dev", "google.com", "googleapis.com"],
  deepseek: ["deepseek.com"],
  alibaba: ["aliyun.com", "alibabacloud.com", "aliyuncs.com", "qwencloud.com", "qianwenai.com"],
  zhipu: ["z.ai", "bigmodel.cn"],
  moonshot: ["kimi.ai", "kimi.com", "moonshot.cn", "moonshot.ai"],
  baidu: ["baidu.com"],
  xai: ["x.ai"],
  meta: ["meta.ai", "meta.com"],
  mistral: ["mistral.ai"],
  cohere: ["cohere.com"],
  tencent: ["tencent.com", "tencent.cn", "tencentcloud.com"],
  volcengine: ["volcengine.com", "bytedance.com", "seed.bytedance.com"],
  nvidia: ["nvidia.com"],
  microsoft: ["microsoft.com", "azure.com"],
  amazon: ["aws.amazon.com", "amazon.com"],
  minimax: ["minimax.io", "minimaxi.com", "minimax.cn"],
  iflytek: ["xfyun.cn", "xf-yun.com"],
  "01ai": ["lingyiwanwu.com"],
  ai21: ["ai21.com"],
  writer: ["writer.com"],
};

// 通用托管平台：host 命中还不够，路径前缀也必须命中（vendor 必须匹配）。
const SOURCE_PATH_RULES = [
  { vendor: "alibaba", host: "github.com", pathPrefix: "/QwenLM/" },
];

function sourceHost(url) {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return { host, path: parsed.pathname };
  } catch {
    return null;
  }
}

// 该 URL 是否为 vendor 的官方来源？
function isOfficialSource(url, vendor) {
  const parsed = sourceHost(url);
  if (!parsed) return false;
  const { host, path } = parsed;

  for (const rule of SOURCE_PATH_RULES) {
    if (rule.vendor !== vendor) continue;
    if (host === rule.host || host.endsWith(`.${rule.host}`)) {
      if (path.startsWith(rule.pathPrefix)) return true;
    }
  }

  const suffixes = OFFICIAL_DOMAINS[vendor] || [];
  for (const suffix of suffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

// sources 白名单校验：报错格式固定为
//   <id>: sources 含非官方来源 <url>（vendor=<vendor>）
function checkSources(modelId, vendor, sources) {
  if (!Array.isArray(sources)) return; // 类型错误由 checkStrList 报告
  for (const src of sources) {
    if (typeof src !== "string") continue;
    if (!isOfficialSource(src, vendor)) {
      err(`${modelId}: sources 含非官方来源 ${src}（vendor=${vendor}）`);
    }
  }
}

const errors = [];
const warnings = [];

function err(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function isDict(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPosInt(v) {
  return Number.isInteger(v) && typeof v !== "boolean" && v > 0;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pyRepr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    const text = value;
    const hasSingle = text.includes("'");
    const hasDouble = text.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    return `${quote}${text}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

function pySortedKeys(list) {
  return `[${list.map((k) => pyRepr(k)).join(", ")}]`;
}

function checkRange(pathLabel, value) {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isNum)) {
    err(`${pathLabel}: range 必须是长度 2 的数值数组或 null，实际 ${pyRepr(value)}`);
    return;
  }
  if (value[0] > value[1]) {
    err(`${pathLabel}: range 下限大于上限 ${pyRepr(value)}`);
  }
}

function checkStrList(pathLabel, value) {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && x)) {
    err(`${pathLabel}: 必须是字符串数组或 null，实际 ${pyRepr(value)}`);
  }
}

// cost 一律以 USD 记录（见 merge-catalog.mjs）；非 USD 视为 error。
function checkCost(where, cost) {
  if (cost === null || cost === undefined) return; // 无定价：合法
  if (!isDict(cost)) {
    err(`${where}.cost 必须是对象或 null，实际 ${pyRepr(cost)}`);
    return;
  }

  if (typeof cost.currency !== "string" || !cost.currency) {
    err(`${where}.cost.currency 必须是非空字符串，实际 ${pyRepr(cost.currency)}`);
  } else if (cost.currency !== "USD") {
    err(`${where}.cost.currency 必须是 USD（定价统一以美元记录），实际 ${pyRepr(cost.currency)}`);
  }

  if (cost.unit !== "per_1m_tokens") {
    err(`${where}.cost.unit 必须是 "per_1m_tokens"，实际 ${pyRepr(cost.unit)}`);
  }

  for (const key of ["input", "output", "cache_read", "cache_write"]) {
    const value = cost[key];
    if (value === null || value === undefined) continue;
    if (!isNum(value) || value < 0) {
      err(`${where}.cost.${key} 必须是非负数值或 null，实际 ${pyRepr(value)}`);
    }
  }

  const over = cost.context_over_200k;
  if (over !== null && over !== undefined) {
    if (!isDict(over)) {
      err(`${where}.cost.context_over_200k 必须是对象或 null，实际 ${pyRepr(over)}`);
    } else {
      for (const key of ["input", "output"]) {
        const value = over[key];
        if (!isNum(value)) {
          err(`${where}.cost.context_over_200k.${key} 必须是数值，实际 ${pyRepr(value)}`);
        }
      }
      for (const key of ["cache_read", "cache_write"]) {
        const value = over[key];
        if (value === null || value === undefined) continue;
        if (!isNum(value) || value < 0) {
          err(`${where}.cost.context_over_200k.${key} 必须是非负数值或 null，实际 ${pyRepr(value)}`);
        }
      }
    }
  }

  const tiers = cost.tiers;
  if (tiers !== null && tiers !== undefined) {
    if (!Array.isArray(tiers)) {
      err(`${where}.cost.tiers 必须是数组或 null，实际 ${pyRepr(tiers)}`);
    } else {
      tiers.forEach((tier, i) => {
        if (!isDict(tier)) {
          err(`${where}.cost.tiers[${i}] 必须是对象，实际 ${pyRepr(tier)}`);
          return;
        }
        // 档位边界三种等价写法（恰好一个）：
        //   max_input        —— 不超过这么多 input tokens（数值，上限口径）
        //   min_input_tokens —— 从这么多 input tokens 起（数值，下限口径）
        //   condition        —— 人类可读的区间描述（非空字符串）
        const hasMax = tier.max_input !== null && tier.max_input !== undefined;
        const hasMin = tier.min_input_tokens !== null && tier.min_input_tokens !== undefined;
        const hasCond = tier.condition !== null && tier.condition !== undefined;
        const count = (hasMax ? 1 : 0) + (hasMin ? 1 : 0) + (hasCond ? 1 : 0);
        if (count === 0) {
          err(`${where}.cost.tiers[${i}] 缺少档位边界（max_input / min_input_tokens / condition 三选一）`);
        } else if (count > 1) {
          err(`${where}.cost.tiers[${i}] 档位边界只能给一个（max_input / min_input_tokens / condition 三选一）`);
        } else if (hasMax && (!isNum(tier.max_input) || tier.max_input <= 0)) {
          err(`${where}.cost.tiers[${i}].max_input 必须是正数值，实际 ${pyRepr(tier.max_input)}`);
        } else if (hasMin && (!isNum(tier.min_input_tokens) || tier.min_input_tokens <= 0)) {
          err(`${where}.cost.tiers[${i}].min_input_tokens 必须是正数值，实际 ${pyRepr(tier.min_input_tokens)}`);
        } else if (hasCond && (typeof tier.condition !== "string" || !tier.condition.trim())) {
          err(`${where}.cost.tiers[${i}].condition 必须是非空字符串，实际 ${pyRepr(tier.condition)}`);
        }
        for (const key of ["input", "output"]) {
          const value = tier[key];
          if (!isNum(value)) {
            err(`${where}.cost.tiers[${i}].${key} 必须是数值，实际 ${pyRepr(value)}`);
          }
        }
        for (const key of ["cache_read", "cache_write"]) {
          const value = tier[key];
          if (value === null || value === undefined) continue;
          if (!isNum(value) || value < 0) {
            err(`${where}.cost.tiers[${i}].${key} 必须是非负数值或 null，实际 ${pyRepr(value)}`);
          }
        }
      });
    }
  }

  const asOf = cost.as_of;
  if (asOf !== null && asOf !== undefined && typeof asOf !== "string") {
    err(`${where}.cost.as_of 必须是字符串或 null，实际 ${pyRepr(asOf)}`);
  }

  checkStrList(`${where}.cost.sources`, cost.sources);

  const confidence = cost.confidence;
  if (confidence !== null && confidence !== undefined && !CONFIDENCES.has(confidence)) {
    err(`${where}.cost.confidence 非法 ${pyRepr(confidence)}`);
  }
}

function checkEntry(entry, index) {
  let where = `models[${index}]`;
  if (!isDict(entry)) {
    err(`${where}: 条目必须是对象`);
    return;
  }
  const modelId = entry.id;
  where = typeof modelId === "string" ? `models[${index}] (${modelId})` : where;

  for (const key of REQUIRED_TOP) {
    if (!(key in entry)) err(`${where}: 缺少必需键 ${pyRepr(key)}`);
  }

  if (typeof modelId !== "string" || !modelId) {
    err(`${where}: id 必须是非空字符串`);
  } else if (!ID_RE.test(modelId)) {
    err(`${where}: id 含可疑字符 ${pyRepr(modelId)}`);
  }

  const vendor = entry.vendor;
  if (typeof vendor !== "string" || !vendor) {
    err(`${where}: vendor 必须是非空字符串`);
  }

  for (const key of ["context_window", "max_output_tokens"]) {
    const value = entry[key];
    if (value !== null && value !== undefined && !isPosInt(value)) {
      err(`${where}: ${key} 必须是正整数或 null，实际 ${pyRepr(value)}`);
    }
  }

  const verified = entry.verified;
  if (typeof verified !== "boolean") {
    err(`${where}: verified 必须是 bool，实际 ${pyRepr(verified)}`);
  }

  const lifecycle = entry.lifecycle;
  if (lifecycle !== null && lifecycle !== undefined && !LIFECYCLES.has(lifecycle)) {
    err(`${where}: lifecycle 非法 ${pyRepr(lifecycle)}（允许 current/legacy/retired/unreleased/null）`);
  }

  const confidence = entry.confidence;
  if (confidence !== null && confidence !== undefined && !CONFIDENCES.has(confidence)) {
    err(`${where}: confidence 非法 ${pyRepr(confidence)}`);
  }

  for (const key of ["vision", "pdf"]) {
    const value = entry[key];
    if (value !== null && value !== undefined && typeof value !== "boolean") {
      err(`${where}: ${key} 必须是 bool 或 null，实际 ${pyRepr(value)}`);
    }
  }

  const reasoning = entry.reasoning;
  if (!isDict(reasoning)) {
    err(`${where}: reasoning 必须是对象`);
  } else {
    for (const key of REQUIRED_REASONING) {
      if (!(key in reasoning)) err(`${where}.reasoning: 缺少键 ${pyRepr(key)}`);
    }
    for (const key of ["supported", "can_disable"]) {
      const value = reasoning[key];
      if (value !== null && value !== undefined && typeof value !== "boolean") {
        err(`${where}.reasoning.${key} 必须是 bool 或 null`);
      }
    }
    for (const key of ["effort_values", "summary_values"]) {
      checkStrList(`${where}.reasoning.${key}`, reasoning[key]);
    }
    const budget = reasoning.thinking_budget;
    if (budget !== null && budget !== undefined && !isDict(budget)) {
      err(`${where}.reasoning.thinking_budget 必须是对象或 null，实际 ${pyRepr(budget)}`);
    } else if (isDict(budget)) {
      const allowed = new Set(["min", "max", "less_than_max_tokens"]);
      const unknown = Object.keys(budget).filter((k) => !allowed.has(k));
      if (unknown.length) {
        warn(`${where}.reasoning.thinking_budget 含未知键 ${pySortedKeys(unknown.sort())}`);
      }
    }
  }

  const sampling = entry.sampling;
  if (!isDict(sampling)) {
    err(`${where}: sampling 必须是对象`);
  } else {
    for (const name of REQUIRED_SAMPLING) {
      const param = sampling[name];
      if (!isDict(param)) {
        err(`${where}.sampling.${name} 必须是对象`);
        continue;
      }
      const supported = param.supported;
      if (supported !== null && supported !== undefined && typeof supported !== "boolean") {
        err(`${where}.sampling.${name}.supported 必须是 bool 或 null`);
      }
      checkRange(`${where}.sampling.${name}.range`, param.range);
    }
  }

  const tools = entry.tools;
  if (!isDict(tools)) {
    err(`${where}: tools 必须是对象`);
  } else {
    for (const key of REQUIRED_TOOLS) {
      if (!(key in tools)) err(`${where}.tools: 缺少键 ${pyRepr(key)}`);
    }
    for (const key of ["function_calling", "parallel", "strict"]) {
      const value = tools[key];
      if (value !== null && value !== undefined && typeof value !== "boolean") {
        err(`${where}.tools.${key} 必须是 bool 或 null`);
      }
    }
    checkStrList(`${where}.tools.choice_modes`, tools.choice_modes);
  }

  const structured = entry.structured_output;
  if (!isDict(structured)) {
    err(`${where}: structured_output 必须是对象`);
  } else if (
    structured.supported !== null &&
    structured.supported !== undefined &&
    typeof structured.supported !== "boolean"
  ) {
    err(`${where}.structured_output.supported 必须是 bool 或 null`);
  }

  const caching = entry.caching;
  if (!isDict(caching)) {
    err(`${where}: caching 必须是对象`);
  } else {
    for (const key of REQUIRED_CACHING) {
      if (!(key in caching)) err(`${where}.caching: 缺少键 ${pyRepr(key)}`);
    }
    const minTokens = caching.min_tokens;
    if (minTokens !== null && minTokens !== undefined && !isPosInt(minTokens)) {
      err(`${where}.caching.min_tokens 必须是正整数或 null`);
    }
    checkStrList(`${where}.caching.ttl_options`, caching.ttl_options);
  }

  const aliases = entry.aliases;
  checkStrList(`${where}.aliases`, aliases);
  if (Array.isArray(aliases)) {
    for (const alias of aliases) {
      if (alias === modelId) warn(`${where}: aliases 含自身 id ${pyRepr(alias)}（匹配无影响）`);
    }
  }

  const legacy = entry.legacy_ids;
  if (legacy === null || legacy === undefined || !Array.isArray(legacy)) {
    err(`${where}.legacy_ids 必须是数组`);
  } else {
    for (const item of legacy) {
      if (!isDict(item) || typeof item.id !== "string" || !item.id) {
        err(`${where}.legacy_ids: 每项必须是 {'id': str, 'note': str|null}，实际 ${pyRepr(item)}`);
        continue;
      }
      const note = item.note;
      if (note !== null && note !== undefined && typeof note !== "string") {
        err(`${where}.legacy_ids[${item.id}].note 必须是字符串或 null`);
      }
    }
  }

  checkStrList(`${where}.gotchas`, entry.gotchas);

  checkCost(where, entry.cost);

  const sources = entry.sources;
  checkStrList(`${where}.sources`, sources);
  if (Array.isArray(sources)) {
    for (const src of sources) {
      if (typeof src !== "string" || !(src.startsWith("http://") || src.startsWith("https://"))) {
        err(`${where}.sources: 非 http(s) 链接 ${pyRepr(src)}`);
      }
    }
    // 只接受第一方厂商来源（空数组合法；有值但非官方 → error）
    checkSources(modelId, vendor, sources);
  }

  if (lifecycle === "unreleased" && isPosInt(entry.context_window)) {
    warn(`${where}: lifecycle=unreleased 但已填 context_window=${entry.context_window}，请确认`);
  }
}

function main(argv) {
  const filePath = argv.length ? argv[0] : DEFAULT_PATH;

  let data;
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    process.stderr.write(`[x] 无法读取 ${filePath}: ${error.message}\n`);
    return 1;
  }
  try {
    data = JSON.parse(text);
  } catch (error) {
    process.stderr.write(`[x] ${filePath} 不是合法 JSON: ${error.message}\n`);
    return 1;
  }

  if (!isDict(data) || !Array.isArray(data.models)) {
    process.stderr.write(`[x] ${filePath} 顶层必须是 {version, updated_at, models: [...]}\n`);
    return 1;
  }

  const models = data.models;
  if (!models.length) err("models 为空数组");

  const seen = new Map();
  models.forEach((entry, index) => {
    checkEntry(entry, index);
    if (isDict(entry) && typeof entry.id === "string") {
      const low = entry.id.toLowerCase();
      if (seen.has(low)) {
        const prev = models[seen.get(low)];
        err(`id 重复（大小写不敏感）：${pyRepr(entry.id)} 与 models[${seen.get(low)}] 的 ${pyRepr(prev ? prev.id : null)}`);
      } else {
        seen.set(low, index);
      }
    }
  });

  const vendors = new Set(models.filter(isDict).map((e) => e.vendor));
  if (!vendors.size) err("没有任何 vendor");
  if (data.version === null || data.version === undefined) warn("顶层缺少 version");
  if (data.updated_at === null || data.updated_at === undefined) warn("顶层缺少 updated_at");

  for (const item of warnings) process.stdout.write(`[!] ${item}\n`);
  for (const item of errors) process.stdout.write(`[x] ${item}\n`);

  process.stdout.write(
    `[i] ${filePath}: ${models.length} 条，${vendors.size} 个 vendor，` +
      `${errors.length} 个 error，${warnings.length} 个 warning\n`,
  );
  return errors.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
