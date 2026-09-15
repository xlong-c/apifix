#!/usr/bin/env node
// apifix — 模型官方参数速查 + 配置片段生成器（Node >= 18 / 零依赖 / ESM）
//
// 给定一个模型 id（支持中转/别名写法），打印该模型的**官网规格值**以及可直接粘贴的
// opencode / pi 等配置片段；另带一个纯静态的本地 Web UI（`--ui`）。
//
// 退出码：0 成功；1 未收录；2 用法/输入错误。
//
// 与 legacy-python/apifix.py 行为对齐；核心逻辑在 ./lib/core.mjs（浏览器通用）。

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  matchModel,
  emitOpencode,
  emitPi,
  emitExtra,
  renderCard,
  listRows,
  detectConfigFormat,
  auditConfig,
  renderAudit,
  searchModels,
  renderSearch,
  compareModels,
  renderCompare,
  protocolsReport,
  renderProtocols,
  parseCodexToml,
  claudeProtocolEnv,
  stripCredentials,
  scrub,
} from "./lib/core.mjs";

const EMIT_TARGETS = ["opencode", "pi", "codex", "claude-env", "curl", "sdk"];

const VERSION = "0.1.0";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.join(ROOT, "catalog.json");
const DEFAULT_PORT = 7788;

const MISSING_TEXT = "unknown";
const NOT_FOUND_TEXT = "未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）";
// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

