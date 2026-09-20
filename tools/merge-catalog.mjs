#!/usr/bin/env node
// merge-catalog.mjs — 把 incoming/*.json 批次合并进 catalog/（零依赖 / ESM）
//
// 与 legacy-python/tools/merge_catalog.py 1:1 对齐：相同的规范化、去重优先级、
// 报告格式与退出码（模型条目部分）。
//
// 做三件事：
//   1. 读取 incoming/ 下所有批次文件（有 models 列表的）+ 现有 catalog/（或 catalog.json）；
//   2. 规范化条目 schema（缺失字段补 null/[]、sampling range 字符串转数组等）；
//   3. 按 id 去重，写回 catalog/<vendor>.json，再调用 build-catalog.mjs 打包 catalog.json。
//
// catalog/ 是唯一数据源（一厂商一文件，人工编辑这里）；catalog.json 是生成物。
// 合并脚本不再直接写 catalog.json —— 写完 catalog/ 后统一走 buildCatalog()。
//
// 另外处理官方定价：incoming/pricing-*.json 是**独立**的 cost 来源（不是模型批次），
// 按 id 精确匹配 catalog 条目，写入 cost 字段（详见 normalizeCost / applyCosts）。
//
// 去重优先级：
//   * catalog/ 的手工条目 优先于 批次条目（同一 id），
//     但批次 verified=true 而 catalog verified 非 true 时，批次优先；
//   * 批次之间：非空字段多者优先；同分时 confidence 高者优先；
//   * 云镜像重复：保留原生 vendor / 原生批次；
//   * 其余同分情况按 原生批次 > -full 批次 > 文件名字典序 兜底。
//
// 定价优先级：
//   * pricing 文件（最新研究）覆盖 catalog/ 里的旧 cost（价格会过时）；
//   * 多个 pricing 文件提到同一 id：confidence 高者优先，同分取文件名字典序靠后者；
//   * 未被任何 pricing 文件提及 → cost: null（cost 完全由 pricing 文件派生）。
//
// 用法：
//   node tools/merge-catalog.mjs            # 合并并写回 catalog/ + catalog.json
//   node tools/merge-catalog.mjs --dry-run  # 只打印报告，不写文件

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildCatalog, writeBundle, writeVendorFiles, CATALOG_DIR, CATALOG_PATH } from "./build-catalog.mjs";
import { filterOfficialSources } from "./source-whitelist.mjs";
import { CONF_RANK, LIFECYCLES, REQUIRED_TOP, tierBoundaries } from "./schema.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INCOMING_DIR = path.join(ROOT, "incoming");
const UPDATED_AT = "2026-09-20";
const CATALOG_VERSION = 2;

// 定价一律以 USD 记录（opencode 等客户端只认美元）。研究批次本应直接给出 USD；
// 若仍出现非 USD 条目，用下面这个**固定兜底汇率**（最后手段，非实时行情）换算，
// 并在该条 cost.note 里保留原始值 + 换算说明。改动此值会改变已生成的 cost，需重跑 merge。
const FALLBACK_CNY_USD_RATE = 7.2;
const COST_UNIT = "per_1m_tokens";
const PRICING_FILE_PREFIX = "pricing-";
// 换算结果保留 6 位小数（远细于任何真实单价），避免浮点长尾
const COST_ROUND_DIGITS = 6;

// CONF_RANK 与 LIFECYCLES 从 tools/schema.mjs 导入（validate 与 merge 共用的
// 单一事实源）；normalizeEntry 对 confidence/lifecycle 的枚举收窄语义不变。

// 这些 vendor 在 western 批次里存在“云镜像”条目（Azure/Bedrock 口径），
// 若同一 id 在原生批次里也有，则优先原生批次（任务约定的 canonical vendor）。
const MIRROR_VENDORS = new Set(["anthropic", "openai", "xai", "meta"]);

// 每个 vendor 的原生批次（同 id 同 vendor 冲突时的次级 tiebreak）
const ORIGIN_BATCH = {
  anthropic: "anthropic-2026-full.json",
  openai: "openai-2026-full.json",
  xai: "western-2026-full.json",
  meta: "western-2026-full.json",
  google: "western-2026-full.json",
  mistral: "western-2026-full.json",
  cohere: "western-2026-full.json",
  amazon: "western-2026-full.json",
  microsoft: "western-2026-full.json",
  nvidia: "western-2026-full.json",
  ai21: "western-2026-full.json",
  writer: "western-2026-full.json",
  baidu: "china-2026-full.json",
  alibaba: "china-2026-full.json",
  minimax: "china-2026-full.json",
  tencent: "china-2026-full.json",
  volcengine: "china-2026-full.json",
  iflytek: "china-2026-full.json",
  "01ai": "china-2026-full.json",
  deepseek: "dsk-zhipu-moonshot-2026-full.json",
  zhipu: "dsk-zhipu-moonshot-2026-full.json",
  moonshot: "dsk-zhipu-moonshot-2026-full.json",
};

