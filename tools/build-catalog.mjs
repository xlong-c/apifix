#!/usr/bin/env node
// build-catalog.mjs — 把 catalog/<vendor>.json 打包成 catalog.json（零依赖 / ESM）
//
// catalog/ 是**唯一数据源**（人工编辑这里，一厂商一文件）；catalog.json 是生成物，
// CLI / UI 继续读它。合并脚本（merge-catalog.mjs）写完 catalog/ 后调用本模块的
// buildCatalog() 重新打包，保证两边逻辑只有一份。
//
// 顺序：catalog/.order.json 记录 vendor 文件名的规范顺序；首次生成时用现有
// catalog.json 的全局模型顺序推导，之后固定不变（新增 vendor 追加到末尾）。
//
// 用法：
//   node tools/build-catalog.mjs            # 打包并写入 catalog.json
//   node tools/build-catalog.mjs --check    # 只校验 catalog.json 是否最新（不一致 exit 1）
//   node tools/build-catalog.mjs --dry-run  # 只打印，不写入
//
// 退出码：0 成功；1 --check 发现不一致；2 用法/解析错误。

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CATALOG_VERSION = 2;
export const ORDER_FILE = ".order.json";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CATALOG_DIR = path.join(ROOT, "catalog");
export const CATALOG_PATH = path.join(ROOT, "catalog.json");

// --------------------------------------------------------------------------
// 读取 / 排序
// --------------------------------------------------------------------------

function isDict(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// catalog/ 下的厂商文件名（不含 .order.json），按文件名字典序。
export function listVendorFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`无法读取目录 ${dir}: ${err.message}`);
  }
  return names
    .filter((name) => name.endsWith(".json") && name !== ORDER_FILE)
    .sort();
}

// 读取单个厂商文件；返回 {file, vendor, updated_at, models}。
export function readVendorFile(dir, name) {
  const filePath = path.join(dir, name);
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`${name}: 解析失败（${err.message}）`);
  }
  if (!isDict(data)) throw new Error(`${name}: 顶层必须是对象`);
  const vendor = data.vendor;
  if (typeof vendor !== "string" || !vendor) throw new Error(`${name}: 缺少非空字符串 vendor`);
  if (!Array.isArray(data.models)) throw new Error(`${name}: 缺少 models 数组`);

  const mismatched = [];
  for (const model of data.models) {
    if (!isDict(model)) continue;
    if (model.vendor !== vendor) {
      mismatched.push(`${model.id ?? "(无 id)"}(vendor=${JSON.stringify(model.vendor)})`);
    }
  }
  if (mismatched.length) {
    throw new Error(`${name}: 条目 vendor 与文件 vendor=${JSON.stringify(vendor)} 不一致：${mismatched.join("、")}`);
  }
  return {
    file: name,
    vendor,
    updated_at: typeof data.updated_at === "string" ? data.updated_at : null,
    models: data.models,
  };
}

// .order.json 形如 { "order": ["openai.json", "anthropic.json", ...] }
function readOrder(dir) {
  const filePath = path.join(dir, ORDER_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(data.order)) return null;
    return data.order.filter((x) => typeof x === "string");
  } catch {
    return null;
  }
}