function displayWidth(text) {
  // 与 core.mjs 相同的东亚宽度规则（此处只用于 --list/--match 的列对齐）
  const WIDE = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
  ];
  const COMBINING = /[\p{Mn}\p{Me}]/u;
  let width = 0;
  for (const ch of String(text)) {
    if (COMBINING.test(ch)) continue;
    const cp = ch.codePointAt(0);
    let wide = false;
    for (const [lo, hi] of WIDE) {
      if (cp >= lo && cp <= hi) { wide = true; break; }
    }
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function stderr(line) {
  process.stderr.write(line + "\n");
}

function stdout(line) {
  process.stdout.write(line + "\n");
}

// --------------------------------------------------------------------------
// 参数解析（对齐 Python argparse 的常用行为）
// --------------------------------------------------------------------------

const HELP = `usage: apifix [-h] [--json] [--card]
              [--emit {claude-env,codex,curl,opencode,pi,sdk}]
              [--name DISPLAY] [--canonical-id] [--list] [--match FILE]
              [--catalog PATH] [--ui] [--port PORT] [--no-open] [--version]
              [model_id]
       apifix audit <file|-> [--format {auto,opencode,pi,generic}] [--json]
       apifix search [filters] [--json]
       apifix compare <id1> <id2> [<id3>] [<id4>] [--usage IN/OUT] [--json]
       apifix protocols [--file <path>]... [--json] [--no-defaults]

查询模型官网参数规格，并生成 opencode / pi 等配置片段（纯本地，无网络请求）

positional arguments:
  model_id              模型 id，可带厂商前缀/relay 后缀

subcommands:
  audit <file|->        审计配置文件（或 stdin）中的模型条目与官网规格差异
  search [filters]      按能力/价格/厂商/生命周期检索模型
  compare <id1> <id2>   2-4 个模型并排对比（--usage IN/OUT 附用量成本）
  protocols             跨工具协议总览（各 provider 协议 vs 模型原生协议）

options:
  -h, --help            显示帮助并退出
  --json                输出匹配到的 catalog 原始条目 JSON
  --card                输出 box-drawing 规格卡片
  --emit {claude-env,codex,curl,opencode,pi,sdk}
                        输出配置片段（默认 opencode）
  -f, --full            输出完整字段集（仅对 --emit opencode|pi 生效）
  --name DISPLAY        覆盖输出片段中的展示名 name
  --canonical-id        输出片段的 key/id 使用官网规范 id（默认沿用输入 id）
  --list                列出 catalog 全部 id（按 vendor 分组）
  --match FILE          逐行读取模型 id 文件，打印匹配状态
  --catalog PATH        指定 catalog.json 路径
  --ui                  启动本地 Web UI 服务（默认 http://127.0.0.1:7788/）
  --port PORT           UI 端口（默认 7788；被占用时自动 +1 重试，最多 +10）
  --no-open             启动 UI 时不自动打开浏览器
  --version             显示版本并退出

各子命令详情：node apifix.mjs audit --help / search --help / compare --help`;

function parseArgs(argv) {
  const opts = {
    modelId: null,
    json: false,
    card: false,
    emit: null,
    name: null,
    canonicalId: false,
    full: false,
    list: false,
    match: null,
    catalog: DEFAULT_CATALOG,
    ui: false,
    port: DEFAULT_PORT,
    noOpen: false,
    version: false,
    help: false,
  };
  const takesValue = { "--emit": "emit", "--name": "name", "--match": "match", "--catalog": "catalog", "--port": "port" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") { opts.help = true; continue; }
    if (arg === "--version") { opts.version = true; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--card") { opts.card = true; continue; }
    if (arg === "--canonical-id") { opts.canonicalId = true; continue; }
    if (arg === "-f" || arg === "--full") { opts.full = true; continue; }
    if (arg === "--list") { opts.list = true; continue; }
    if (arg === "--ui") { opts.ui = true; continue; }
    if (arg === "--no-open") { opts.noOpen = true; continue; }

    let key = arg;
    let value = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const idx = arg.indexOf("=");
      key = arg.slice(0, idx);
      value = arg.slice(idx + 1);
    }
    if (takesValue[key] !== undefined) {
      if (value === null) {
        i += 1;
        if (i >= argv.length) throw new UsageError(`argument ${key}: expected one argument`);
        value = argv[i];
      }
      if (key === "--emit" && !EMIT_TARGETS.includes(value)) {
        throw new UsageError(
          `argument --emit: invalid choice: ${JSON.stringify(value)} (choose from ${EMIT_TARGETS.join(", ")})`,
        );
      }
      opts[takesValue[key]] = value;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unrecognized arguments: ${arg}`);
    if (opts.modelId !== null) throw new UsageError(`unrecognized arguments: ${arg}`);
    opts.modelId = arg;
  }
  return opts;
}

class UsageError extends Error {}

// --------------------------------------------------------------------------
// --list / --match
// --------------------------------------------------------------------------

function cmdList(models, json) {
  if (json) {
    return JSON.stringify(listRows(models), null, 2);
  }
  const byVendor = new Map();
  for (const entry of models) {
    const vendor = entry.vendor || "unknown";
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(entry);
  }
  const lines = [];
  for (const vendor of Array.from(byVendor.keys()).sort()) {
    lines.push(vendor);
    const entries = byVendor.get(vendor).slice().sort((a, b) =>
      String(a.id || "") < String(b.id || "") ? -1 : String(a.id || "") > String(b.id || "") ? 1 : 0,
    );
    for (const entry of entries) {
      const lifecycle = entry.lifecycle;
      let mark = "";
      if (lifecycle === "retired") mark = "(retired)";
      else if (lifecycle === "unreleased") mark = "(unreleased)";
      else if (lifecycle === "legacy") mark = "(legacy)";
      const family = entry.family || "?";
      const ctx = entry.context_window;
      const ctxText = Number.isInteger(ctx) ? groupThousands(ctx) : "?";
      const verified = entry.verified === true ? "已核验" : "未核验";
      const marks = [verified, mark].filter((x) => x).join(" ");
      lines.push(`  ${pad(String(entry.id || "?"), 28)} ${pad(String(family), 18)} ctx=${pad(ctxText, 10)} ${marks}`);
    }
  }
  return lines.join("\n");
}

function cmdMatch(file, models) {
  let rawLines;
  try {
    rawLines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch (err) {
    stderr(`[x] 无法读取文件: ${err.message}`);
    return 2;
  }

  const labels = { exact: "[OK]", alias: "[A]", legacy: "[L]", normalized: "[~]" };
  const out = [];
  let unknown = 0;
  for (const line of rawLines) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const res = matchModel(models, text);
    if (res.entry) {
      const label = labels[res.kind] || "[OK]";
      if (res.kind === "legacy") {
        out.push(`${label} ${pad(text, 40)} -> ${res.matchedId}（旧版/退役 id）`);
      } else if (res.kind === "normalized") {
        const detail = res.ops && res.ops.length ? res.ops.join("；") : "归一化解析";
        out.push(`${label} ${pad(text, 40)} -> ${res.matchedId}（${detail}）`);
      } else if (res.kind === "alias") {
        out.push(`${label} ${pad(text, 40)} -> ${res.matchedId}（别名解析）`);
      } else {
        out.push(`${label} ${pad(text, 40)} -> ${res.matchedId}`);
      }
      const lifecycle = res.entry.lifecycle;
      if (lifecycle === "retired") {
        out.push(`     [!] ${res.matchedId} 官方已退役；第三方可能仍提供`);
      } else if (lifecycle === "unreleased") {
        out.push(`     [!] ${res.matchedId} 官方尚未发布`);
      }
    } else {
      unknown += 1;
      if (res.suggestion) {
        out.push(`[?] ${pad(text, 40)} -> ${NOT_FOUND_TEXT} 最接近: ${res.suggestion}`);
      } else {
        out.push(`[?] ${pad(text, 40)} -> ${NOT_FOUND_TEXT}`);
      }
    }
  }
  stdout(out.join("\n"));
  if (unknown) {
    stderr(`[x] ${unknown} 行未收录`);
    return 1;
  }
  return 0;
}

// --------------------------------------------------------------------------
// audit / search / compare（子命令）
// --------------------------------------------------------------------------

const AUDIT_FORMATS = ["auto", "opencode", "pi", "generic"];
const SEARCH_SORTS = ["price", "context", "output", "id"];
const SEARCH_LIFECYCLES = ["current", "legacy", "retired", "unreleased"];

const AUDIT_HELP = `usage: apifix audit <file|-> [--format {auto,opencode,pi,generic}] [--json]

读取配置文件（- 表示 stdin），提取模型条目并与 catalog 官网规格逐项比对。
输出经凭证脱敏（key/token/secret 一律替换为 [REDACTED]，且永不回显文件原文）。

arguments:
  file                  配置文件路径；- 表示从 stdin 读取

options:
  --format {auto,opencode,pi,generic}
                        配置格式（默认 auto 自动识别）
  --json                输出机器可读 JSON（无 ANSI/制表符）
  -h, --help            显示帮助并退出

退出码：0 全部一致；1 存在差异或未收录；2 用法/解析错误`;

const SEARCH_HELP = `usage: apifix search [filters] [--json]

按能力 / 价格 / 厂商 / 生命周期检索 catalog 中的模型。

filters:
  --vision              仅视觉模型
  --reasoning           仅支持推理的模型
  --tool-call           仅支持工具调用的模型
  --pdf                 仅支持 PDF 输入的模型
  --min-context N       上下文窗口 >= N（支持 1M / 1000k / 纯数字）
  --max-input-price N   输入价 <= N（USD/1M；价格为 null 的模型会被排除）
  --max-output-price N  输出价 <= N（USD/1M；价格为 null 的模型会被排除）
  --vendor NAME         厂商过滤（可重复）
  --lifecycle NAME      生命周期过滤：current|legacy|retired|unreleased（可重复）
  --sort FIELD          price（默认）|context|output|id，升序；null 价格排最后
  --limit N             最多输出 N 行
  --json                输出机器可读 JSON
  -h, --help            显示帮助并退出`;

const COMPARE_HELP = `usage: apifix compare <id1> <id2> [<id3>] [<id4>] [--usage <in>/<out>] [--json]

2-4 个模型并排对比（支持中转/旧版 id，经 matchModel 归一化）。

options:
  --usage IN/OUT        附加本次用量成本行，如 --usage 100k/5k（支持 k/M 后缀）
  --json                输出机器可读 JSON
  -h, --help            显示帮助并退出`;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 公开白名单：catalog 的 id / 别名 / legacy id 都是公开数据，不应被凭证脱敏规则
// 误伤（如 `ark-code-latest` 撞上 ark- 前缀规则、32+ 字符 id 撞上长串规则）。
// 仅保护"独立出现"的公开串；嵌入更大串中的凭证照常脱敏（见 core.scrub）。
function publicTokens(models, extra) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== "string" || !value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const entry of models) {
    if (!isPlainObject(entry)) continue;
    push(entry.id);
    if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) push(alias);
    if (Array.isArray(entry.legacy_ids)) {
      for (const item of entry.legacy_ids) if (isPlainObject(item)) push(item.id);
    }
  }
  if (Array.isArray(extra)) for (const value of extra) push(value);
  return out;
}

// 读取配置文件；`-` 表示 stdin。错误只报告路径与错误码，绝不回显内容。
function readInput(file) {
  if (file === "-") {
    try {
      return { ok: true, text: readFileSync(0, "utf8") };
    } catch (err) {
      return { ok: false, message: `[x] 无法读取 stdin: ${err && err.code ? err.code : "读取失败"}` };
    }
  }
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (err) {
    return { ok: false, message: `[x] 无法读取文件 ${file}: ${err && err.code ? err.code : "读取失败"}` };
  }
}

// 只提取位置与通用原因，绝不带出 err.message（可能含原文片段/凭证）。
function jsonErrorInfo(err, raw) {
  const msg = String(err && err.message ? err.message : "");
  let line = null;
  let column = null;
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc) {
    line = Number(lc[1]);
    column = Number(lc[2]);
  }
  const pos = /at position (\d+)/.exec(msg);
  if (line === null && pos && typeof raw === "string") {
    const p = Math.min(Number(pos[1]), raw.length);
    const before = raw.slice(0, p);
    line = before.split("\n").length;
    const nl = before.lastIndexOf("\n");
    column = p - nl;
  }
  let reason = "语法错误";
  if (/Unexpected end of JSON input/i.test(msg)) reason = "JSON 提前结束";
  else if (/Expected double-quoted property name/i.test(msg)) reason = "对象属性名缺少双引号";
  else if (/Expected ',' or '}'/i.test(msg)) reason = "对象缺少逗号或右花括号";
  else if (/Expected ',' or ']'/i.test(msg)) reason = "数组缺少逗号或右方括号";
  else if (/Expected ':'/i.test(msg)) reason = "属性名后缺少冒号";
  else if (/Unexpected non-whitespace character after JSON/i.test(msg)) reason = "JSON 结束后存在多余内容";
  else if (/Unexpected token/i.test(msg)) reason = "出现非法字符";
  return { line, column, reason };
}

// 1M / 1000k / 纯数字 → 数值
function parseSize(text) {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kKmM])?$/.exec(String(text).trim());
  if (!m) return null;
  const unit = (m[2] || "").toLowerCase();
  const value = Math.round(Number(m[1]) * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePrice(text) {
  const raw = String(text).trim().replace(/^\$/, "");
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// 100k/5k → {input_tokens, output_tokens}
function parseUsage(text) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)\s*\/\s*([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)\s*$/.exec(String(text));
  if (!m) return null;
  const input = parseSize(m[1]);
  const output = parseSize(m[2]);
  if (input === null || output === null) return null;
  return { input_tokens: input, output_tokens: output };
}

// --flag=value 支持：返回 [key, value]；无 = 时 value 为 null
function splitFlag(arg) {
  if (arg.startsWith("--") && arg.includes("=")) {
    const idx = arg.indexOf("=");
    return [arg.slice(0, idx), arg.slice(idx + 1)];
  }
  return [arg, null];
}

function takeValue(args, index, key, inline) {
  if (inline !== null) return { value: inline, next: index };
  if (index + 1 >= args.length) throw new UsageError(`argument ${key}: expected one argument`);
  return { value: args[index + 1], next: index + 1 };
}

function cmdAudit(args, models) {
  let file = null;
  let format = "auto";
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(AUDIT_HELP);
      return 0;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const [key, inline] = splitFlag(arg);
    if (key === "--format") {
      const taken = takeValue(args, i, key, inline);
      format = taken.value;
      i = taken.next;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unrecognized arguments: ${arg}`);
    if (file !== null) throw new UsageError(`unrecognized arguments: ${arg}`);
    file = arg;
  }

  if (file === null) throw new UsageError("需要一个配置文件路径（或 - 读取 stdin）");
  if (!AUDIT_FORMATS.includes(format)) {
    throw new UsageError(`argument --format: invalid choice: ${JSON.stringify(format)} (choose from ${AUDIT_FORMATS.join(", ")})`);
  }

  const read = readInput(file);
  if (!read.ok) {
    stderr(scrub(read.message));
    return 2;
  }
  const raw = read.text;
  const allow = publicTokens(models);

  // 去掉 UTF-8 BOM：JSON.parse 不接受 BOM，但很多编辑器会写入
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let parsed = null;
  let parseFailed = false;
  let parseInfo = null;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    parseFailed = true;
    parseInfo = jsonErrorInfo(err, body);
  }

  const head = body.trimStart();
  const looksJson = head.startsWith("{") || head.startsWith("[");

  // 内容是 JSON 形状（或以 opencode/pi 显式指定）但解析失败：报位置 + 通用原因，
  // 绝不回显原文/凭证。纯文本模式只接受"非 JSON 形状"的输入，避免把破损 JSON
  // 当模型 id 回显。
  if (parseFailed && (looksJson || format === "opencode" || format === "pi")) {
    const where = parseInfo.line !== null && parseInfo.column !== null
      ? `（第 ${parseInfo.line} 行第 ${parseInfo.column} 列）`
      : "";
    stderr(scrub(`[x] 解析 JSON 失败${where}：${parseInfo.reason}`, allow));
    return 2;
  }

  let effective = format;
  if (format === "auto") {
    if (parseFailed) {
      // 非 JSON 形状：按纯文本（每行一个模型 id）处理
      effective = "generic";
    } else {
      effective = detectConfigFormat(parsed);
      if (effective === null) {
        stderr(scrub("[x] 无法识别配置格式（支持 opencode / pi / generic；可用 --format 显式指定）", allow));
        return 2;
      }
    }
  }

  let content = parsed;
  if (effective === "generic") {
    // 成功解析出的对象/数组/字符串走结构化提取；只有"非 JSON 文本"才逐行解析。
    // 避免把 JSON 原文当模型 id 回显（可能夹带凭证）。
    const structured = !parseFailed && (Array.isArray(parsed) || isPlainObject(parsed) || typeof parsed === "string");
    if (!structured) content = body;
  }

  const report = auditConfig(models, content, effective);
  if (!report.entries.length) {
    stderr(scrub("[x] 未从配置中提取到任何模型条目", allow));
    return 2;
  }

  if (json) {
    const payload = {
      format: effective,
      file: file === "-" ? "-" : file,
      entries: report.entries,
      summary: report.summary,
    };
    stdout(scrub(JSON.stringify(payload, null, 2), allow));
  } else {
    stdout(scrub(renderAudit(report, file), allow));
  }
  return report.summary.with_diffs === 0 ? 0 : 1;
}