// 模型 id 前缀 → 原生 vendor（用于识别跨 vendor 的云镜像重复）
const ORIGIN_VENDOR_PREFIXES = [
  ["anthropic", ["claude-"]],
  ["openai", ["gpt-", "o1", "o3", "o4", "chatgpt-", "text-embedding-", "gpt-oss"]],
  ["xai", ["grok-"]],
  ["meta", ["llama-", "llama2", "llama3"]],
  ["google", ["gemini-", "palm-", "imagen-", "veo-"]],
  ["mistral", ["mistral", "codestral", "ministral", "magistral", "pixtral", "devstral"]],
  ["cohere", ["command", "embed-", "rerank-"]],
  ["amazon", ["amazon.", "nova-", "titan-"]],
  ["microsoft", ["phi-", "mai-"]],
  ["nvidia", ["nvidia/", "nvidia.", "nemotron"]],
  ["baidu", ["ernie-"]],
  ["alibaba", ["qwen"]],
  ["volcengine", ["doubao-"]],
  ["tencent", ["hunyuan-"]],
  ["iflytek", ["spark-"]],
  ["01ai", ["yi-"]],
  ["zhipu", ["glm-"]],
  ["moonshot", ["kimi-", "moonshot-"]],
  ["deepseek", ["deepseek-"]],
  ["minimax", ["minimax-", "abab"]],
  ["ai21", ["jamba-"]],
  ["writer", ["palmyra-"]],
];

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

