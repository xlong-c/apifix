#!/usr/bin/env node
// validate-catalog.mjs — catalog/ 与 catalog.json 校验（零依赖 / ESM，CI 使用）
//
// catalog/ 是唯一数据源（一厂商一文件）；catalog.json 是由 build-catalog.mjs
// 生成的 bundle。默认校验两者：厂商文件结构 + 逐条 schema + 全局 id 唯一 +
// 来源白名单 + bundle 一致性。
//
// 检查项：
//   1. catalog/ 下每个 *.json 为 {vendor, updated_at, models: [...]}，条目 vendor 与文件一致；
//   2. id 跨全部厂商文件全局唯一（大小写不敏感）；
//   3. 每个条目具备必需键（merge-catalog.mjs 的 REQUIRED_TOP schema）；
//   4. 无明显畸形值（context_window 正整数、range 形状、枚举、sources 链接等）；
//   5. sources 只含第一方厂商来源（白名单见 tools/source-whitelist.mjs）；
//   6. catalog.json 与 catalog/ 生成的 bundle 完全一致（否则提示 npm run build）；
//   7. 每个 vendor 至少 1 条。
//
// 退出码：0 通过（可能有 warning）；1 有 error。
//
// 用法：
//   node tools/validate-catalog.mjs            # 校验 catalog/ + catalog.json 一致性
//   node tools/validate-catalog.mjs FILE       # 校验指定 bundle 文件（兼容旧用法）

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isOfficialSource } from "./source-whitelist.mjs";
import { buildCatalog, CATALOG_DIR } from "./build-catalog.mjs";
import {
  REQUIRED_TOP,
  REQUIRED_REASONING,
  REQUIRED_SAMPLING,
  REQUIRED_TOOLS,
  REQUIRED_CACHING,
  LIFECYCLES,
  CONFIDENCES,
  tierBoundaries,
} from "./schema.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PATH = path.join(ROOT, "catalog.json");

// schema 词表（REQUIRED_TOP / 子对象必需键 / LIFECYCLE / confidence 枚举）统一从
// tools/schema.mjs 导入——validate 与 merge 共用单一事实源，字段新增只改一处。

// 模型 id 允许的字符形态（字母/数字开头，后接 .:/-_ 与字母数字）
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\-]*$/;

// 来源白名单在 tools/source-whitelist.mjs（validate 与 merge 共用同一份规则）。
// 报错格式固定为：<id>: sources 含非官方来源 <url>（vendor=<vendor>）
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
        // 档位边界三种等价写法（恰好一个）—— 字段名与判别统一走 tools/schema.mjs：
        //   max_input        —— 不超过这么多 input tokens（数值，上限口径）
        //   min_input_tokens —— 从这么多 input tokens 起（数值，下限口径）
        //   condition        —— 人类可读的区间描述（非空字符串）
        const { hasMax, hasMin, hasCond } = tierBoundaries(tier);
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

// 校验 catalog/ 下的厂商文件；返回 {models, vendors, files} 或抛异常。
// 每个文件必须是 {vendor, updated_at, models}，且条目 vendor 与文件一致；
// id 在**全部文件之间**全局唯一。
function validateVendorFiles() {
  let files;
  try {
    files = readdirSync(CATALOG_DIR)
      .filter((name) => name.endsWith(".json") && name !== ".order.json")
      .sort();
  } catch (error) {
    throw new Error(`无法读取 ${CATALOG_DIR}: ${error.message}`);
  }
  if (!files.length) throw new Error(`${CATALOG_DIR} 下没有厂商文件（*.json）`);

  const models = [];
  const seen = new Map(); // 小写 id -> "文件:索引"
  let index = 0;
  for (const name of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(CATALOG_DIR, name), "utf8"));
    } catch (error) {
      err(`catalog/${name}: 不是合法 JSON（${error.message}）`);
      continue;
    }
    if (!isDict(data)) {
      err(`catalog/${name}: 顶层必须是对象`);
      continue;
    }
    const vendor = data.vendor;
    if (typeof vendor !== "string" || !vendor) {
      err(`catalog/${name}: 缺少非空字符串 vendor`);
      continue;
    }
    if (data.updated_at === null || data.updated_at === undefined) {
      warn(`catalog/${name}: 缺少 updated_at`);
    }
    if (!Array.isArray(data.models)) {
      err(`catalog/${name}: 缺少 models 数组`);
      continue;
    }
    if (!data.models.length) warn(`catalog/${name}: models 为空数组`);

    for (const entry of data.models) {
      const where = `catalog/${name}[${index}]`;
      if (isDict(entry) && entry.vendor !== vendor) {
        err(
          `catalog/${name}: 条目 ${pyRepr(entry.id ?? null)} 的 vendor=${pyRepr(entry.vendor ?? null)}` +
            ` 与文件 vendor=${pyRepr(vendor)} 不一致`,
        );
      }
      checkEntry(entry, index);
      if (isDict(entry) && typeof entry.id === "string") {
        const low = entry.id.toLowerCase();
        if (seen.has(low)) {
          err(`id 重复（大小写不敏感，跨文件全局唯一）：${pyRepr(entry.id)} 与 ${seen.get(low)}`);
        } else {
          seen.set(low, `${where} 的 ${pyRepr(entry.id)}`);
        }
      }
      models.push(entry);
      index += 1;
    }
  }
  const vendors = new Set(models.filter(isDict).map((e) => e.vendor));
  return { models, vendors, files };
}

// 校验 catalog.json 是否等于由 catalog/ 生成的 bundle。
function checkBundle() {
  let built;
  try {
    built = buildCatalog();
  } catch (error) {
    err(`catalog/: 打包失败（${error.message}）`);
    return;
  }
  let current = null;
  try {
    current = readFileSync(DEFAULT_PATH, "utf8");
  } catch {
    err("catalog.json: 无法读取（应由 npm run build 生成）");
    return;
  }
  if (current !== built.content) {
    err("catalog.json 与 catalog/ 不一致，请运行 npm run build");
  }
}

function main(argv) {
  // 无参数：校验 catalog/（数据源）+ catalog.json（生成物）一致性。
  // 带参数：沿用旧行为，校验指定的 bundle 文件（CI/临时对拍用）。
  if (!argv.length) {
    let result;
    try {
      result = validateVendorFiles();
    } catch (error) {
      process.stderr.write(`[x] ${error.message}\n`);
      return 1;
    }
    checkBundle();
    if (!result.vendors.size) err("没有任何 vendor");

    for (const item of warnings) process.stdout.write(`[!] ${item}\n`);
    for (const item of errors) process.stdout.write(`[x] ${item}\n`);
    process.stdout.write(
      `[i] catalog/: ${result.files.length} 个厂商文件，${result.models.length} 条，` +
        `${result.vendors.size} 个 vendor，${errors.length} 个 error，${warnings.length} 个 warning\n`,
    );
    return errors.length ? 1 : 0;
  }

  const filePath = argv[0];
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