function cmdSearch(args, models) {
  const filters = { vendors: [], lifecycles: [] };
  let json = false;
  let sort = "price";
  let limit = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(SEARCH_HELP);
      return 0;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--vision") { filters.vision = true; continue; }
    if (arg === "--reasoning") { filters.reasoning = true; continue; }
    if (arg === "--tool-call") { filters.toolCall = true; continue; }
    if (arg === "--pdf") { filters.pdf = true; continue; }

    const [key, inline] = splitFlag(arg);
    if (key === "--min-context" || key === "--max-input-price" || key === "--max-output-price" ||
        key === "--vendor" || key === "--lifecycle" || key === "--sort" || key === "--limit") {
      const taken = takeValue(args, i, key, inline);
      const value = taken.value;
      i = taken.next;
      if (key === "--min-context") {
        const size = parseSize(value);
        if (size === null) throw new UsageError(`argument --min-context: invalid value: ${JSON.stringify(value)}`);
        filters.minContext = size;
      } else if (key === "--max-input-price") {
        const price = parsePrice(value);
        if (price === null) throw new UsageError(`argument --max-input-price: invalid value: ${JSON.stringify(value)}`);
        filters.maxInputPrice = price;
      } else if (key === "--max-output-price") {
        const price = parsePrice(value);
        if (price === null) throw new UsageError(`argument --max-output-price: invalid value: ${JSON.stringify(value)}`);
        filters.maxOutputPrice = price;
      } else if (key === "--vendor") {
        filters.vendors.push(value);
      } else if (key === "--lifecycle") {
        if (!SEARCH_LIFECYCLES.includes(value)) {
          throw new UsageError(`argument --lifecycle: invalid choice: ${JSON.stringify(value)} (choose from ${SEARCH_LIFECYCLES.join(", ")})`);
        }
        filters.lifecycles.push(value);
      } else if (key === "--sort") {
        if (!SEARCH_SORTS.includes(value)) {
          throw new UsageError(`argument --sort: invalid choice: ${JSON.stringify(value)} (choose from ${SEARCH_SORTS.join(", ")})`);
        }
        sort = value;
      } else if (key === "--limit") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new UsageError(`argument --limit: invalid value: ${JSON.stringify(value)}`);
        }
        limit = parsed;
      }
      continue;
    }
    throw new UsageError(`unrecognized arguments: ${arg}`);
  }

  filters.sort = sort;
  if (limit !== null) filters.limit = limit;

  const result = searchModels(models, filters);
  if (json) {
    // 与 listRows() 同形 + cost（机器可读，不含内部辅助字段）
    const rows = result.rows.map((row) => ({
      id: row.id,
      vendor: row.vendor,
      family: row.family,
      lifecycle: row.lifecycle,
      verified: row.verified,
      context_window: row.context_window,
      max_output_tokens: row.max_output_tokens,
      reasoning: row.reasoning,
      cost: row.cost,
    }));
    stdout(JSON.stringify(rows, null, 2));
  } else {
    stdout(renderSearch(result));
  }
  return 0;
}