function isBlank(value) {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// 统计叶子层的非空值数量，用于比较条目信息量。
function deepNonNull(value) {
  if (isBlank(value)) return 0;
  if (Array.isArray(value)) return 1 + value.reduce((sum, v) => sum + deepNonNull(v), 0);
  if (typeof value === "object") {
    return Object.values(value).reduce((sum, v) => sum + deepNonNull(v), 0);
  }
  return 1;
}

function originVendorFor(modelId) {
  const low = String(modelId || "").toLowerCase();
  for (const [vendor, prefixes] of ORIGIN_VENDOR_PREFIXES) {
    if (prefixes.some((p) => low.startsWith(p))) return vendor;
  }
  return null;
}

const RANGE_RE = /^\s*([[(])\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*([\])])\s*$/;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pyStr(value) {
  // 贴近 Python repr 的字符串引号规则：优先单引号，含单引号且不含双引号时用双引号
  const text = String(value);
  const hasSingle = text.includes("'");
  const hasDouble = text.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = text.replace(/\\/g, "\\\\");
  if (quote === "'") body = body.replace(/'/g, "\\'");
  else body = body.replace(/"/g, '\\"');
  body = body
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `${quote}${body}${quote}`;
}

function pyRepr(value) {
  // 仅用于报告文本，尽量贴近 Python repr 的常见形态
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return pyStr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

function pyTypeName(value) {
  if (value === null) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "dict";
  return typeof value;
}

// 把 '[0,2]' / '(0,1]' 之类的字符串转成 [0,2] / [0,1]。返回 [值, note]。
function parseRange(raw, report, where) {
  if (raw === null || raw === undefined) return [null, null];
  if (Array.isArray(raw)) {
    if (raw.length === 2 && raw.every(isNum)) return [raw.slice(), null];
    report.range_bad.push(`${where}: 区间数组形状异常 ${pyRepr(raw)} → null`);
    return [null, `原始区间 ${pyRepr(raw)} 形状异常，已置 null`];
  }
  if (isNum(raw)) return [[raw, raw], `原始区间为标量 ${pyRepr(raw)}，按 [x, x] 记录`];
  if (typeof raw !== "string") {
    report.range_bad.push(`${where}: 区间类型异常 ${pyTypeName(raw)} → null`);
    return [null, `原始区间类型异常（${pyTypeName(raw)}），已置 null`];
  }

  const match = RANGE_RE.exec(raw);
  if (!match) {
    report.range_bad.push(`${where}: 无法解析区间 ${pyRepr(raw)} → null`);
    return [null, `原始区间字符串 ${pyRepr(raw)} 无法解析，已置 null`];
  }

  const [, left, loRaw, hiRaw, right] = match;
  let lo = loRaw.includes(".") ? Number.parseFloat(loRaw) : Number.parseInt(loRaw, 10);
  let hi = hiRaw.includes(".") ? Number.parseFloat(hiRaw) : Number.parseInt(hiRaw, 10);
  if (lo === Math.trunc(lo)) lo = Math.trunc(lo);
  if (hi === Math.trunc(hi)) hi = Math.trunc(hi);
  let note = null;
  if (left === "(" || right === ")") {
    note = `原始文档写法 "${raw}"（开区间）；端点按闭区间取值记录`;
    report.range_open.push(`${where}: ${pyRepr(raw)} → [${lo}, ${hi}]`);
  }
  report.range_ok += 1;
  return [[lo, hi], note];
}

function normalizeLegacyIds(raw, report, where) {
  const out = [];
  const seen = new Set();
  for (let item of raw || []) {
    if (typeof item === "string") {
      item = { id: item, note: "" };
      report.legacy_coerced.push(`${where}: legacy_ids 字符串 ${pyRepr(item.id)} → dict`);
    }
    if (typeof item !== "object" || item === null || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
      report.legacy_dropped.push(`${where}: 非法 legacy_ids 项 ${pyRepr(item)}`);
      continue;
    }
    if (seen.has(item.id)) {
      report.legacy_dropped.push(`${where}: 重复 legacy id ${pyRepr(item.id)}`);
      continue;
    }
    seen.add(item.id);
    const note = item.note;
    out.push({ id: item.id, note: typeof note === "string" ? note : null });
  }
  return out;
}

function normalizeAliases(raw, modelId, report, where) {
  const out = [];
  for (const item of raw || []) {
    if (typeof item !== "string" || !item) {
      report.alias_dropped.push(`${where}: 非法 alias ${pyRepr(item)}`);
      continue;
    }
    if (item === modelId) {
      report.self_alias.push(`${where}: 自身别名 ${pyRepr(item)}`);
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function normalizeThinkingBudget(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return {
      min: raw.min === undefined ? null : raw.min,
      max: raw.max === undefined ? null : raw.max,
      less_than_max_tokens: raw.less_than_max_tokens === undefined ? null : raw.less_than_max_tokens,
    };
  }
  return raw;
}

function normalizeSamplingParam(raw, where, report) {
  const param = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  if (param !== raw) {
    report.sampling_fixed.push(`${where}: sampling 项非对象 ${pyRepr(raw)} → 空对象`);
  }
  let [value, note] = parseRange(param.range, report, where);
  if (note === null && typeof param.range_note === "string" && param.range_note) {
    // 已转换过的条目（catalog 里的 range_note）：重复合并时保留原注释
    note = param.range_note;
  }
  const constraint = param.constraint;
  const out = {
    supported: param.supported === undefined ? null : param.supported,
    range: value,
    constraint: constraint === "" || constraint === undefined ? null : constraint,
  };
  if (note) out.range_note = note;
  return out;
}

// --------------------------------------------------------------------------
// 定价（cost）
// --------------------------------------------------------------------------

function roundCost(value) {
  if (!isNum(value)) return null;
  const factor = 10 ** COST_ROUND_DIGITS;
  return Math.round(value * factor) / factor;
}

// 把 pricing 文件里的一条模型定价规范化成 catalog 的 cost 结构（一律 USD）。
// 返回 { cost, converted }：converted=true 表示做了非 USD → USD 兜底换算。
function normalizeCost(raw, src, report) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    report.cost_dropped.push(`${src}: 定价条目不是对象 ${pyRepr(raw)}`);
    return null;
  }
  const modelId = raw.id;
  if (typeof modelId !== "string" || !modelId) {
    report.cost_dropped.push(`${src}: 定价条目缺少合法 id：${pyRepr(raw)}`);
    return null;
  }
  const where = `${src}:${modelId}`;

  const currency = typeof raw.currency === "string" && raw.currency ? raw.currency.toUpperCase() : null;
  if (!currency) {
    report.cost_dropped.push(`${where}: 缺少 currency，无法确定币种`);
    return null;
  }
  const converted = currency !== "USD";
  let rate = null;
  if (converted) {
    if (currency !== "CNY") {
      // 只认 CNY 兜底换算；其他币种直接丢弃（不臆造汇率）
      report.cost_dropped.push(`${where}: 币种 ${pyRepr(currency)} 无兜底汇率，已丢弃`);
      return null;
    }
    rate = FALLBACK_CNY_USD_RATE;
    report.cost_converted.push(`${where}: ${currency} → USD（按 1 USD = ${rate} CNY）`);
  }

  const conv = (value) => {
    if (value === null || value === undefined) return null;
    if (!isNum(value)) return null;
    return converted ? roundCost(value / rate) : roundCost(value);
  };

  const input = conv(raw.input);
  const output = conv(raw.output);
  const cacheRead = conv(raw.cache_read);
  const cacheWrite = conv(raw.cache_write);

  let over200k = null;
  if (raw.context_over_200k !== null && raw.context_over_200k !== undefined) {
    const src200k = asObj(raw.context_over_200k);
    over200k = {
      input: conv(src200k.input),
      output: conv(src200k.output),
      cache_read: conv(src200k.cache_read),
      cache_write: conv(src200k.cache_write),
    };
  }

  let tiers = null;
  if (Array.isArray(raw.tiers) && raw.tiers.length) {
    tiers = raw.tiers.map((tier) => {
      const t = asObj(tier);
      // 三种等价的档位边界写法都接受，且**保留作者写的那一侧**（不重写数据）：
      //   max_input        —— 该档适用于「不超过」这么多 input tokens（数值，上限口径）
      //   min_input_tokens —— 该档适用于「从」这么多 input tokens 起（数值，下限口径）
      //   condition        —— 人类可读的区间描述（字符串，如 "输入长度(32,128]"）
      // 恰好一个必须存在（merge 侧宽容，缺失则记 null 占位由 validate 兜底）。
      // 边界字段名与「恰有其一」判别统一走 tools/schema.mjs（tierBoundaries）。
      const { hasMax, hasMin, hasCond } = tierBoundaries(t);
      const out = {};
      if (hasMax) out.max_input = isNum(t.max_input) ? t.max_input : null;
      if (hasMin) out.min_input_tokens = isNum(t.min_input_tokens) ? t.min_input_tokens : null;
      if (hasCond) out.condition = typeof t.condition === "string" ? t.condition : null;
      if (!hasMax && !hasMin && !hasCond) {
        // 三种边界键都没有：保留 max_input: null 占位，validate 会报 error
        out.max_input = null;
      }
      out.input = conv(t.input);
      out.output = conv(t.output);
      if (t.cache_read !== undefined) out.cache_read = conv(t.cache_read);
      if (t.cache_write !== undefined) out.cache_write = conv(t.cache_write);
      return out;
    });
  }

  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((s) => typeof s === "string" && s)
    : [];

  let note = typeof raw.note === "string" && raw.note ? raw.note : null;
  if (converted) {
    const original = [];
    if (isNum(raw.input)) original.push(`input=${raw.input}`);
    if (isNum(raw.output)) original.push(`output=${raw.output}`);
    if (isNum(raw.cache_read)) original.push(`cache_read=${raw.cache_read}`);
    const detail = original.length ? `；原始 ${currency} 值：${original.join("、")}` : "";
    const suffix = `（合并时按 1 USD = ${rate} CNY 换算${detail}）`;
    note = note ? `${note} ${suffix}` : `原币种定价${suffix}`;
  }

  return {
    currency: "USD",
    unit: COST_UNIT,
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    context_over_200k: over200k,
    tiers,
    note,
    as_of: typeof raw.as_of === "string" ? raw.as_of : null,
    sources,
    confidence: raw.confidence === undefined ? null : raw.confidence,
  };
}

// 读取 incoming/pricing-*.json；返回 Map<id, {cost, file, confidence}>（已按优先级择优）。
function loadPricing(report) {
  let names;
  try {
    names = readdirSync(INCOMING_DIR)
      .filter((name) => name.startsWith(PRICING_FILE_PREFIX) && name.endsWith(".json"))
      .sort();
  } catch {
    names = [];
  }

  const best = new Map();
  for (const name of names) {
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(INCOMING_DIR, name), "utf8"));
    } catch (err) {
      report.cost_file_skipped.push(`${name}: 读取失败 ${err.message}`);
      continue;
    }
    const models = typeof data === "object" && data !== null ? data.models : null;
    if (!Array.isArray(models) || !models.length) {
      report.cost_file_skipped.push(`${name}: 无 models 列表（非定价文件）`);
      continue;
    }
    if (typeof data.unit === "string" && data.unit !== COST_UNIT) {
      report.cost_file_skipped.push(`${name}: unit=${pyRepr(data.unit)} ≠ ${COST_UNIT}，已跳过`);
      continue;
    }
    report.cost_files_used.push(name);
    for (const raw of models) {
      const cost = normalizeCost(raw, name, report);
      if (!cost) continue;
      const id = raw.id;
      const rank = CONF_RANK[cost.confidence] || 0;
      const prev = best.get(id);
      // 最新研究优先：confidence 高者胜；同分取文件名字典序靠后者（names 已升序）
      if (!prev || rank > prev.rank || (rank === prev.rank && name >= prev.file)) {
        best.set(id, { cost, file: name, rank });
      } else {
        report.cost_superseded.push(
          `${id}: 忽略 ${name} 的定价（confidence=${pyRepr(cost.confidence)}，保留 ${prev.file}）`,
        );
      }
    }
  }
  return best;
}

// 把定价写入合并后的条目；未被任何定价文件提及 → cost: null。
function applyCosts(merged, pricing, report) {
  let withCost = 0;
  let nullCost = 0;
  const byCurrency = new Map();
  for (const entry of merged) {
    const hit = pricing.get(entry.id);
    if (hit) {
      entry.cost = hit.cost;
      withCost += 1;
      byCurrency.set(hit.cost.currency, (byCurrency.get(hit.cost.currency) || 0) + 1);
      report.cost_applied.push(`${entry.id}: ← ${hit.file}`);
    } else {
      entry.cost = null;
      nullCost += 1;
    }
  }
  return { withCost, nullCost, byCurrency };
}

// REQUIRED_TOP 从 tools/schema.mjs 导入（与 validate 共用同一份词表；
// normalizeEntry 末尾用它做「schema 漏字段」守卫）。

// catalog 条目缺失这些键时，允许用批次条目补齐（不覆盖 catalog 已有的值）
const BACKFILL_KEYS = ["lifecycle", "lifecycle_note", "legacy_ids", "aliases", "sources", "gotchas"];

// 仅剩非官方来源时的降级标记（与上一轮人工清理的文案完全一致）
const SOURCE_DOWNGRADE_GOTCHA = "非官方来源，规格待核验（原来源为第三方/云平台文档）";

function asObj(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function getOr(raw, key, dflt) {
  return raw[key] === undefined ? dflt : raw[key];
}

// 把批次/目录条目规范成统一 schema。
function normalizeEntry(raw, src, report) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    report.entry_dropped.push(`${src}: 条目不是对象 ${pyRepr(raw)}`);
    return null;
  }
  const modelId = raw.id;
  if (typeof modelId !== "string" || !modelId) {
    report.entry_dropped.push(`${src}: 条目缺少合法 id：${pyRepr(raw)}`);
    return null;
  }
  const where = `${src}:${modelId}`;

  let contextWindow = raw.context_window;
  if (typeof contextWindow === "boolean" || !Number.isInteger(contextWindow)) {
    if (contextWindow !== null && contextWindow !== undefined) {
      report.type_fixed.push(`${where}: context_window=${pyRepr(contextWindow)} → null`);
    }
    contextWindow = null;
  }

  let maxOutput = raw.max_output_tokens;
  if (typeof maxOutput === "boolean" || !Number.isInteger(maxOutput)) {
    if (maxOutput !== null && maxOutput !== undefined) {
      report.type_fixed.push(`${where}: max_output_tokens=${pyRepr(maxOutput)} → null`);
    }
    maxOutput = null;
  }

  let confidence = raw.confidence;
  if (confidence === undefined || !(confidence in CONF_RANK)) {
    if (confidence !== null && confidence !== undefined) {
      report.type_fixed.push(`${where}: confidence=${pyRepr(confidence)} → null`);
    }
    confidence = null;
  }

  let lifecycle = raw.lifecycle;
  if (lifecycle === undefined || !LIFECYCLES.has(lifecycle)) {
    if (lifecycle !== null && lifecycle !== undefined) {
      report.type_fixed.push(`${where}: lifecycle=${pyRepr(lifecycle)} → null`);
    }
    lifecycle = null;
  }

  const reasoning = asObj(raw.reasoning);
  const tools = asObj(raw.tools);
  const structured = asObj(raw.structured_output);
  const caching = asObj(raw.caching);
  const sampling = asObj(raw.sampling);

  const entry = {
    id: modelId,
    vendor: getOr(raw, "vendor", null),
    family: getOr(raw, "family", null),
    api_protocol: getOr(raw, "api_protocol", null),
    verified: typeof raw.verified === "boolean" ? raw.verified : null,
    lifecycle,
    lifecycle_note: typeof raw.lifecycle_note === "string" ? raw.lifecycle_note : null,
    context_window: contextWindow,
    max_output_tokens: maxOutput,
    reasoning: {
      supported: typeof reasoning.supported === "boolean" ? reasoning.supported : null,
      effort_values: Array.isArray(reasoning.effort_values) ? reasoning.effort_values : null,
      default_effort: typeof reasoning.default_effort === "string" ? reasoning.default_effort : null,
      summary_values: Array.isArray(reasoning.summary_values) ? reasoning.summary_values : null,
      can_disable: typeof reasoning.can_disable === "boolean" ? reasoning.can_disable : null,
      thinking_budget: normalizeThinkingBudget(reasoning.thinking_budget),
    },
    sampling: {
      temperature: normalizeSamplingParam(sampling.temperature, `${where}:temperature`, report),
      top_p: normalizeSamplingParam(sampling.top_p, `${where}:top_p`, report),
      top_k: normalizeSamplingParam(sampling.top_k, `${where}:top_k`, report),
    },
    tools: {
      function_calling: typeof tools.function_calling === "boolean" ? tools.function_calling : null,
      parallel: typeof tools.parallel === "boolean" ? tools.parallel : null,
      strict: typeof tools.strict === "boolean" ? tools.strict : null,
      choice_modes: Array.isArray(tools.choice_modes) ? tools.choice_modes : null,
    },
    structured_output: {
      supported: typeof structured.supported === "boolean" ? structured.supported : null,
      mechanism:
        typeof structured.mechanism === "string" && structured.mechanism ? structured.mechanism : null,
    },
    vision: typeof raw.vision === "boolean" ? raw.vision : null,
    pdf: typeof raw.pdf === "boolean" ? raw.pdf : null,
    caching: {
      mode: typeof caching.mode === "string" ? caching.mode : null,
      min_tokens:
        Number.isInteger(caching.min_tokens) && typeof caching.min_tokens !== "boolean"
          ? caching.min_tokens
          : null,
      ttl_options: Array.isArray(caching.ttl_options) ? caching.ttl_options : null,
    },
    aliases: normalizeAliases(raw.aliases, modelId, report, where),
    legacy_ids: normalizeLegacyIds(raw.legacy_ids, report, where),
    gotchas: (raw.gotchas || []).filter((g) => typeof g === "string"),
    sources: (raw.sources || []).filter((s) => typeof s === "string"),
    confidence,
  };

  // 来源白名单在合并阶段兜底：incoming 批次里的第三方/云平台链接一律丢弃，
  // 避免它们覆盖 catalog/ 中已清理过的条目（否则 merge 会撤销人工清理）。
  // 若某条目**原本只有非官方来源**，过滤后 provenance 不成立：按项目约定降级
  // （verified=false、confidence=low、gotchas 首位注明），与手工清理保持一致。
  const vendor = entry.vendor;
  if (entry.sources.length && typeof vendor === "string" && vendor) {
    const { kept, dropped } = filterOfficialSources(entry.sources, vendor);
    if (dropped.length) {
      entry.sources = kept;
      for (const url of dropped) {
        report.sources_dropped.push(`${where}: 非官方来源 ${url}（vendor=${vendor}）`);
      }
      if (!kept.length) {
        entry.verified = false;
        entry.confidence = "low";
        const marker = SOURCE_DOWNGRADE_GOTCHA;
        if (!entry.gotchas.includes(marker)) entry.gotchas.unshift(marker);
        report.sources_downgraded.push(`${where}: 仅剩非官方来源 → verified=false, confidence=low`);
      }
    }
  }

  const missing = REQUIRED_TOP.filter((k) => !(k in entry));
  if (missing.length) throw new Error(`schema 漏字段: ${missing.join(",")}`);
  return entry;
}