// 由现有 catalog.json 的全局顺序推导 vendor 文件顺序（首次运行用）。
// 返回文件名数组；未在 catalog.json 出现的文件按文件名字典序追加。
function deriveOrderFromBundle(dir, files) {
  const bundlePath = CATALOG_PATH;
  if (!existsSync(bundlePath)) return null;
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch {
    return null;
  }
  if (!isDict(bundle) || !Array.isArray(bundle.models)) return null;

  const vendorToFile = new Map();
  for (const name of files) {
    try {
      const vendor = readVendorFile(dir, name).vendor;
      vendorToFile.set(vendor, name);
    } catch {
      // 坏文件留给调用方统一报错
    }
  }

  const order = [];
  const seen = new Set();
  for (const model of bundle.models) {
    if (!isDict(model)) continue;
    const name = vendorToFile.get(model.vendor);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  for (const name of files) {
    if (!seen.has(name)) order.push(name);
  }
  return order;
}

// 规范顺序：.order.json 优先（缺失则从 catalog.json 推导），始终把未知文件追加到末尾。
export function resolveOrder(dir, files) {
  const recorded = readOrder(dir);
  let order = recorded;
  if (!order || !order.length) order = deriveOrderFromBundle(dir, files) || files.slice();
  const known = new Set(files);
  const out = order.filter((name) => known.has(name));
  for (const name of files) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// --------------------------------------------------------------------------
// 打包
// --------------------------------------------------------------------------

// 读取 catalog/ 并按规范顺序拼出完整模型列表。
// 返回 {files, vendors, models, updated_at, order}；任何解析/一致性错误抛异常。
export function loadBundle(dir) {
  const files = listVendorFiles(dir);
  if (!files.length) throw new Error(`${dir} 下没有厂商文件（*.json）`);
  const order = resolveOrder(dir, files);
  const vendors = [];
  const models = [];
  let updatedAt = null;
  for (const name of order) {
    const vendorFile = readVendorFile(dir, name);
    vendors.push(vendorFile);
    for (const model of vendorFile.models) models.push(model);
    if (vendorFile.updated_at && (!updatedAt || vendorFile.updated_at > updatedAt)) {
      updatedAt = vendorFile.updated_at;
    }
  }
  return { files: order, vendors, models, updated_at: updatedAt, order };
}

// 把模型列表序列化成 catalog.json 的字节内容（2 空格缩进 + 末尾换行）。
export function serializeBundle(models, updatedAt) {
  return JSON.stringify({ version: CATALOG_VERSION, updated_at: updatedAt, models }, null, 2) + "\n";
}

// 读取 catalog/ 并打包成字符串。返回 {content, models, vendors, files}。
export function buildCatalog(dir = CATALOG_DIR) {
  const bundle = loadBundle(dir);
  return {
    content: serializeBundle(bundle.models, bundle.updated_at),
    models: bundle.models,
    vendors: bundle.vendors,
    files: bundle.files,
    updated_at: bundle.updated_at,
  };
}

// 原子写入（tmp + rename），避免半截文件。
export function writeBundle(filePath, content) {
  const tmp = path.join(path.dirname(filePath), `.catalog.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

// 把模型按 vendor 拆成文件内容（供 merge-catalog.mjs 写 catalog/ 用）。
// 顺序沿用 models 数组的现有顺序（每个 vendor 内保持原序）。
export function splitByVendor(models, updatedAt) {
  const byVendor = new Map();
  for (const model of models) {
    const vendor = isDict(model) && typeof model.vendor === "string" && model.vendor ? model.vendor : "unknown";
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(model);
  }
  const out = [];
  for (const [vendor, list] of byVendor) {
    out.push({
      vendor,
      file: `${vendor}.json`,
      models: list,
      content: JSON.stringify({ vendor, updated_at: updatedAt, models: list }, null, 2) + "\n",
    });
  }
  return out;
}

// 写入 catalog/ 下的全部厂商文件 + .order.json。返回写出的文件名列表。
export function writeVendorFiles(dir, models, updatedAt) {
  const parts = splitByVendor(models, updatedAt);
  const names = [];
  for (const part of parts) {
    writeBundle(path.join(dir, part.file), part.content);
    names.push(part.file);
  }
  const order = parts.map((p) => p.file);
  writeBundle(path.join(dir, ORDER_FILE), JSON.stringify({ order }, null, 2) + "\n");
  return names;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function main(argv) {
  let check = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--check") check = true;
    else if (arg === "--dry-run") dryRun = true;
    else {
      process.stderr.write("usage: build-catalog.mjs [--check] [--dry-run]\n");
      return 2;
    }
  }

  let built;
  try {
    built = buildCatalog();
  } catch (err) {
    process.stderr.write(`[x] ${err.message}\n`);
    return 2;
  }

  const vendors = built.vendors.length;
  const summary = `${built.files.length} 个厂商文件、${built.models.length} 条模型`;

  if (check) {
    let current = null;
    try {
      current = readFileSync(CATALOG_PATH, "utf8");
    } catch {
      current = null;
    }
    if (current === built.content) {
      process.stdout.write(`[i] catalog.json 与 catalog/ 一致（${summary}）\n`);
      return 0;
    }
    process.stderr.write(`[x] catalog.json 与 catalog/ 不一致，请运行 npm run build\n`);
    process.stderr.write(`[i] catalog/: ${summary}\n`);
    return 1;
  }

  if (dryRun) {
    process.stdout.write(`[i] --dry-run：未写入 catalog.json（${summary}）\n`);
    return 0;
  }

  writeBundle(CATALOG_PATH, built.content);
  process.stdout.write(
    `[ok] 已写入 ${CATALOG_PATH}（version ${CATALOG_VERSION}, updated_at ${built.updated_at}, ${summary}）\n`,
  );
  return 0;
}

// 仅在直接执行时跑 CLI（被 import 时不跑）。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