function cmdCompare(args, models) {
  const ids = [];
  let usage = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(COMPARE_HELP);
      return 0;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const [key, inline] = splitFlag(arg);
    if (key === "--usage") {
      const taken = takeValue(args, i, key, inline);
      usage = parseUsage(taken.value);
      if (usage === null) throw new UsageError(`argument --usage: invalid value: ${JSON.stringify(taken.value)}（示例：100k/5k）`);
      i = taken.next;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unrecognized arguments: ${arg}`);
    ids.push(arg);
  }

  if (ids.length < 2) throw new UsageError("至少需要 2 个模型 id");
  if (ids.length > 4) throw new UsageError("最多支持 4 个模型 id");

  // 防御性：用户输入的 id 会原样回显，先脱敏（公开 catalog id/别名经白名单保护）
  const safeIds = ids.map((id) => scrub(id, publicTokens(models)));
  const data = compareModels(models, safeIds, usage);
  if (json) {
    stdout(JSON.stringify(data, null, 2));
  } else {
    stdout(renderCompare(data));
  }

  const unmatched = data.models.filter((model) => !model.matchedId);
  for (const model of unmatched) {
    const suggestion = model.suggestion ? ` 最接近: ${model.suggestion}` : "";
    stderr(`[x] ${model.input}: ${NOT_FOUND_TEXT}${suggestion}`);
  }
  return unmatched.length ? 1 : 0;
}

// 默认扫描的配置文件（存在才读；缺失静默跳过，不算错误）
const PROTOCOL_DEFAULT_FILES = [
  { path: path.join(os.homedir(), ".config", "opencode", "opencode.json"), tool: "opencode", shape: "opencode", type: "json" },
  { path: path.join(os.homedir(), ".pi", "agent", "models.json"), tool: "pi", shape: "pi", type: "json" },
  { path: path.join(os.homedir(), ".pi", "agent", "models-store.json"), tool: "pi", shape: "pi-store", type: "json" },
  { path: path.join(os.homedir(), ".claude", "settings.json"), tool: "claude-code", shape: "claude-code", type: "json" },
  { path: path.join(os.homedir(), ".codex", "config.toml"), tool: "codex", shape: "codex", type: "toml" },
];

// 按文件名/内容猜测 --file 额外路径的格式；猜不出时按内容特征判定。
function detectSourceShape(file, text) {
  const base = path.basename(String(file)).toLowerCase();
  if (base.endsWith(".toml")) return { tool: "codex", shape: "codex", type: "toml" };
  const lower = base;
  if (lower === "models-store.json") return { tool: "pi", shape: "pi-store", type: "json" };
  if (lower === "settings.json") return { tool: "claude-code", shape: "claude-code", type: "json" };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (isPlainObject(parsed)) {
    if (isPlainObject(parsed.provider)) return { tool: "opencode", shape: "opencode", type: "json" };
    if (isPlainObject(parsed.providers)) return { tool: "pi", shape: "pi", type: "json" };
    if (isPlainObject(parsed.env) && (typeof parsed.env.ANTHROPIC_BASE_URL === "string" || typeof parsed.env.ANTHROPIC_MODEL === "string")) {
      return { tool: "claude-code", shape: "claude-code", type: "json" };
    }
    // models-store.json：顶层全是 provider 名，每个值带 models 数组
    const values = Object.values(parsed);
    if (values.length && values.every((v) => isPlainObject(v) && Array.isArray(v.models))) {
      return { tool: "pi", shape: "pi-store", type: "json" };
    }
  }
  return null;
}

const PROTOCOLS_HELP = `usage: apifix protocols [--file <path>]... [--json] [--no-defaults]

跨工具协议总览：列出各配置中每个 provider 说的协议，并对照模型原生协议，
标出需要中转翻译（参数可能被静默丢弃）的条目。

options:
  --file PATH           额外配置文件（可重复）；默认文件仍会扫描
  --no-defaults         只扫描 --file 指定的文件，跳过默认路径
  --json                输出机器可读 JSON
  -h, --help            显示帮助并退出

默认扫描（存在才读，缺失静默跳过）：
  ~/.config/opencode/opencode.json
  ~/.pi/agent/models.json
  ~/.pi/agent/models-store.json
  ~/.claude/settings.json
  ~/.codex/config.toml

退出码：0 成功（即使存在协议不匹配）；2 用法错误 / 全部文件不可读`;

function cmdProtocols(args, models) {
  const extraFiles = [];
  let json = false;
  let noDefaults = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(PROTOCOLS_HELP);
      return 0;
    }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--no-defaults") { noDefaults = true; continue; }
    const [key, inline] = splitFlag(arg);
    if (key === "--file") {
      const taken = takeValue(args, i, key, inline);
      extraFiles.push(taken.value);
      i = taken.next;
      continue;
    }
    throw new UsageError(`unrecognized arguments: ${arg}`);
  }

  // 待扫描清单：默认路径 + --file（去重）
  const planned = [];
  const seen = new Set();
  const add = (item) => {
    const resolved = path.resolve(item.path);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    planned.push({ ...item, path: resolved });
  };
  if (!noDefaults) for (const item of PROTOCOL_DEFAULT_FILES) add(item);
  for (const file of extraFiles) add({ path: file, tool: null, shape: null, type: null });

  const sources = [];
  const unreadable = [];
  for (const item of planned) {
    let text;
    try {
      text = readFileSync(item.path, "utf8");
    } catch {
      // 默认路径缺失 = 静默跳过；--file 指定的路径缺失要报告
      if (extraFiles.includes(item.path) || extraFiles.some((f) => path.resolve(f) === item.path)) {
        unreadable.push(item.path);
      }
      continue;
    }
    let shape = item.shape;
    let tool = item.tool;
    let type = item.type;
    if (!shape) {
      const detected = detectSourceShape(item.path, text);
      if (!detected) {
        unreadable.push(item.path);
        continue;
      }
      shape = detected.shape;
      tool = detected.tool;
      type = detected.type;
    }

    let config = null;
    if (type === "toml") {
      config = parseCodexToml(text);
    } else {
      try {
        config = JSON.parse(text);
      } catch {
        stderr(scrub(`[x] 解析失败（非合法 JSON）: ${item.path}`));
        unreadable.push(item.path);
        continue;
      }
    }

    // claude settings.json 的协议信息在 env 下，而 env 属于凭证敏感区。
    // 先用白名单只取出 BASE_URL + 模型 id（AUTH_TOKEN 等一律不进内存对象），
    // 再对整体做 stripCredentials 兜底，确保进入 core 的对象无凭证。
    if (shape === "claude-code") {
      const env = claudeProtocolEnv(config);
      sources.push({ tool, shape, file: item.path, config: env ? { env } : {} });
      continue;
    }
    sources.push({ tool, shape, file: item.path, config: stripCredentials(config) });
  }

  if (!sources.length) {
    for (const file of unreadable) stderr(scrub(`[x] 无法读取或识别文件: ${file}`));
    stderr(scrub("[x] 没有可用的配置文件（默认路径均不存在或无法解析）"));
    return 2;
  }
  for (const file of unreadable) stderr(scrub(`[x] 无法读取或识别文件: ${file}`));

  const report = protocolsReport(models, sources);
  if (json) {
    stdout(scrub(JSON.stringify(report, null, 2), publicTokens(models)));
  } else {
    stdout(scrub(renderProtocols(report), publicTokens(models)));
  }
  // 协议不匹配是提示信息，不影响退出码
  return 0;
}

// --------------------------------------------------------------------------
// UI 静态服务（仅 node:http，零依赖）
// --------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// 把 URL 路径映射到项目根下的真实文件；不允许的路径返回 null。
function resolveRequestPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = decoded.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((s) => s === ".." || s === ".")) return null;

  if (normalized === "/" || normalized === "/index.html") {
    return { file: path.join(ROOT, "index.html"), redirect: null };
  }
  if (normalized === "/ui" || normalized === "/ui/") {
    return { file: path.join(ROOT, "ui", "index.html"), redirect: null };
  }
  if (normalized === "/lib" || normalized === "/lib/") {
    return null;
  }
  if (normalized === "/catalog.json") {
    return { file: path.join(ROOT, "catalog.json"), redirect: null };
  }
  if (normalized.startsWith("/ui/") || normalized.startsWith("/lib/")) {
    const file = path.join(ROOT, normalized.slice(1));
    if (!isPathInside(file, ROOT)) return null;
    return { file, redirect: null };
  }
  return null;
}

function sendNotFound(res) {
  const body = "404 Not Found\n";
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function createUiServer() {
  return createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405 Method Not Allowed\n");
      return;
    }

    const urlPath = (req.url || "/").split("?")[0].split("#")[0];
    const target = resolveRequestPath(urlPath);
    if (!target) {
      sendNotFound(res);
      return;
    }

    let body;
    try {
      body = readFileSync(target.file);
    } catch {
      sendNotFound(res);
      return;
    }

    const ext = path.extname(target.file).toLowerCase();
    const headers = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else res.end(body);
  });
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 静默忽略：打不开浏览器不影响服务
  }
}

function startUi(port, autoOpen) {
  const server = createUiServer();
  let attempt = 0;
  let started = false;

  // 注意：不要把回调传给 server.listen()——重试时它会叠加 once('listening')
  // 监听器导致 URL 打印多次。统一用常驻监听器。
  server.on("error", (err) => {
    if (started) {
      stderr(`[x] UI 服务错误: ${err.message}`);
      return;
    }
    if (err.code === "EADDRINUSE" && attempt < 10) {
      attempt += 1;
      server.listen(port + attempt, "127.0.0.1");
      return;
    }
    stderr(`[x] 启动 UI 服务失败: ${err.message}`);
    process.exit(2);
  });

  server.on("listening", () => {
    if (started) return;
    started = true;
    const actual = server.address().port;
    const url = `http://127.0.0.1:${actual}/`;
    stdout(url);
    if (autoOpen) openBrowser(url);
  });

  server.listen(port, "127.0.0.1");

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function main(argv) {
  // 子命令优先：apifix audit|search|compare|protocols ...（其余走原有位置参数解析，行为不变）
  const SUBCOMMANDS = { audit: cmdAudit, search: cmdSearch, compare: cmdCompare, protocols: cmdProtocols };
  if (argv.length && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) {
    const name = argv[0];
    const subArgs = argv.slice(1);
    try {
      let catalog;
      try {
        catalog = JSON.parse(readFileSync(DEFAULT_CATALOG, "utf8"));
      } catch (err) {
        stderr(scrub(`[x] 读取 catalog 失败: ${err && err.code ? err.code : "解析失败"}`));
        return 2;
      }
      if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
        stderr("[x] 读取 catalog 失败: catalog.json 结构非法：需要 {version, models: [...]}");
        return 2;
      }
      return SUBCOMMANDS[name](subArgs, catalog.models);
    } catch (err) {
      if (err instanceof UsageError) {
        stderr(scrub(`apifix ${name}: error: ${err.message}`));
        stderr(scrub(`用法见：node apifix.mjs ${name} --help`));
        return 2;
      }
      // 意外错误同样脱敏后输出（可能夹带配置片段/凭证）
      stderr(scrub(`[x] 运行失败: ${err && err.message ? err.message : err}`));
      return 2;
    }
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(HELP);
      stderr(`apifix: error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (opts.help) {
    stdout(HELP);
    return 0;
  }
  if (opts.version) {
    stdout(`apifix ${VERSION}`);
    return 0;
  }

  if (opts.ui) {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      stderr(`[x] 非法端口: ${opts.port}`);
      return 2;
    }
    startUi(port, !opts.noOpen);
    return 0;
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(opts.catalog, "utf8"));
  } catch (err) {
    stderr(`[x] 读取 catalog 失败: ${err.message}`);
    return 2;
  }
  if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    stderr("[x] 读取 catalog 失败: catalog.json 结构非法：需要 {version, models: [...]}");
    return 2;
  }
  const models = catalog.models;

  if (opts.list) {
    stdout(cmdList(models, opts.json));
    return 0;
  }

  if (opts.match) {
    return cmdMatch(opts.match, models);
  }

  if (!opts.modelId) {
    stderr(HELP);
    return 2;
  }

  const res = matchModel(models, opts.modelId);
  if (!res.entry) {
    if (res.suggestion) {
      stderr(`[x] ${opts.modelId}: ${NOT_FOUND_TEXT} 最接近: ${res.suggestion}（score=${res.score.toFixed(2)}）`);
    } else {
      stderr(`[x] ${opts.modelId}: ${NOT_FOUND_TEXT}`);
    }
    return 1;
  }

  const entry = res.entry;
  const notes = res.notes || [];
  for (const note of notes) stderr(note);

  if (opts.json) {
    stdout(JSON.stringify(entry, null, 2));
    return 0;
  }

  const key = opts.canonicalId ? res.matchedId || opts.modelId : opts.modelId.trim();
  const defaultName = opts.canonicalId ? res.matchedId || opts.modelId : opts.modelId.trim();
  const name = opts.name || defaultName;

  let emit = opts.emit;
  if (opts.card) {
    stdout(renderCard(entry, notes.length ? notes.join("\n") : null));
    if (emit) stdout("");
  } else if (!emit) {
    emit = "opencode";
  }

  if (emit) {
    if (emit === "pi" && entry.vision === null) {
      stderr("[i] vision 未文档化，pi input 仅含 text（需人工确认）");
    }
    if (emit === "opencode" || emit === "pi") {
      // 完整模式（-f）：字段由 core.mjs 决定，缺失数据说明经 onNote 走既有 stderr 通道。
      const onNote = (line) => stderr(line);
      if (emit === "opencode") stdout(emitOpencode(entry, { name, keyId: key, full: opts.full, onNote }));
      else stdout(emitPi(entry, { name, id: key, full: opts.full, onNote }));
    } else {
      if (opts.full) stderr("[i] --full 仅对 opencode/pi 生效，已忽略");
      stdout(emitExtra(entry, emit, { name, keyId: key }));
    }
  }
  return 0;
}

// 输出被 head 等提前关闭时静默退出（对齐 Python 的 BrokenPipeError 处理）
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err && err.code === "EPIPE") process.exit(0);
  stderr(`[x] 运行失败: ${err && err.message ? err.message : err}`);
  process.exitCode = 2;
}