// --------------------------------------------------------------------------
// 输入
// --------------------------------------------------------------------------

function loadInputs(report) {
  let allFiles;
  try {
    allFiles = readdirSync(INCOMING_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    allFiles = [];
  }
  // pricing-*.json 是独立的 cost 来源，不是模型批次（schema 完全不同），
  // 由 loadPricing() 单独处理，绝不能进下面的批次循环。
  const files = allFiles
    .filter((name) => !name.startsWith(PRICING_FILE_PREFIX))
    .map((name) => path.join(INCOMING_DIR, name));
  if (!allFiles.length) {
    process.stderr.write(`[x] ${INCOMING_DIR} 下没有批次文件\n`);
    process.exit(2);
  }
  if (!files.length) {
    // 只有定价文件、没有模型批次：合法但异常，按“无批次”处理并继续（cost 照常合并）
    report.file_skipped.push(`(仅存在定价文件，无模型批次)`);
  }

  const batches = []; // [basename, entry]
  for (const filePath of files) {
    const name = path.basename(filePath);
    let data;
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      report.file_skipped.push(`${name}: 读取失败 ${err.message}`);
      continue;
    }
    const models = typeof data === "object" && data !== null ? data.models : null;
    if (!Array.isArray(models) || !models.length) {
      report.file_skipped.push(`${name}: 无 models 列表（候选清单/非批次文件）`);
      continue;
    }
    report.files_used.push(name);
    for (const raw of models) {
      const entry = normalizeEntry(raw, name, report);
      if (entry) batches.push([name, entry]);
    }
  }

  const catalog = [];
  // 数据源优先 catalog/（一厂商一文件）；目录不存在时回退旧的 catalog.json（迁移兼容）。
  const catalogFiles = existsSync(CATALOG_DIR)
    ? readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".json") && name !== ".order.json").sort()
    : [];
  if (catalogFiles.length) {
    for (const name of catalogFiles) {
      try {
        const data = JSON.parse(readFileSync(path.join(CATALOG_DIR, name), "utf8"));
        for (const raw of data.models || []) {
          const entry = normalizeEntry(raw, `catalog/${name}`, report);
          if (entry) catalog.push(entry);
        }
      } catch (err) {
        report.file_skipped.push(`catalog/${name}: 读取失败 ${err.message}`);
      }
    }
  } else if (existsSync(CATALOG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
      for (const raw of data.models || []) {
        const entry = normalizeEntry(raw, "catalog.json", report);
        if (entry) catalog.push(entry);
      }
    } catch (err) {
      report.file_skipped.push(`catalog.json: 读取失败 ${err.message}`);
    }
  }
  return [catalog, batches];
}

// --------------------------------------------------------------------------
// 去重
// --------------------------------------------------------------------------

// 批次候选的择优排序键（越大越优先）。
function batchSortKey(item) {
  const [name, entry] = item;
  const isFull = name.endsWith("-full.json") ? 1 : 0;
  const isOrigin = ORIGIN_BATCH[entry.vendor] === name ? 1 : 0;
  return [deepNonNull(entry), CONF_RANK[entry.confidence] || 0, isOrigin, isFull, name];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function maxBy(list, keyFn) {
  let best = null;
  let bestKey = null;
  for (const item of list) {
    const key = keyFn(item);
    if (bestKey === null || compareKeys(key, bestKey) > 0) {
      best = item;
      bestKey = key;
    }
  }
  return best;
}

function merge(catalogEntries, batches, report) {
  const byId = new Map();

  for (const [name, entry] of batches) {
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push([name, entry, "batch"]);
  }
  for (const entry of catalogEntries) {
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(["catalog/", entry, "catalog"]);
  }

  const merged = [];
  for (const modelId of Array.from(byId.keys()).sort()) {
    let candidates = byId.get(modelId);
    const origin = originVendorFor(modelId);
    const mirrorNames = new Set();

    // 规则 1：云镜像重复
    // 1a) 同一 id 出现在不同 vendor 下：只保留原生 vendor 的候选
    const vendors = new Set(candidates.map(([, e]) => e.vendor));
    if (origin && vendors.size > 1 && vendors.has(origin)) {
      for (const [name, entry] of candidates) {
        if (entry.vendor !== origin) {
          mirrorNames.add(name);
          report.dropped.push([
            modelId,
            `云镜像重复：vendor=${entry.vendor} 非原生 vendor=${origin}（来源 ${name}）`,
          ]);
        }
      }
      candidates = candidates.filter(([, e]) => e.vendor === origin);
    }

    // 1b) 同一 vendor 但来自“镜像/旧版批次”的重复条目
    const originBatch = origin ? ORIGIN_BATCH[origin] : null;
    const batchNames = new Set(candidates.filter((c) => c[2] === "batch").map((c) => c[0]));
    if (originBatch && batchNames.has(originBatch) && MIRROR_VENDORS.has(origin)) {
      for (const [name, entry, kind] of candidates) {
        if (kind !== "batch" || name === originBatch) continue;
        mirrorNames.add(name);
        let why;
        if (name === "western-2026-full.json") {
          why = "云镜像重复：western 批次为 Azure/Bedrock 云文档口径";
        } else {
          why = `重复批次：${name} 与原生批次重复（较旧/较薄）`;
        }
        report.dropped.push([modelId, `${why}，保留 ${originBatch}（vendor=${entry.vendor}）`]);
      }
      candidates = candidates.filter((c) => c[2] !== "batch" || c[0] === originBatch);
    }

    const catalogCands = candidates.filter((c) => c[2] === "catalog");
    const batchCands = candidates.filter((c) => c[2] === "batch");
    const donors = batchCands.filter((c) => !mirrorNames.has(c[0]));

    // 规则 2：catalog 手工条目优先（批次 verified=true 且 catalog 非 true 时例外）
    let winner = null;
    if (catalogCands.length) {
      const cat = maxBy(catalogCands, (c) => [deepNonNull(c[1])])[1];
      if (batchCands.length) {
        const bestBatch = maxBy(batchCands, batchSortKey);
        const catVerified = cat.verified === true;
        const batchVerified = bestBatch[1].verified === true;
        if (batchVerified && !catVerified) {
          winner = bestBatch[1];
          report.dropped.push([
            modelId,
            `批次 verified=true 覆盖 catalog verified=${pyRepr(cat.verified)}（来源 ${bestBatch[0]}）`,
          ]);
          for (const [name, entry] of batchCands) {
            if (name !== bestBatch[0] || entry !== bestBatch[1]) {
              report.dropped.push([modelId, `批次内部去重：信息量/置信度较低（来源 ${name}）`]);
            }
          }
        } else {
          winner = cat;
          const reason =
            "catalog 手工条目优先" +
            (batchVerified ? "（批次 verified=true 但 catalog 同为 true）" : "（批次未核验）");
          for (const [name] of batchCands) {
            report.superseded.push([modelId, `${reason}；忽略批次条目（来源 ${name}）`]);
          }
        }
      } else {
        winner = cat;
      }
    } else {
      const bestBatch = maxBy(batchCands, batchSortKey);
      winner = bestBatch[1];
      for (const [name, entry] of batchCands) {
        if (name === bestBatch[0] && entry === bestBatch[1]) continue;
        let reason;
        if (entry.vendor !== bestBatch[1].vendor) {
          reason = `云镜像重复：vendor=${entry.vendor}，保留 vendor=${bestBatch[1].vendor}（来源 ${bestBatch[0]}）`;
        } else {
          const a = deepNonNull(entry);
          const b = deepNonNull(bestBatch[1]);
          if (a !== b) {
            reason = `非空字段较少（${a} < ${b}，来源 ${bestBatch[0]}）`;
          } else if ((CONF_RANK[entry.confidence] || 0) !== (CONF_RANK[bestBatch[1].confidence] || 0)) {
            reason = `confidence 较低（${entry.confidence} < ${bestBatch[1].confidence}，来源 ${bestBatch[0]}）`;
          } else {
            reason = `同分兜底：${bestBatch[0]} 优先于 ${name}`;
          }
        }
        report.dropped.push([modelId, reason]);
      }
    }

    // 规则 3：winner 缺失的元数据键，用最佳非镜像批次候选补齐（不覆盖已有值）
    if (winner !== null && donors.length) {
      const donor = maxBy(donors, batchSortKey);
      for (const key of BACKFILL_KEYS) {
        if (isBlank(winner[key]) && !isBlank(donor[1][key])) {
          winner[key] = donor[1][key];
          report.backfilled.push(`${modelId}: ${key} ← ${donor[0]}`);
        }
      }
    }

    if (winner !== null) merged.push(winner);
  }

  merged.sort((a, b) => {
    const va = a.vendor || "~";
    const vb = b.vendor || "~";
    if (va !== vb) return va < vb ? -1 : 1;
    const ia = String(a.id || "").toLowerCase();
    const ib = String(b.id || "").toLowerCase();
    if (ia !== ib) return ia < ib ? -1 : 1;
    const ra = a.id || "";
    const rb = b.id || "";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  return merged;
}

// --------------------------------------------------------------------------
// 报告 / 输出
// --------------------------------------------------------------------------

function newReport() {
  return {
    files_used: [], file_skipped: [], entry_dropped: [],
    dropped: [], superseded: [], backfilled: [], range_ok: 0,
    range_open: [], range_bad: [], type_fixed: [], sampling_fixed: [],
    self_alias: [], alias_dropped: [], legacy_dropped: [], legacy_coerced: [],
    sources_dropped: [], sources_downgraded: [],
    // 定价（cost）
    cost_files_used: [], cost_file_skipped: [], cost_dropped: [],
    cost_converted: [], cost_superseded: [], cost_applied: [],
  };
}

function printReport(report, merged, catalogCount, batchCount, costStats) {
  const byVendor = new Map();
  for (const entry of merged) {
    const vendor = entry.vendor || "unknown";
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(entry);
  }

  const out = [];
  out.push("=".repeat(72));
  out.push("合并报告 — incoming/*.json + catalog/ → catalog/ + catalog.json");
  out.push("=".repeat(72));
  out.push(`使用批次文件 (${report.files_used.length}): ` + report.files_used.join(", "));
  for (const item of report.file_skipped) out.push(`  [跳过] ${item}`);
  out.push(`catalog/ 已有条目: ${catalogCount}`);
  out.push(`批次条目（规范化后）: ${batchCount}`);
  out.push(`合并后总条目: ${merged.length}`);
  out.push("");
  out.push("按 vendor 统计:");
  for (const vendor of Array.from(byVendor.keys()).sort()) {
    out.push(`  ${vendor.padEnd(14)} ${String(byVendor.get(vendor).length).padStart(3)}`);
  }
  out.push("");
  out.push(`去重丢弃: ${report.dropped.length} 条`);
  for (const [modelId, reason] of report.dropped) out.push(`  - ${modelId}: ${reason}`);
  if (report.superseded.length) {
    out.push("");
    out.push(`目录条目优先（批次同 id 未采用）: ${report.superseded.length} 条`);
    for (const [modelId, reason] of report.superseded) out.push(`  - ${modelId}: ${reason}`);
  }
  out.push("");
  out.push("规范化统计:");
  out.push(`  sampling range 成功转换: ${report.range_ok}（其中开区间: ${report.range_open.length}）`);
  for (const item of report.range_open.slice(0, 8)) out.push(`      ${item}`);
  if (report.range_open.length > 8) out.push(`      ... 其余 ${report.range_open.length - 8} 条同类`);
  out.push(`  sampling range 无法解析/异常: ${report.range_bad.length}`);
  for (const item of report.range_bad) out.push(`      ${item}`);
  out.push(`  类型修正: ${report.type_fixed.length}`);
  for (const item of report.type_fixed.slice(0, 10)) out.push(`      ${item}`);
  out.push(`  丢弃自身别名: ${report.self_alias.length}`);
  out.push(`  丢弃非法/重复别名: ${report.alias_dropped.length}`);
  for (const item of report.alias_dropped) out.push(`      ${item}`);
  out.push(`  丢弃非法 legacy_ids: ${report.legacy_dropped.length}`);
  for (const item of report.legacy_dropped) out.push(`      ${item}`);
  out.push(`  非对象条目丢弃: ${report.entry_dropped.length}`);
  for (const item of report.entry_dropped) out.push(`      ${item}`);
  out.push(`  元数据补齐（catalog 缺失键 ← 批次）: ${report.backfilled.length}`);
  for (const item of report.backfilled) out.push(`      ${item}`);
  out.push(`  丢弃非官方来源（第三方/云平台文档）: ${report.sources_dropped.length}`);
  for (const item of report.sources_dropped.slice(0, 20)) out.push(`      ${item}`);
  if (report.sources_dropped.length > 20) {
    out.push(`      ... 其余 ${report.sources_dropped.length - 20} 条同类`);
  }
  out.push(`  provenance 降级（仅剩非官方来源 → verified=false/confidence=low）: ${report.sources_downgraded.length}`);
  for (const item of report.sources_downgraded.slice(0, 20)) out.push(`      ${item}`);
  if (report.sources_downgraded.length > 20) {
    out.push(`      ... 其余 ${report.sources_downgraded.length - 20} 条同类`);
  }

  // ---- 定价（cost）----
  out.push("");
  out.push("定价（cost）统计:");
  out.push(`  使用定价文件 (${report.cost_files_used.length}): ` + report.cost_files_used.join(", "));
  for (const item of report.cost_file_skipped) out.push(`  [跳过] ${item}`);
  out.push(`  已写入 cost: ${costStats.withCost} 条`);
  const currencies = Array.from(costStats.byCurrency.keys()).sort();
  out.push(
    `  按币种: ${currencies.length ? currencies.map((c) => `${c} ${costStats.byCurrency.get(c)}`).join("、") : "（无）"}`,
  );
  out.push(`  兜底汇率换算（非 USD → USD）: ${report.cost_converted.length} 条`);
  for (const item of report.cost_converted) out.push(`      ${item}`);
  out.push(`  无定价（cost: null）: ${costStats.nullCost} 条`);
  out.push(`  非法定价条目丢弃: ${report.cost_dropped.length}`);
  for (const item of report.cost_dropped) out.push(`      ${item}`);
  if (report.cost_superseded.length) {
    out.push(`  同 id 定价去重（保留高 confidence / 较新文件）: ${report.cost_superseded.length} 条`);
    for (const item of report.cost_superseded) out.push(`      ${item}`);
  }
  out.push("=".repeat(72));
  process.stdout.write(out.join("\n") + "\n");
}

function main(argv) {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else {
      process.stderr.write(`usage: merge-catalog.mjs [--dry-run]\n`);
      return 2;
    }
  }

  const report = newReport();
  const [catalogEntries, batches] = loadInputs(report);
  const merged = merge(catalogEntries, batches, report);
  const pricing = loadPricing(report);
  const costStats = applyCosts(merged, pricing, report);
  printReport(report, merged, catalogEntries.length, batches.length, costStats);

  if (dryRun) {
    process.stdout.write("[i] --dry-run：未写入 catalog/ 或 catalog.json\n");
    return 0;
  }

  // 写 catalog/（唯一数据源）→ 再用共享的打包逻辑生成 catalog.json
  let written;
  try {
    written = writeVendorFiles(CATALOG_DIR, merged, UPDATED_AT);
  } catch (err) {
    process.stderr.write(`[x] 写入 catalog/ 失败: ${err.message}\n`);
    return 2;
  }
  process.stdout.write(`[ok] 已写入 catalog/：${written.length} 个厂商文件\n`);

  let built;
  try {
    built = buildCatalog();
  } catch (err) {
    process.stderr.write(`[x] 打包 catalog.json 失败: ${err.message}\n`);
    return 2;
  }
  writeBundle(CATALOG_PATH, built.content);
  process.stdout.write(
    `[ok] 已写入 ${CATALOG_PATH}（version ${CATALOG_VERSION}, updated_at ${UPDATED_AT}, ${built.models.length} 条）\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
