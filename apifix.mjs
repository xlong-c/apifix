#!/usr/bin/env node
// apifix — 模型官方参数速查 + 配置片段生成器（Node >= 18 / 零依赖 / ESM）
//
// 给定一个模型 id（支持中转/别名写法），打印该模型的**官网规格值**以及可直接粘贴的
// opencode / pi 等配置片段；另带一个纯静态的本地 Web UI（`--ui`）。
//
// 退出码：0 成功；1 未收录；2 用法/输入错误。
//
// 与 legacy-python/apifix.py 行为对齐；核心逻辑在 ./lib/core.mjs（浏览器通用）。

import { readFileSync, writeFileSync, renameSync, statSync, existsSync, copyFileSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  matchModel,
  emitOpencode,
  emitPi,
  deriveProviderName,
  OPENCODE_NPM_DEFAULTS,
  buildOpencodeProvider,
  emitExtra,
  renderCard,
  listRows,
  detectConfigFormat,
  auditConfig,
  renderAudit,
  planConfigFixes,
  applyConfigFixes,
  planCodexFixes,
  applyCodexFixes,
  renderFixPlan,
  AUDIT_FIELD_LABELS,
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
  isCredentialKey,
  // 共享的列对齐 / 宽度小工具（--list/--match 的表格渲染依赖，单一实现）
  displayWidth,
  pad,
  groupThousands,
} from "./lib/core.mjs";

const EMIT_TARGETS = ["opencode", "pi", "codex", "claude-env", "curl", "sdk"];

const VERSION = "0.2.3";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.join(ROOT, "catalog.json");
const DEFAULT_PORT = 7788;

const MISSING_TEXT = "unknown";
const NOT_FOUND_TEXT = "未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）";
// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

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
       apifix fix {opencode|pi|<file>} [--format {auto,opencode,pi}] [--dry-run] [--yes] [--json] [--no-backup]
       apifix search [filters] [--json]
       apifix compare <id1> <id2> [<id3>] [<id4>] [--usage IN/OUT] [--json]
       apifix protocols [--file <path>]... [--json] [--no-defaults]

查询模型官网参数规格，并生成 opencode / pi 等配置片段（纯本地，无网络请求）

positional arguments:
  model_id              模型 id，可带厂商前缀/relay 后缀

subcommands:
  audit <file|->        审计配置文件（或 stdin）中的模型条目与官网规格差异
  fix {opencode|pi|<file>}
                        交互式修复配置文件（显示差异，按 y 应用 / n 取消）
  login opencode [名称]
                        交互式添加 opencode 供应商（baseURL / API 格式 / key / 模型）
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

各子命令详情：node apifix.mjs audit --help / fix --help / search --help / compare --help`;

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

const AUDIT_FORMATS = ["auto", "opencode", "pi", "codex", "claude", "generic"];
const SEARCH_SORTS = ["price", "context", "output", "id"];
const SEARCH_LIFECYCLES = ["current", "legacy", "retired", "unreleased"];

const AUDIT_HELP = `usage: apifix audit <file|-> [--format {auto,opencode,pi,codex,claude,generic}] [--json]

读取配置文件（- 表示 stdin），提取模型条目并与 catalog 官网规格逐项比对。
输出经凭证脱敏（key/token/secret 一律替换为 [REDACTED]，且永不回显文件原文）。

arguments:
  file                  配置文件路径；- 表示从 stdin 读取

options:
  --format {auto,opencode,pi,codex,claude,generic}
                        配置格式（默认 auto 自动识别；claude-env 为 claude 的别名）
                        codex  = ~/.codex/config.toml（TOML）
                        claude = ~/.claude/settings.json（env 白名单，AUTH_TOKEN 永不读取）
  --json                输出机器可读 JSON（无 ANSI/制表符）
  -h, --help            显示帮助并退出

退出码：0 全部一致；1 存在差异或未收录；2 用法/解析错误`;

const FIX_HELP = `usage: apifix fix {opencode|pi|codex|claude|<file>} [--format {auto,opencode,pi,codex,claude}] [--fill] [--dry-run] [--yes] [--json] [--no-backup]

对比配置文件与 catalog 官网规格，显示修复计划并按 y 应用 / n 取消。
只修正已声明的规格字段，绝不触碰 apiKey/token 等凭证（claude 的 AUTH_TOKEN 永不读写）。

target:
  opencode              ~/.config/opencode/opencode.json
  pi                    ~/.pi/agent/models.json
  codex                 ~/.codex/config.toml
  claude                ~/.claude/settings.json
  <file>                其它文件路径（需 --format 或可自动识别）

options:
  --dry-run             只显示修复计划，不询问、不写入
  --fill                补齐模式：未声明的规格字段也纳入计划（从「缺失」→ 官网值）；
                        仅 opencode / pi 支持，codex / claude 不支持（exit 2）
  -y, --yes             跳过询问直接应用（脚本用）
  --json                输出机器可读 JSON；不询问（无 --yes 时只输出计划）
  --no-backup           不写备份文件
  --format {auto,opencode,pi,codex,claude}
                        自定义路径时的格式（默认 auto；auto 失败报错 exit 2）
  -h, --help            显示帮助并退出

退出码：0 已应用或无差异；1 取消 / 复验仍有差异；2 用法/解析错误`;

const LOGIN_HELP = `usage: apifix login opencode [名称]
       [--base-url URL] [--protocol {openai,anthropic,gemini}] [--api-key KEY]
       [--model ID]... [--file 路径] [--no-fetch] [--yes] [--json] [--force] [--no-backup]

交互式添加 opencode 供应商：写入 {provider: {<名称>: {npm, options.baseURL, models}}}。
模型规格取自 catalog 官网数据（精确/别名/旧版/归一化命中时）；未收录的模型写最小条目。
API key 仅写入 options.apiKey，任何输出（含 --json）都不回显明文，错误信息一律脱敏。

arguments:
  名称                  provider 名称（缺省时从 baseURL 主机名派生，可交互输入）

options:
  --base-url URL        API 地址（OpenAI 兼容中转通常以 /v1 结尾）
  --protocol {openai,anthropic,gemini}
                        API 格式（默认 openai；决定 provider.npm 包）
  --api-key KEY         非交互模式直接给 key（交互模式忽略此 flag，走静默输入）
  --model ID            预置模型 id（可重复或逗号分隔；未给时交互模式自动检测）
  --file 路径           目标配置文件（默认 ~/.config/opencode/opencode.json）
  --no-fetch            跳过 GET {baseURL}/models 自动检测（直接手动输入模型）
  -y, --yes             跳过确认直接写入（脚本用）
  --json                输出机器可读 JSON（key 以掩码呈现，绝不输出明文）
  --force               非交互模式下覆盖同名 provider（交互模式会询问）
  --no-backup           覆盖已有文件时不写备份
  -h, --help            显示帮助并退出

退出码：0 已写入；1 取消 / 复验有差异；2 用法/解析错误（非交互缺 flag 时提示缺什么）`;

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
  if (format === "claude-env") format = "claude"; // 常用别名（与 --emit claude-env 对齐）
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

  // codex config.toml：显式 --format codex，或 auto 下 .toml 后缀 / TOML 内容特征命中。
  // 必须在「JSON 形状解析失败」判定之前：TOML 的 [model_providers.x] 也以 [ 开头。
  const tomlByExt = file !== "-" && /\.toml$/i.test(file);
  const tomlByHint = !looksJson && (/(^|\n)\s*\[model_providers?\./.test(body)
    || /(^|\n)\s*model_provider\s*=/.test(body) || /(^|\n)\s*model\s*=/.test(body));
  const isCodex = format === "codex" || (format === "auto" && (tomlByExt || tomlByHint));

  // 内容是 JSON 形状（或以 opencode/pi/claude 显式指定）但解析失败：报位置 + 通用原因，
  // 绝不回显原文/凭证。纯文本模式只接受"非 JSON 形状"的输入，避免把破损 JSON
  // 当模型 id 回显。
  if (!isCodex && parseFailed && (looksJson || format === "opencode" || format === "pi" || format === "claude")) {
    const where = parseInfo.line !== null && parseInfo.column !== null
      ? `（第 ${parseInfo.line} 行第 ${parseInfo.column} 列）`
      : "";
    stderr(scrub(`[x] 解析 JSON 失败${where}：${parseInfo.reason}`, allow));
    return 2;
  }

  // codex config.toml：显式 --format codex，或 auto 下 .toml 后缀 / TOML 内容特征命中
  let effective = format;
  let content = parsed;
  let report;
  if (isCodex) {
    effective = "codex";
    report = auditConfig(models, parseCodexToml(body), "codex");
  } else {
    if (format === "auto") {
      if (parseFailed) {
        // 非 JSON 形状：按纯文本（每行一个模型 id）处理
        effective = "generic";
      } else {
        effective = detectConfigFormat(parsed);
        if (effective === null) {
          stderr(scrub("[x] 无法识别配置格式（支持 opencode / pi / codex / claude / generic；可用 --format 显式指定）", allow));
          return 2;
        }
      }
    }

    if (effective === "generic") {
      // 成功解析出的对象/数组/字符串走结构化提取；只有"非 JSON 文本"才逐行解析。
      // 避免把 JSON 原文当模型 id 回显（可能夹带凭证）。
      const structured = !parseFailed && (Array.isArray(parsed) || isPlainObject(parsed) || typeof parsed === "string");
      if (!structured) content = body;
    }

    report = auditConfig(models, content, effective);
  }

  if (!report.entries.length) {
    const hint = effective === "codex" ? "（TOML 需含顶层 model = \"...\"）" : "";
    stderr(scrub(`[x] 未从配置中提取到任何模型条目${hint}`, allow));
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

// 配置文件根目录。UI 本机读写可设 APIFIX_HOME 指向临时目录（测试用）；CLI 始终走 os.homedir()。
function uiHomeDir() {
  const override = process.env.APIFIX_HOME;
  if (typeof override === "string" && override.trim()) return override.trim();
  return os.homedir();
}

// fix 的目标别名 → 默认文件路径
function fixTargetPath(target) {
  if (target === "opencode") return path.join(os.homedir(), ".config", "opencode", "opencode.json");
  if (target === "pi") return path.join(os.homedir(), ".pi", "agent", "models.json");
  if (target === "codex") return path.join(os.homedir(), ".codex", "config.toml");
  if (target === "claude") return path.join(os.homedir(), ".claude", "settings.json");
  return target;
}

function uiConfigPath(target) {
  const home = uiHomeDir();
  if (target === "opencode") return path.join(home, ".config", "opencode", "opencode.json");
  if (target === "pi") return path.join(home, ".pi", "agent", "models.json");
  if (target === "codex") return path.join(home, ".codex", "config.toml");
  if (target === "claude") return path.join(home, ".claude", "settings.json");
  return target;
}

// 读取 stdin 的一行（交互询问用）。返回 { text, eof }；EOF 时 eof 为 true。
function readStdinLine() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = (eof) => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      resolve({ text: data, eof });
    };
    const onData = (chunk) => {
      data += chunk;
      if (data.includes("\n")) finish(false);
    };
    const onEnd = () => finish(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

// 时间戳：YYYYMMDD-HHMMSS（本地时区）
function backupTimestamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 生成不冲突的备份路径：<file>.bak-<时间戳>，同名则加 -1 / -2 …
function uniqueBackupPath(file, date) {
  const stamp = backupTimestamp(date);
  let candidate = `${file}.bak-${stamp}`;
  let seq = 1;
  while (existsSync(candidate)) {
    candidate = `${file}.bak-${stamp}-${seq}`;
    seq += 1;
  }
  return candidate;
}

// 检测原文件的缩进（2 / 4 / tab）；无法判断时回退 2。
function detectIndent(body) {
  const m = /\n([ \t]+)"/.exec(body);
  if (!m) return 2;
  const ws = m[1];
  return ws.includes("\t") ? "\t" : ws.length;
}

// 按原文件风格序列化：保留缩进 / 末尾换行 / CRLF / BOM。
function serializeConfig(config, style) {
  let out = JSON.stringify(config, null, style.indent);
  if (style.trailingNewline) out += "\n";
  if (style.crlf) out = out.replace(/\n/g, "\r\n");
  if (style.bom) out = "\ufeff" + out;
  return out;
}

// 原子写入：同目录 tmp + rename，保留原文件 mode。失败清理 tmp。
function writeAtomic(file, text, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.apifix-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    if (mode !== null) {
      try { chmodSync(tmp, mode); } catch { /* mode 保留失败不阻断写入 */ }
    }
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 忽略清理失败 */ }
    throw err;
  }
}

// Windows 下 rename 对被占用/只读的目标文件常抛 EPERM/EACCES（Linux 上是原子替换，
// Windows 上目标被编辑器/同步盘短暂锁定即失败）。给用户可操作的提示；
// exit code 语义不变（异常继续向上抛，仍是非零失败），提示只走 stderr（不变量 5）。
function isWindowsFileLockError(err) {
  return err && (err.code === "EPERM" || err.code === "EACCES") && process.platform === "win32";
}

function warnWindowsFileLock(err, file, backup) {
  if (!isWindowsFileLockError(err)) return;
  const backupNote = backup ? `备份已写至 ${backup}，原文件未被修改` : "原文件未被修改（本次未创建备份）";
  stderr(`[!] 写入 ${file} 失败（${err.code}）：目标文件可能被其他程序占用或只读，`
    + `请关闭编辑器/同步盘后重试；${backupNote}`);
}

// 修复计划应用后的摘要（JSON / TOML 两条路径共用）：逐条列出被改动的模型
function reportFixApplied(plan, backup) {
  const touched = plan.entries.filter((e) => e.changes.length);
  stdout(`已修复 ${plan.summary.change_items} 项 / ${touched.length} 个模型：`);
  for (const entry of touched) {
    const fields = entry.changes.map((c) => AUDIT_FIELD_LABELS[c.field] || c.field).join("、");
    stdout(`  - ${entry.input}（${fields}）`);
  }
  if (backup) stdout(`备份：${backup}`);
  if (plan.summary.skipped_items) {
    const manual = [];
    for (const entry of plan.entries) {
      for (const skip of entry.skipped) manual.push(`${entry.input}: ${skip.field}（${skip.reason}）`);
    }
    stdout(`剩余需人工确认 ${plan.summary.skipped_items} 项：${manual.join("；")}`);
  }
}

// fix（codex TOML）：与 JSON 路径同构；写入走行级回写（applyCodexFixes），
// 备份 / 原子写 / EPERM 提示复用同一管道。
async function cmdFixCodex({ file, body, models, allow, json, yes, dryRun, noBackup, mode }) {
  const plan = planCodexFixes(models, body);
  const hasChanges = plan.summary.change_items > 0;

  if (json) {
    let applied = false;
    let backup = null;
    if (hasChanges && yes && !dryRun) {
      const result = commitCodexFix(file, body, plan, mode, noBackup);
      applied = true;
      backup = result.backup;
      stdout(scrub(JSON.stringify({
        format: "codex", file, dry_run: false, applied, backup,
        entries: plan.entries, summary: plan.summary,
      }, null, 2), allow));
      return planCodexFixes(models, result.text).summary.change_items > 0 ? 1 : 0;
    }
    stdout(scrub(JSON.stringify({
      format: "codex", file, dry_run: dryRun, applied, backup,
      entries: plan.entries, summary: plan.summary,
    }, null, 2), allow));
    return hasChanges ? 1 : 0;
  }

  if (!hasChanges) {
    stdout(scrub(renderFixPlan(plan, file), allow));
    return 0;
  }
  stdout(scrub(renderFixPlan(plan, file), allow));

  if (dryRun) {
    stderr("[i] --dry-run：仅显示修复计划，未写入");
    return 1;
  }

  let answer = "y";
  if (!yes) {
    process.stdout.write(`应用以上 ${plan.summary.change_items} 处修正？[y/N] `);
    const reply = await readStdinLine();
    if (reply.eof) {
      stderr("[i] 非交互环境：使用 --yes 应用，或 --dry-run 仅预览");
      return 1;
    }
    answer = reply.text.trim().toLowerCase();
  }
  if (answer !== "y" && answer !== "yes") {
    stderr("[i] 已取消，未写入任何更改");
    return 1;
  }

  const result = commitCodexFix(file, body, plan, mode, noBackup);
  const verify = planCodexFixes(models, result.text);
  reportFixApplied(plan, result.backup);
  return verify.summary.change_items > 0 ? 1 : 0;
}

// codex 写入：备份（可选）→ 行级回写 → 原子写（与 JSON 路径同一套错误提示语义）
function commitCodexFix(file, body, plan, mode, noBackup) {
  let backup = null;
  if (!noBackup) {
    backup = uniqueBackupPath(file, new Date());
    copyFileSync(file, backup);
  }
  const text = applyCodexFixes(body, plan);
  try {
    writeAtomic(file, text, mode);
  } catch (err) {
    warnWindowsFileLock(err, file, backup);
    throw err;
  }
  return { text, backup };
}

const FIX_FORMATS = ["auto", "opencode", "pi", "codex", "claude"];

async function cmdFix(args, models) {
  let target = null;
  let format = null;
  let dryRun = false;
  let yes = false;
  let json = false;
  let noBackup = false;
  let fill = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(FIX_HELP);
      return 0;
    }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--fill") { fill = true; continue; }
    if (arg === "-y" || arg === "--yes") { yes = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--no-backup") { noBackup = true; continue; }
    const [key, inline] = splitFlag(arg);
    if (key === "--format") {
      const taken = takeValue(args, i, key, inline);
      format = taken.value;
      i = taken.next;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unrecognized arguments: ${arg}`);
    if (target !== null) throw new UsageError(`unrecognized arguments: ${arg}`);
    target = arg;
  }

  if (target === null) throw new UsageError("需要一个目标：opencode / pi / codex / claude 或配置文件路径");
  if (target === "-") throw new UsageError("fix 不支持 stdin（-）；请传入配置文件路径");
  if (format === "claude-env") format = "claude"; // 常用别名（与 --emit claude-env 对齐）
  if (format !== null && !FIX_FORMATS.includes(format)) {
    throw new UsageError(`argument --format: invalid choice: ${JSON.stringify(format)} (choose from ${FIX_FORMATS.join(", ")})`);
  }

  // 命名目标自带格式（--format 仅用于自定义路径，避免误配导致错误修复）
  let effectiveFormat;
  if (target === "opencode" || target === "pi" || target === "codex" || target === "claude") effectiveFormat = target;
  else effectiveFormat = format || "auto";
  const file = fixTargetPath(target);
  const allow = publicTokens(models);

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    stderr(scrub(`[x] 无法读取文件 ${file}: ${err && err.code ? err.code : "读取失败"}`, allow));
    return 2;
  }

  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;

  let mode = null;
  try { mode = statSync(file).mode & 0o777; } catch { mode = null; }

  // codex：TOML 文本路径（在 JSON.parse 之前分流；写入走行级回写，其余字节不动）
  const tomlByExt = /\.toml$/i.test(file);
  const tomlByHint = /(^|\n)\s*\[model_providers?\./.test(body) || /(^|\n)\s*model_provider\s*=/.test(body);
  const useToml = effectiveFormat === "codex" || (effectiveFormat === "auto" && (tomlByExt || tomlByHint));
  if (useToml) {
    if (fill) {
      stderr(scrub("[x] --fill 不支持 codex 格式（TOML 行级回写只修已声明字段）", allow));
      return 2;
    }
    return await cmdFixCodex({ file, body, models, allow, json, yes, dryRun, noBackup, mode });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const info = jsonErrorInfo(err, body);
    const where = info.line !== null && info.column !== null ? `（第 ${info.line} 行第 ${info.column} 列）` : "";
    stderr(scrub(`[x] 解析 JSON 失败${where}：${info.reason}`, allow));
    return 2;
  }

  if (effectiveFormat === "auto") {
    const detected = detectConfigFormat(parsed);
    if (detected === null || detected === "generic") {
      stderr(scrub("[x] 无法识别可自动修复的配置格式（支持 opencode / pi / codex / claude；可用 --format 显式指定）", allow));
      return 2;
    }
    effectiveFormat = detected;
  }
  if (effectiveFormat !== "opencode" && effectiveFormat !== "pi" && effectiveFormat !== "claude") {
    stderr(scrub("[x] 该格式不支持自动修复", allow));
    return 2;
  }
  if (fill && effectiveFormat === "claude") {
    stderr(scrub("[x] --fill 不支持 claude 格式（env 白名单只修已声明字段）", allow));
    return 2;
  }

  const plan = planConfigFixes(models, parsed, effectiveFormat, { fill });
  const hasChanges = plan.summary.change_items > 0;
  const fileLabel = file === "-" ? "-" : file;

  // 样式：缩进 / 末尾换行 / CRLF / BOM（mode 已在读取后取得）
  const style = {
    indent: detectIndent(body),
    trailingNewline: body.endsWith("\n"),
    crlf: body.includes("\r\n"),
    bom,
  };

  // --json：不询问；无 --yes 时只输出计划
  if (json) {
    let applied = false;
    let backup = null;
    if (hasChanges && yes && !dryRun) {
      const appliedResult = commitFix(file, parsed, plan, style, mode, noBackup);
      applied = true;
      backup = appliedResult.backup;
      const verify = planConfigFixes(models, appliedResult.config, effectiveFormat, { fill });
      const payload = {
        format: effectiveFormat,
        file: fileLabel,
        fill,
        dry_run: false,
        applied,
        backup,
        entries: plan.entries,
        summary: plan.summary,
      };
      stdout(scrub(JSON.stringify(payload, null, 2), allow));
      return verify.summary.change_items > 0 ? 1 : 0;
    }
    const payload = {
      format: effectiveFormat,
      file: fileLabel,
      fill,
      dry_run: dryRun,
      applied,
      backup,
      entries: plan.entries,
      summary: plan.summary,
    };
    stdout(scrub(JSON.stringify(payload, null, 2), allow));
    return hasChanges ? 1 : 0;
  }

  // 全部一致：不询问
  if (!hasChanges) {
    stdout(scrub(renderFixPlan(plan, file), allow));
    return 0;
  }

  // 渲染计划（经脱敏）
  stdout(scrub(renderFixPlan(plan, file), allow));

  // --dry-run：不询问、不写入
  if (dryRun) {
    stderr("[i] --dry-run：仅显示修复计划，未写入");
    return 1;
  }

  // 询问
  let answer = "y";
  if (!yes) {
    process.stdout.write(`应用以上 ${plan.summary.change_items} 处修正？[y/N] `);
    const reply = await readStdinLine();
    if (reply.eof) {
      stderr("[i] 非交互环境：使用 --yes 应用，或 --dry-run 仅预览");
      return 1;
    }
    answer = reply.text.trim().toLowerCase();
  }

  if (answer !== "y" && answer !== "yes") {
    stderr("[i] 已取消，未写入任何更改");
    return 1;
  }

  const result = commitFix(file, parsed, plan, style, mode, noBackup);

  // 写后复验：重新计算计划
  const verify = planConfigFixes(models, result.config, effectiveFormat, { fill });

  // 摘要
  reportFixApplied(plan, result.backup);

  return verify.summary.change_items > 0 ? 1 : 0;
}

// 应用计划：备份（可选）→ 纯函数产出新 config → 按原风格序列化 → 原子写入。
// 顺序语义：备份成功 → 写入失败时，原文件未动、备份已在；错误信息明确说明这两点。
function commitFix(file, parsed, plan, style, mode, noBackup) {
  let backup = null;
  if (!noBackup) {
    backup = uniqueBackupPath(file, new Date());
    copyFileSync(file, backup);
  }
  const nextConfig = applyConfigFixes(parsed, plan);
  const text = serializeConfig(nextConfig, style);
  try {
    writeAtomic(file, text, mode);
  } catch (err) {
    warnWindowsFileLock(err, file, backup);
    throw err;
  }
  return { config: nextConfig, backup };
}

// --------------------------------------------------------------------------
// login 子命令：交互式添加 opencode 供应商
// --------------------------------------------------------------------------

const LOGIN_PROTOCOLS = ["openai", "anthropic", "gemini"];

// 解析 --model：可重复、可逗号分隔、去空格去重（保持输入顺序）
function parseLoginModels(values) {
  const out = [];
  for (const value of values) {
    for (const part of String(value).split(",")) {
      const id = part.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

// key 掩码：只露出末尾 4 位（更短时全部打码），绝不输出明文。
function maskKey(key) {
  if (typeof key !== "string" || !key) return "(空)";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 5)}***${key.slice(-4)}`;
}

// readline 单行输入（stderr 提示）；prompt 由调用方负责打印时用 hiddenInput。
function askLine(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(String(answer ?? "")));
  });
}

// 静默输入一行：关闭本地回显、逐字符读入并打 *（凭证纪律：任何输出不回显 key 明文）。
// 返回 { text, eof }；EOF（Ctrl+D / Ctrl+C 管道关闭）时 eof 为 true。
function askHidden(prompt) {
  return new Promise((resolve) => {
    stderr(prompt);
    const chars = [];
    let settled = false;
    const finish = (eof) => {
      if (settled) return;
      settled = true;
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve({ text: chars.join(""), eof });
    };
    process.stdin.setEncoding("utf8");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const onData = (chunk) => {
      // raw 模式下逐字符处理
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n" || code === 4) { // 回车 / Ctrl+D 结束
          if (process.stdin.isTTY) process.stdout.write("\n");
          finish(code !== 4 || chars.length > 0 ? false : true);
          return;
        }
        if (code === 3) { // Ctrl+C：中止输入
          if (process.stdin.isTTY) process.stdout.write("\n");
          finish(true);
          return;
        }
        if (code === 127 || code === 8) { // 退格
          chars.pop();
          continue;
        }
        if (ch === "\u0003") continue;
        chars.push(ch);
        if (process.stdin.isTTY) process.stdout.write("*");
      }
    };
    const onEnd = () => finish(true);
    const onErr = () => finish(true);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onErr);
    process.stdin.on("data", onData);
  });
}

// GET {baseURL}/models 嗅探模型列表（OpenAI 形状）；返回详细状态与模型列表
async function probeModelIdsDetailed(baseURL, apiKey) {
  if (typeof baseURL !== "string" || !baseURL.trim()) {
    return { ok: false, error: "baseURL 不能为空" };
  }
  const cleanBase = baseURL.trim().replace(/\/+$/, "");
  const headers = {};
  if (typeof apiKey === "string" && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  // 构造候选 URL 列表：优先原始路径，再加 /v1 回退（或去掉 /v1 回退）
  const candidates = [`${cleanBase}/models`];
  if (/\/v\d+$/i.test(cleanBase)) {
    // baseURL 已含版本号如 /v1：额外尝试去掉版本号
    candidates.push(cleanBase.replace(/\/v\d+$/i, "") + "/models");
  } else {
    // baseURL 不含版本号：额外尝试加 /v1
    candidates.push(`${cleanBase}/v1/models`);
  }

  let lastError = null;
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        // 404/403/405 可能只是路径不对，继续尝试下一个候选
        if ([404, 403, 405].includes(res.status) && candidates.indexOf(url) < candidates.length - 1) {
          lastError = `供应商返回 HTTP ${res.status} (${res.statusText || "请求失败"})`;
          continue;
        }
        return {
          ok: false,
          status: res.status,
          error: `供应商返回 HTTP ${res.status} (${res.statusText || "请求失败"})`,
        };
      }
      const data = await res.json();
      const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : null);
      if (!list) {
        return { ok: false, error: "供应商返回的数据非 OpenAI 兼容格式（缺少 data 列表）" };
      }
      const ids = list
        .map((item) => (item && typeof item === "object" && typeof item.id === "string" ? item.id : (typeof item === "string" ? item : null)))
        .filter((id) => id);
      if (!ids.length) {
        return { ok: false, error: "供应商模型列表为空" };
      }
      return { ok: true, baseURL: cleanBase, models: ids, count: ids.length };
    } catch (err) {
      if (err && err.name === "AbortError") {
        lastError = "嗅探请求超时（8 秒无响应），请检查网络或 baseURL 是否可达";
        // 超时不再重试
        break;
      }
      lastError = `连接失败: ${err && err.message ? err.message : String(err)}`;
      // 网络错误也不再重试（两个 URL 是同一个域名）
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError || "嗅探失败" };
}

// GET {baseURL}/models 自动检测（OpenAI 形状）；任何失败返回 null（由调用方降级）。
async function fetchModelIds(baseURL, apiKey) {
  const res = await probeModelIdsDetailed(baseURL, apiKey);
  return res.ok && Array.isArray(res.models) && res.models.length ? res.models : null;
}

// 用 catalog 匹配模型 id，产出 opencode models[id] 条目：
// 命中 → emitOpencode 最小集（与 `node apifix.mjs <id>` 同形状，不含 cost）；未命中 → {name: id}。
function buildModelEntry(models, rawId) {
  const res = matchModel(models, rawId);
  if (!res.entry) {
    return { id: rawId, entry: { name: rawId }, matched: false, matchedId: null };
  }
  const keyId = res.matchedId || rawId;
  // 沿用用户输入的 id 作 key（与 emit 的默认行为一致），规格对象为 emit payload
  const spec = JSON.parse(emitOpencode(res.entry, { name: keyId, keyId: rawId }))[rawId];
  return { id: rawId, entry: spec, matched: true, matchedId: res.matchedId };
}

// keys-only 检查真实 opencode 配置里 OpenAI 兼容 provider 的实际 npm 值（不打印值本身）。
function probeRealNpm(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const providers = parsed && typeof parsed === "object" ? parsed.provider : null;
    if (!providers || typeof providers !== "object") return null;
    for (const key of Object.keys(providers)) {
      const block = providers[key];
      if (!block || typeof block !== "object") continue;
      const npm = typeof block.npm === "string" ? block.npm : null;
      // OpenAI 兼容包判定（与 @ai-sdk/anthropic、@ai-sdk/google 相区别）
      if (npm && (npm.includes("openai-compatible") || npm === "@ai-sdk/openai")) return npm;
    }
  } catch {
    /* 文件不存在/非法：静默，走默认值 */
  }
  return null;
}

async function cmdLogin(args, models) {
  // -------- 参数解析 --------
  let toolAlias = null; // 第一个位置参数：工具别名（opencode/oc）
  let providerName = null;
  let baseURL = null;
  let protocol = null;
  let apiKeyFlag = null;
  let fileFlag = null;
  let noFetch = false;
  let yes = false;
  let json = false;
  let force = false;
  let noBackup = false;
  const modelFlags = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      stdout(LOGIN_HELP);
      return 0;
    }
    if (arg === "--no-fetch") { noFetch = true; continue; }
    if (arg === "-y" || arg === "--yes") { yes = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--force") { force = true; continue; }
    if (arg === "--no-backup") { noBackup = true; continue; }
    const [key, inline] = splitFlag(arg);
    if (["--base-url", "--protocol", "--api-key", "--file"].includes(key)) {
      const taken = takeValue(args, i, key, inline);
      if (key === "--base-url") baseURL = taken.value;
      else if (key === "--protocol") protocol = taken.value;
      else if (key === "--api-key") apiKeyFlag = taken.value;
      else fileFlag = taken.value;
      i = taken.next;
      continue;
    }
    if (key === "--model") {
      const taken = takeValue(args, i, key, inline);
      modelFlags.push(taken.value);
      i = taken.next;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unrecognized arguments: ${arg}`);
    // 第一个位置参数：工具别名（opencode）；第二个才是 provider 名称
    if (toolAlias === null && (arg === "opencode" || arg === "oc")) { toolAlias = arg; continue; }
    if (toolAlias === null) { toolAlias = arg; continue; }
    if (providerName !== null) throw new UsageError(`unrecognized arguments: ${arg}`);
    providerName = arg;
  }

  if (toolAlias !== null && toolAlias !== "opencode" && toolAlias !== "oc") {
    throw new UsageError(`unrecognized arguments: ${toolAlias}（login 目前仅支持 opencode，用法见 --help）`);
  }

  if (protocol !== null && !LOGIN_PROTOCOLS.includes(protocol)) {
    throw new UsageError(`argument --protocol: invalid choice: ${JSON.stringify(protocol)} (choose from ${LOGIN_PROTOCOLS.join(", ")})`);
  }
  const file = fileFlag !== null ? fileFlag : fixTargetPath("opencode");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // 非交互模式：必要 flag 全给齐才能跳过提示；缺哪个且非 TTY → exit 2
  const missing = [];
  if (baseURL === null) missing.push("--base-url");
  if (apiKeyFlag === null) missing.push("--api-key");
  if (!modelFlags.length) missing.push("--model");
  if (!interactive && missing.length) {
    stderr(`apifix login: error: 非交互模式缺少必要参数: ${missing.join(", ")}`);
    stderr("提示：补齐 flag，或在 TTY 下运行进入交互式向导");
    return 2;
  }

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  const closeRl = () => { if (rl) rl.close(); };
  const allow = publicTokens(models);

  try {
    // -------- 交互式：baseURL --------
    if (baseURL === null) {
      for (;;) {
        const answer = await askLine(rl, "[?] API 地址 baseURL（OpenAI 兼容中转通常以 /v1 结尾）: ");
        const value = answer.trim();
        if (value) { baseURL = value; break; }
        stderr("[!] baseURL 必填，请重新输入");
      }
    }

    // -------- provider 名称：参数 > 交互（默认从主机名派生） --------
    if (providerName === null) {
      let derived = null;
      try {
        derived = deriveProviderName(new URL(baseURL).host);
      } catch { /* URL 解析失败：无默认名 */ }
      if (interactive) {
        const hint = derived ? `（回车 = ${derived}）` : "";
        const answer = await askLine(rl, `[?] provider 名称${hint}: `);
        providerName = answer.trim() || derived;
      } else {
        providerName = derived;
      }
      if (!providerName) {
        stderr("[x] 无法从 baseURL 派生 provider 名称，请手动指定名称或用 --base-url 给出合法 URL");
        return 2;
      }
    }

    // -------- 交互式：API 格式 --------
    if (protocol === null) {
      if (interactive) {
        stderr("[?] API 格式：");
        stderr("  1) OpenAI 兼容（chat_completions/responses）");
        stderr("  2) Anthropic");
        stderr("  3) Gemini");
        const answer = await askLine(rl, "[?] 选择 [1]: ");
        const pick = answer.trim() || "1";
        protocol = { 1: "openai", 2: "anthropic", 3: "gemini" }[pick] || null;
        if (!protocol) { stderr("[x] 无效选择"); return 2; }
      } else {
        protocol = "openai"; // 非交互缺省：OpenAI 兼容（最常见的 OpenAI 兼容中转场景）
      }
    }

    // -------- API key：非交互用 flag；交互走静默输入（任何输出不回显） --------
    let apiKey = apiKeyFlag;
    if (apiKey === null) {
      for (;;) {
        const { text, eof } = await askHidden("[?] API key（输入不回显，回车确认）: ");
        if (eof) { stderr("[!] 输入流已关闭，未获取到 API key"); return 2; }
        if (text.trim()) { apiKey = text.trim(); break; }
        stderr("[!] API key 必填，请重新输入");
      }
    }

    // -------- 模型：flag > 自动检测 > 手动输入 --------
    let selectedIds = [];
    if (modelFlags.length) {
      selectedIds = parseLoginModels(modelFlags);
    } else if (noFetch) {
      // --no-fetch：跳过检测
    } else if (interactive) {
      stderr(`[i] 正在从 ${baseURL}/models 检测模型列表...`);
      const detected = await fetchModelIds(baseURL, apiKey);
      if (detected) {
        stderr(`[i] 检测到 ${detected.length} 个模型：`);
        detected.slice(0, 30).forEach((id, idx) => stderr(`  ${idx + 1}) ${id}`));
        if (detected.length > 30) stderr(`  ...（其余 ${detected.length - 30} 个未列出，可直接输入完整 id）`);
        const answer = await askLine(rl, "[?] 选择模型（序号，逗号分隔多个；或直接输入完整 id；留空跳过）: ");
        const parts = answer.split(",").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          const num = Number.parseInt(part, 10);
          if (String(num) === part && num >= 1 && num <= Math.min(detected.length, 30)) {
            selectedIds.push(detected[num - 1]);
          } else {
            selectedIds.push(part);
          }
        }
      } else {
        stderr("[i] 自动检测失败（非 OpenAI 形状 / 网络不通 / 超时），改为手动输入");
      }
      if (!selectedIds.length) {
        const answer = await askLine(rl, "[?] 模型 id（逗号分隔多个，留空跳过）: ");
        selectedIds = answer.split(",").map((p) => p.trim()).filter(Boolean);
      }
    }

    // -------- 构造 provider 块（不含 apiKey；规格来自 catalog 命中） --------
    const modelEntries = {};
    const unmatched = [];
    for (const id of selectedIds) {
      const built = buildModelEntry(models, id);
      modelEntries[id] = built.entry;
      if (!built.matched) unmatched.push(id);
    }
    for (const id of unmatched) {
      stderr(`[i] ${id}: catalog 未收录，规格留空，可后续 apifix fix 修正`);
    }
    const realNpm = protocol === "openai" ? probeRealNpm(file) : null;
    const providerBlock = buildOpencodeProvider({ name: providerName, baseURL, npm: realNpm, protocol, modelEntries });
    // 凭证注入：key 只写 options.apiKey（纯函数层不碰凭证，写入前在 CLI 层注入）
    providerBlock.options.apiKey = apiKey;

    // -------- 读取目标文件，检查同名 provider --------
    let parsed = null;
    let fileExists = false;
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
      fileExists = true;
      const bom = raw.charCodeAt(0) === 0xfeff;
      parsed = JSON.parse(bom ? raw.slice(1) : raw);
    } catch (err) {
      if (fileExists) {
        stderr(scrub(`[x] 目标文件存在但解析失败 ${file}: ${err && err.code ? err.code : "解析失败"}`, allow));
        return 2;
      }
      parsed = null; // 目标不存在：从零建 {$schema, provider:{}}
    }
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      stderr(`[x] 目标文件不是 JSON 对象: ${file}`);
      return 2;
    }

    const existedProvider = parsed && parsed.provider && typeof parsed.provider === "object" && parsed.provider[providerName];
    if (existedProvider) {
      if (interactive) {
        const answer = await askLine(rl, `[!] 已存在同名 provider「${providerName}」，覆盖？[y/N]: `);
        if (!/^(y|yes)$/i.test(answer.trim())) {
          stderr("[i] 已取消，未写入任何更改");
          return 1;
        }
      } else if (!force) {
        stderr(`[x] 已存在同名 provider「${providerName}」；非交互模式需显式 --force 才能覆盖`);
        return 2;
      }
    }

    // -------- 设为默认模型 --------
    let defaultModel = null;
    if (interactive && selectedIds.length) {
      const answer = await askLine(rl, "[?] 设为 opencode 默认模型（顶层 model 字段）？[y/N]: ");
      if (/^(y|yes)$/i.test(answer.trim())) defaultModel = `${providerName}/${selectedIds[0]}`;
    }

    // -------- 汇总计划（key 只显示掩码） --------
    const summaryLines = [
      `provider 名称 : ${providerName}`,
      `baseURL       : ${baseURL}`,
      `API 格式      : ${protocol} → npm ${providerBlock.npm}`,
      `模型          : ${selectedIds.length ? selectedIds.join(", ") : "（无，仅写空 provider 骨架）"}`,
      `API key       : ${maskKey(apiKey)}`,
      `目标文件      : ${file}${fileExists ? "" : "（新建）"}`,
    ];
    if (json) {
      stdout(scrub(JSON.stringify({
        provider: providerName,
        base_url: baseURL,
        protocol,
        npm: providerBlock.npm,
        models: selectedIds,
        api_key_masked: maskKey(apiKey),
        file,
        default_model: defaultModel,
      }, null, 2), allow));
    } else {
      stderr("── 将写入以下配置 ──");
      for (const line of summaryLines) stderr(`  ${line}`);
    }

    // -------- 确认 --------
    if (!yes) {
      if (interactive) {
        const answer = await askLine(rl, "[?] 确认写入？[y/N]: ");
        if (!/^(y|yes)$/i.test(answer.trim())) {
          stderr("[i] 已取消，未写入任何更改");
          return 1;
        }
      } else {
        stderr("apifix login: error: 写入需要 --yes（非交互模式）");
        return 2;
      }
    }

    // -------- 组装完整配置 --------
    const nextConfig = parsed && typeof parsed === "object" ? parsed : { $schema: "https://opencode.ai/config.json" };
    if (!nextConfig.provider || typeof nextConfig.provider !== "object") nextConfig.provider = {};
    nextConfig.provider[providerName] = providerBlock;
    if (defaultModel) nextConfig.model = defaultModel;

    // -------- 写入：与 fix 同一套管道（备份 → 原子替换） --------
    const style = {
      indent: fileExists ? detectIndent(raw) : 2,
      trailingNewline: fileExists ? raw.endsWith("\n") : true,
      crlf: fileExists ? raw.includes("\r\n") : process.platform === "win32",
      bom: fileExists ? raw.charCodeAt(0) === 0xfeff : false,
    };
    let mode = null;
    try { mode = statSync(file).mode & 0o777; } catch { mode = null; }
    let backup = null;
    if (fileExists && !noBackup) {
      backup = uniqueBackupPath(file, new Date());
      copyFileSync(file, backup);
      stderr(`[i] 备份：${backup}`);
    }
    const text = serializeConfig(nextConfig, style);
    try {
      writeAtomic(file, text, mode);
    } catch (err) {
      warnWindowsFileLock(err, file, backup);
      throw err;
    }

    // -------- 写后复验：对该 provider 跑内部 audit 并打到 stderr --------
    try {
      const verifyConfig = JSON.parse(readFileSync(file, "utf8"));
      const report = auditConfig(models, verifyConfig, "opencode");
      const entry = (report.entries || []).find((e) => e.provider === providerName);
      if (entry && entry.diffs && entry.diffs.length) {
        const diffCount = entry.diffs.filter((d) => d.status === "diff").length;
        if (diffCount > 0) {
          stderr(`[!] 复验：provider「${providerName}」与官网规格仍有 ${diffCount} 处差异（可跑 apifix fix 修正）`);
        } else {
          stderr(`[i] 复验：provider「${providerName}」规格与官网一致`);
        }
      } else if (entry && entry.matchedId) {
        stderr(`[i] 复验：provider「${providerName}」规格与官网一致`);
      } else {
        stderr("[i] 复验：该 provider 无可比对条目（自定义模型或骨架）");
      }
    } catch {
      stderr("[i] 复验失败（配置已写入，可手动跑 apifix audit）");
    }

    if (!json) stderr(`[i] 已写入 ${file}`);
    return 0;
  } finally {
    closeRl();
  }
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
  { path: path.join(os.homedir(), ".pi", "agent", "models-store.json"), tool: "pi", shape: "pi-store", type: "json", store: true },
  { path: path.join(os.homedir(), ".claude", "settings.json"), tool: "claude-code", shape: "claude-code", type: "json" },
  { path: path.join(os.homedir(), ".codex", "config.toml"), tool: "codex", shape: "codex", type: "toml" },
];

// 按文件名/内容猜测 --file 额外路径的格式；猜不出时按内容特征判定。
function detectSourceShape(file, text) {
  const base = path.basename(String(file)).toLowerCase();
  if (base.endsWith(".toml")) return { tool: "codex", shape: "codex", type: "toml" };
  const lower = base;
  if (lower === "models-store.json") return { tool: "pi", shape: "pi-store", type: "json", store: true };
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
      return { tool: "pi", shape: "pi-store", type: "json", store: true };
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
  ~/.pi/agent/models-store.json（模型库：自动生成的模型清单，折叠成一行、未收录不计入配置）
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
    let store = item.store === true;
    if (!shape) {
      const detected = detectSourceShape(item.path, text);
      if (!detected) {
        unreadable.push(item.path);
        continue;
      }
      shape = detected.shape;
      tool = detected.tool;
      type = detected.type;
      store = detected.store === true;
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
      sources.push({ tool, shape, file: item.path, config: env ? { env } : {}, store });
      continue;
    }
    sources.push({ tool, shape, file: item.path, config: stripCredentials(config), store });
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const LOCAL_CONFIG_PLATFORMS = ["opencode", "pi", "codex", "claude"];

function displayHomePath(file) {
  const home = uiHomeDir();
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (file === home) return "~";
  if (file.startsWith(prefix)) return "~/" + file.slice(prefix.length).split(path.sep).join("/");
  return file;
}

function loadCatalogModels() {
  const catalog = JSON.parse(readFileSync(DEFAULT_CATALOG, "utf8"));
  if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    throw new Error("catalog.json 结构非法");
  }
  return catalog.models;
}

function redactCredentialValues(value) {
  if (Array.isArray(value)) return value.map(redactCredentialValues);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (key === "env" || key === "environment" || key === "headers") {
      out[key] = redactCredentialValues(item);
      continue;
    }
    if (isCredentialKey(key) && !(typeof item === "number" && Number.isFinite(item))) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactCredentialValues(item);
  }
  return out;
}

function redactLocalPreview(text, format, models) {
  const allow = publicTokens(models);
  const raw = String(text == null ? "" : text);
  if (format === "codex") {
    const out = raw.replace(
      /^(\s*(?:experimental_bearer_token|env_key)\s*=\s*)(["']).*?\2/gm,
      "$1$2[REDACTED]$2",
    );
    return scrub(out, allow);
  }
  try {
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const redacted = redactCredentialValues(JSON.parse(body));
    let out = JSON.stringify(redacted, null, 2);
    if (body.endsWith("\n")) out += "\n";
    return scrub(out, allow);
  } catch {
    return scrub(raw, allow);
  }
}

function listProviders(format, parsed) {
  if (format === "opencode" && isPlainObject(parsed) && isPlainObject(parsed.provider)) {
    return Object.keys(parsed.provider);
  }
  if (format === "pi" && isPlainObject(parsed) && isPlainObject(parsed.providers)) {
    return Object.keys(parsed.providers);
  }
  if (format === "codex" && isPlainObject(parsed) && isPlainObject(parsed.providers)) {
    return Object.keys(parsed.providers);
  }
  if (format === "claude") return ["env"];
  return [];
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function providerMetaFromBlock(platform, name, block) {
  if (!isPlainObject(block)) return { name, baseURL: null, protocol: null };
  if (platform === "opencode") {
    const options = isPlainObject(block.options) ? block.options : {};
    return {
      name,
      baseURL: typeof options.baseURL === "string" ? options.baseURL : null,
      protocol: typeof block.npm === "string" ? block.npm : null,
    };
  }
  if (platform === "pi") {
    return {
      name,
      baseURL: typeof block.baseURL === "string" ? block.baseURL : null,
      protocol: typeof block.api === "string" ? block.api : null,
    };
  }
  if (platform === "codex") {
    return {
      name,
      baseURL: typeof block.base_url === "string" ? block.base_url : null,
      protocol: typeof block.wire_api === "string" ? block.wire_api : null,
    };
  }
  if (platform === "claude") {
    const env = isPlainObject(block.env) ? block.env : block;
    return {
      name,
      baseURL: typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null,
      protocol: "anthropic_messages",
    };
  }
  return { name, baseURL: null, protocol: null };
}

function buildProviderBlocks(platform, parsed, entries) {
  const grouped = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = platform === "claude"
      ? "env"
      : (entry && entry.provider ? String(entry.provider) : "(unknown)");
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(entry);
  }
  const names = listProviders(platform, parsed);
  if (platform !== "claude") {
    for (const name of grouped.keys()) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const blocks = [];
  for (const name of names) {
    let rawBlock = null;
    if (platform === "opencode") rawBlock = isPlainObject(parsed.provider) ? parsed.provider[name] : null;
    else if (platform === "pi") rawBlock = isPlainObject(parsed.providers) ? parsed.providers[name] : null;
    else if (platform === "codex") rawBlock = isPlainObject(parsed.providers) ? parsed.providers[name] : null;
    else if (platform === "claude") rawBlock = isPlainObject(parsed.env) ? { env: parsed.env } : null;
    const models = grouped.get(name) || [];
    const modelIds = models.map((item) => item.input).filter(Boolean);
    if (!modelIds.length) {
      if (platform === "opencode" && isPlainObject(rawBlock) && isPlainObject(rawBlock.models)) {
        modelIds.push(...Object.keys(rawBlock.models));
      } else if (platform === "pi" && isPlainObject(rawBlock) && Array.isArray(rawBlock.models)) {
        for (const item of rawBlock.models) {
          if (item && typeof item.id === "string" && item.id) modelIds.push(item.id);
        }
      }
    }
    const meta = providerMetaFromBlock(platform, name, rawBlock);
    const previewSource = platform === "claude" && isPlainObject(rawBlock) ? rawBlock.env : rawBlock;
    blocks.push({
      name,
      ...meta,
      modelCount: modelIds.length,
      empty: modelIds.length === 0,
      models,
      preview: previewSource == null ? "{}" : prettyJson(redactCredentialValues(previewSource)),
    });
  }
  return blocks;
}

function restoreCredentials(next, original) {
  if (Array.isArray(next)) {
    const origList = Array.isArray(original) ? original : [];
    return next.map((item, i) => restoreCredentials(item, origList[i]));
  }
  if (!isPlainObject(next)) return next;
  const orig = isPlainObject(original) ? original : {};
  const out = {};
  for (const key of Object.keys(next)) {
    const val = next[key];
    if (key === "env" || key === "environment" || key === "headers") {
      out[key] = restoreCredentials(val, orig[key]);
      continue;
    }
    if (isCredentialKey(key) && !(typeof val === "number" && Number.isFinite(val))) {
      if (val === "[REDACTED]" || val === "" || val == null) {
        if (Object.prototype.hasOwnProperty.call(orig, key)) out[key] = orig[key];
      } else {
        out[key] = val;
      }
      continue;
    }
    if (isPlainObject(val) || Array.isArray(val)) out[key] = restoreCredentials(val, orig[key]);
    else out[key] = val;
  }
  for (const key of Object.keys(orig)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    if (key === "env" || key === "environment" || key === "headers") continue;
    if (isCredentialKey(key) && !(typeof orig[key] === "number" && Number.isFinite(orig[key]))) {
      out[key] = orig[key];
    }
  }
  return out;
}

function parseProviderFragment(raw) {
  if (isPlainObject(raw)) return { ok: true, value: raw };
  if (typeof raw !== "string") return { ok: false, error: "供应商片段必须是 JSON 对象" };
  const text = raw.trim();
  if (!text) return { ok: false, error: "供应商片段不能为空" };
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { ok: false, error: "供应商片段必须是 JSON 对象" };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "供应商片段不是合法 JSON" };
  }
}

function emptyLocalSummary() {
  return { total: 0, unmatched: 0, with_diffs: 0, clean: 0, diff_items: 0, exact: 0, alias: 0, legacy: 0, normalized: 0 };
}

function readLocalConfig(platform) {
  if (!LOCAL_CONFIG_PLATFORMS.includes(platform)) {
    return { ok: false, status: 400, error: "未知平台（支持 opencode / pi / codex / claude）" };
  }
  const file = uiConfigPath(platform);
  const displayPath = displayHomePath(file);
  let models;
  try {
    models = loadCatalogModels();
  } catch {
    return { ok: false, status: 500, error: "读取 catalog 失败" };
  }
  if (!existsSync(file)) {
    return {
      ok: true,
      exists: false,
      platform,
      file: displayPath,
      preview: "",
      summary: emptyLocalSummary(),
      entries: [],
      providers: [],
      providerBlocks: [],
      activeModel: null,
      activeProvider: null,
    };
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, status: 500, error: `无法读取文件: ${err && err.code ? err.code : "读取失败"}` };
  }
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    if (platform === "codex") {
      const parsed = parseCodexToml(body);
      const report = auditConfig(models, parsed, "codex");
      return {
        ok: true,
        exists: true,
        platform,
        file: displayPath,
        preview: redactLocalPreview(body, "codex", models),
        summary: report.summary,
        entries: report.entries,
        providers: listProviders("codex", parsed),
        providerBlocks: buildProviderBlocks("codex", parsed, report.entries),
        activeModel: parsed.model || null,
        activeProvider: parsed.model_provider || null,
      };
    }
    const parsed = JSON.parse(body);
    const report = auditConfig(models, parsed, platform);
    return {
      ok: true,
      exists: true,
      platform,
      file: displayPath,
      preview: redactLocalPreview(body, platform, models),
      summary: report.summary,
      entries: report.entries,
      providers: listProviders(platform, parsed),
      providerBlocks: buildProviderBlocks(platform, parsed, report.entries),
      activeModel: platform === "claude" && isPlainObject(parsed.env) ? (parsed.env.ANTHROPIC_MODEL || null) : (parsed.model || null),
      activeProvider: null,
    };
  } catch {
    return { ok: false, status: 400, error: "配置文件解析失败（内容未回显）" };
  }
}

function parseInjectModels(value) {
  if (Array.isArray(value)) {
    return value.map((id) => String(id).trim()).filter(Boolean).filter((id, i, arr) => arr.indexOf(id) === i);
  }
  if (typeof value === "string") {
    return value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean).filter((id, i, arr) => arr.indexOf(id) === i);
  }
  return [];
}

function opencodeBuildArgs(protocol) {
  if (protocol === "openai-native") return { protocol: "openai", npm: "@ai-sdk/openai" };
  if (protocol === "anthropic" || protocol === "gemini" || protocol === "openai") {
    return { protocol, npm: null };
  }
  return { protocol: "openai", npm: null };
}

function buildPiModelEntry(models, rawId) {
  const res = matchModel(models, rawId);
  if (!res.entry) {
    return {
      id: rawId,
      entry: { id: rawId, name: rawId, reasoning: false, input: ["text"], contextWindow: null, maxTokens: null },
      matched: false,
    };
  }
  const spec = JSON.parse(emitPi(res.entry, { name: rawId, id: rawId }));
  return { id: rawId, entry: spec, matched: true };
}

function claudeInjectSpecs(models, rawId) {
  const res = matchModel(models, rawId);
  if (!res.entry) return { effort: null, budget: null, matched: false };
  const reasoning = res.entry.reasoning && typeof res.entry.reasoning === "object" ? res.entry.reasoning : {};
  let effort = reasoning.default_effort || null;
  if (!effort && Array.isArray(reasoning.effort_values) && reasoning.effort_values.length) {
    effort = reasoning.effort_values[0];
  }
  let budget = null;
  if (reasoning.thinking_budget && typeof reasoning.thinking_budget === "object") {
    budget = reasoning.thinking_budget.min || null;
  }
  return { effort, budget, matched: true };
}

function tomlQuoted(value) {
  return JSON.stringify(String(value == null ? "" : value));
}

function upsertTomlTopLevel(text, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = `${key} = ${tomlQuoted(value)}`;
  const parts = String(text).split(/(?=^\s*\[)/m);
  let head = parts[0] || "";
  const rest = parts.slice(1).join("");
  const re = new RegExp(`^(\\s*${escaped}\\s*=\\s*).*$`, "m");
  if (re.test(head)) head = head.replace(re, `$1${tomlQuoted(value)}`);
  else head = (head.replace(/\s*$/, "") + (head.trim() ? "\n" : "") + line + "\n");
  if (head && !head.endsWith("\n") && rest) head += "\n";
  return head + rest;
}

function findTomlSectionRange(text, sectionName) {
  const lines = String(text).split(/\r?\n/);
  const nl = String(text).includes("\r\n") ? "\r\n" : "\n";
  const headerRe = new RegExp(`^\\s*\\[model_providers\\.(?:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\"${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\")\\]\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  return { lines, start, end, nl };
}

function upsertTomlSectionKey(text, sectionName, key, value) {
  const found = findTomlSectionRange(text, sectionName);
  if (!found) return text;
  const { lines, start, end, nl } = found;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\s*${escaped}\\s*=\\s*).*$`);
  let replaced = false;
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = lines[i].replace(re, `$1${tomlQuoted(value)}`);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, `${key} = ${tomlQuoted(value)}`);
  }
  return lines.join(nl);
}

function appendCodexProviderSection(text, { providerName, baseURL, protocol, apiKey }) {
  const nl = String(text).includes("\r\n") ? "\r\n" : "\n";
  const key = /^[A-Za-z0-9_-]+$/.test(providerName) ? providerName : tomlQuoted(providerName);
  const lines = [
    "",
    `[model_providers.${key}]`,
    `name = ${tomlQuoted(providerName)}`,
    `base_url = ${tomlQuoted(baseURL)}`,
    `wire_api = ${tomlQuoted(protocol || "chat")}`,
  ];
  if (apiKey) lines.push(`experimental_bearer_token = ${tomlQuoted(apiKey)}`);
  const body = String(text).replace(/\s*$/, "");
  return (body ? body + nl : "") + lines.join(nl) + nl;
}

function fileWriteStyle(raw, exists) {
  if (!exists) {
    return {
      indent: 2,
      trailingNewline: true,
      crlf: process.platform === "win32",
      bom: false,
    };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  return {
    indent: detectIndent(body),
    trailingNewline: body.endsWith("\n"),
    crlf: body.includes("\r\n"),
    bom,
  };
}

const CLAUDE_ENV_MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

function deleteLocalConfigModel(body) {
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!LOCAL_CONFIG_PLATFORMS.includes(platform)) {
    return { ok: false, status: 400, error: "未知平台（支持 opencode / pi / codex / claude）" };
  }
  const modelId = typeof body.model === "string" ? body.model.trim() : "";
  const providerName = typeof body.provider === "string" ? body.provider.trim() : "";
  const noBackup = body.noBackup === true;
  if (!modelId) return { ok: false, status: 400, error: "model 不能为空" };

  if (platform === "codex") {
    return { ok: false, status: 400, error: "Codex 只有当前激活模型，不能从列表删除。请先写入另一个模型作为激活项。" };
  }

  const file = uiConfigPath(platform);
  if (!existsSync(file)) {
    return { ok: false, status: 404, error: "配置文件不存在" };
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, status: 500, error: `无法读取文件: ${err && err.code ? err.code : "读取失败"}` };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const textBody = bom ? raw.slice(1) : raw;
  const style = fileWriteStyle(raw, true);
  let nextText = "";
  let removedFrom = null;

  try {
    const parsed = JSON.parse(textBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
    }

    if (platform === "opencode") {
      if (!isPlainObject(parsed.provider)) {
        return { ok: false, status: 404, error: "未找到该模型" };
      }
      const hits = [];
      for (const name of Object.keys(parsed.provider)) {
        if (providerName && name !== providerName) continue;
        const block = parsed.provider[name];
        if (isPlainObject(block) && isPlainObject(block.models) && Object.prototype.hasOwnProperty.call(block.models, modelId)) {
          hits.push(name);
        }
      }
      if (!hits.length) return { ok: false, status: 404, error: "未找到该模型" };
      if (hits.length > 1) return { ok: false, status: 400, error: "多个供应商含有同名模型，请指定供应商后再删除" };
      removedFrom = hits[0];
      delete parsed.provider[removedFrom].models[modelId];
      if (typeof parsed.model === "string") {
        const def = parsed.model.trim();
        if (def === `${removedFrom}/${modelId}` || def === modelId) delete parsed.model;
      }
    } else if (platform === "pi") {
      if (!isPlainObject(parsed.providers)) {
        return { ok: false, status: 404, error: "未找到该模型" };
      }
      const hits = [];
      for (const name of Object.keys(parsed.providers)) {
        if (providerName && name !== providerName) continue;
        const block = parsed.providers[name];
        if (isPlainObject(block) && Array.isArray(block.models) && block.models.some((item) => item && item.id === modelId)) {
          hits.push(name);
        }
      }
      if (!hits.length) return { ok: false, status: 404, error: "未找到该模型" };
      if (hits.length > 1) return { ok: false, status: 400, error: "多个供应商含有同名模型，请指定供应商后再删除" };
      removedFrom = hits[0];
      const block = parsed.providers[removedFrom];
      block.models = block.models.filter((item) => !(item && item.id === modelId));
    } else if (platform === "claude") {
      if (!isPlainObject(parsed.env)) {
        return { ok: false, status: 404, error: "未找到该模型" };
      }
      const env = parsed.env;
      let keys = CLAUDE_ENV_MODEL_KEYS.filter((key) => env[key] === modelId);
      if (providerName) {
        if (!CLAUDE_ENV_MODEL_KEYS.includes(providerName) || env[providerName] !== modelId) {
          return { ok: false, status: 404, error: "未找到该模型" };
        }
        keys = [providerName];
      }
      if (!keys.length) return { ok: false, status: 404, error: "未找到该模型" };
      if (keys.length > 1) return { ok: false, status: 400, error: "多个角色使用该模型，请指定 env 键后再删除" };
      removedFrom = keys[0];
      delete env[removedFrom];
    }
    nextText = serializeConfig(parsed, style);
  } catch {
    return { ok: false, status: 400, error: "配置文件解析失败（内容未回显）" };
  }

  let backup = null;
  try {
    backup = writeLocalFile(file, nextText, { exists: true, noBackup });
  } catch (err) {
    return { ok: false, status: 500, error: `写入失败: ${err && err.code ? err.code : "未知错误"}` };
  }

  const after = readLocalConfig(platform);
  return {
    ok: true,
    platform,
    file: displayHomePath(file),
    deleted: modelId,
    provider: removedFrom,
    backup: backup ? displayHomePath(backup) : null,
    local: after.ok ? after : null,
  };
}

function deleteLocalProvider(body) {
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!LOCAL_CONFIG_PLATFORMS.includes(platform)) {
    return { ok: false, status: 400, error: "未知平台（支持 opencode / pi / codex / claude）" };
  }
  const providerName = typeof body.provider === "string" ? body.provider.trim() : "";
  const noBackup = body.noBackup === true;
  if (!providerName) return { ok: false, status: 400, error: "provider 不能为空" };
  if (platform === "claude") {
    return { ok: false, status: 400, error: "Claude Code 没有可删除的供应商节点；请删除单个模型键" };
  }

  const file = uiConfigPath(platform);
  if (!existsSync(file)) return { ok: false, status: 404, error: "配置文件不存在" };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, status: 500, error: `无法读取文件: ${err && err.code ? err.code : "读取失败"}` };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const textBody = bom ? raw.slice(1) : raw;
  const style = fileWriteStyle(raw, true);
  let nextText = "";

  try {
    if (platform === "codex") {
      const parsed = parseCodexToml(textBody);
      if (!isPlainObject(parsed.providers) || !Object.prototype.hasOwnProperty.call(parsed.providers, providerName)) {
        return { ok: false, status: 404, error: "未找到该供应商" };
      }
      const found = findTomlSectionRange(textBody, providerName);
      if (!found) return { ok: false, status: 404, error: "未找到该供应商" };
      const { lines, start, end, nl } = found;
      lines.splice(start, end - start);
      while (start < lines.length && lines[start].trim() === "") lines.splice(start, 1);
      if (start > 0 && lines[start - 1].trim() === "" && (start >= lines.length || lines[start].trim() === "")) {
        lines.splice(start - 1, 1);
      }
      let next = lines.join(nl);
      if (parsed.model_provider === providerName) {
        next = upsertTomlTopLevel(next, "model_provider", "");
      }
      if (style.bom) next = "\ufeff" + next;
      nextText = next;
    } else {
      const parsed = JSON.parse(textBody);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
      }
      if (platform === "opencode") {
        if (!isPlainObject(parsed.provider) || !Object.prototype.hasOwnProperty.call(parsed.provider, providerName)) {
          return { ok: false, status: 404, error: "未找到该供应商" };
        }
        delete parsed.provider[providerName];
        if (typeof parsed.model === "string" && parsed.model.startsWith(providerName + "/")) delete parsed.model;
      } else if (platform === "pi") {
        if (!isPlainObject(parsed.providers) || !Object.prototype.hasOwnProperty.call(parsed.providers, providerName)) {
          return { ok: false, status: 404, error: "未找到该供应商" };
        }
        delete parsed.providers[providerName];
      }
      nextText = serializeConfig(parsed, style);
    }
  } catch {
    return { ok: false, status: 400, error: "配置文件解析失败（内容未回显）" };
  }

  let backup = null;
  try {
    backup = writeLocalFile(file, nextText, { exists: true, noBackup });
  } catch (err) {
    return { ok: false, status: 500, error: `写入失败: ${err && err.code ? err.code : "未知错误"}` };
  }
  const after = readLocalConfig(platform);
  return {
    ok: true,
    platform,
    file: displayHomePath(file),
    deletedProvider: providerName,
    backup: backup ? displayHomePath(backup) : null,
    local: after.ok ? after : null,
  };
}

function updateLocalProvider(body) {
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!LOCAL_CONFIG_PLATFORMS.includes(platform)) {
    return { ok: false, status: 400, error: "未知平台（支持 opencode / pi / codex / claude）" };
  }
  const providerName = typeof body.provider === "string" ? body.provider.trim() : "";
  const noBackup = body.noBackup === true;
  if (!providerName) return { ok: false, status: 400, error: "provider 不能为空" };
  if (platform === "codex") {
    return { ok: false, status: 400, error: "Codex 的 TOML 供应商段请用写入功能改当前模型，不支持整段 JSON 编辑" };
  }

  const parsedFrag = parseProviderFragment(body.fragment);
  if (!parsedFrag.ok) return { ok: false, status: 400, error: parsedFrag.error };

  const file = uiConfigPath(platform);
  if (!existsSync(file)) return { ok: false, status: 404, error: "配置文件不存在" };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, status: 500, error: `无法读取文件: ${err && err.code ? err.code : "读取失败"}` };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const textBody = bom ? raw.slice(1) : raw;
  const style = fileWriteStyle(raw, true);
  let nextText = "";

  try {
    const parsed = JSON.parse(textBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
    }
    if (platform === "opencode") {
      if (!isPlainObject(parsed.provider) || !Object.prototype.hasOwnProperty.call(parsed.provider, providerName)) {
        return { ok: false, status: 404, error: "未找到该供应商" };
      }
      parsed.provider[providerName] = restoreCredentials(parsedFrag.value, parsed.provider[providerName]);
    } else if (platform === "pi") {
      if (!isPlainObject(parsed.providers) || !Object.prototype.hasOwnProperty.call(parsed.providers, providerName)) {
        return { ok: false, status: 404, error: "未找到该供应商" };
      }
      parsed.providers[providerName] = restoreCredentials(parsedFrag.value, parsed.providers[providerName]);
    } else if (platform === "claude") {
      if (providerName !== "env") return { ok: false, status: 400, error: "Claude Code 只能编辑 env 片段" };
      if (!isPlainObject(parsed.env)) parsed.env = {};
      const incoming = isPlainObject(parsedFrag.value.env) ? parsedFrag.value.env : parsedFrag.value;
      parsed.env = restoreCredentials(incoming, parsed.env);
    }
    nextText = serializeConfig(parsed, style);
  } catch {
    return { ok: false, status: 400, error: "配置文件解析失败（内容未回显）" };
  }

  let backup = null;
  try {
    backup = writeLocalFile(file, nextText, { exists: true, noBackup });
  } catch (err) {
    return { ok: false, status: 500, error: `写入失败: ${err && err.code ? err.code : "未知错误"}` };
  }
  const after = readLocalConfig(platform);
  return {
    ok: true,
    platform,
    file: displayHomePath(file),
    provider: providerName,
    backup: backup ? displayHomePath(backup) : null,
    local: after.ok ? after : null,
  };
}

function writeLocalFile(file, text, { exists, noBackup }) {
  mkdirSync(path.dirname(file), { recursive: true });
  let mode = null;
  try { mode = statSync(file).mode & 0o777; } catch { mode = null; }
  let backup = null;
  if (exists && !noBackup) {
    backup = uniqueBackupPath(file, new Date());
    copyFileSync(file, backup);
  }
  try {
    writeAtomic(file, text, mode);
  } catch (err) {
    warnWindowsFileLock(err, file, backup);
    throw err;
  }
  return backup;
}

function injectLocalConfig(body) {
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!LOCAL_CONFIG_PLATFORMS.includes(platform)) {
    return { ok: false, status: 400, error: "未知平台（支持 opencode / pi / codex / claude）" };
  }
  const modelIds = parseInjectModels(body.models);
  if (!modelIds.length) {
    return { ok: false, status: 400, error: "models 不能为空" };
  }
  const baseURL = typeof body.baseURL === "string" ? body.baseURL.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const providerName = (typeof body.providerName === "string" ? body.providerName.trim() : "")
    || (baseURL ? (deriveProviderName((() => { try { return new URL(baseURL).host; } catch { return ""; } })()) || "") : "")
    || "my-provider";
  const protocol = typeof body.protocol === "string" ? body.protocol.trim() : "";
  const setDefault = body.setDefault === true;
  const noBackup = body.noBackup === true;

  if ((platform === "opencode" || platform === "pi" || platform === "codex") && !baseURL && !existsSync(uiConfigPath(platform))) {
    return { ok: false, status: 400, error: "新建配置需要填写 API 地址 (Base URL)" };
  }
  if (baseURL && !/^https?:\/\//i.test(baseURL)) {
    return { ok: false, status: 400, error: "baseURL 必须以 http:// 或 https:// 开头" };
  }

  let models;
  try {
    models = loadCatalogModels();
  } catch {
    return { ok: false, status: 500, error: "读取 catalog 失败" };
  }

  const file = uiConfigPath(platform);
  const exists = existsSync(file);
  let raw = "";
  if (exists) {
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, status: 500, error: `无法读取文件: ${err && err.code ? err.code : "读取失败"}` };
    }
  }
  const bom = exists && raw.charCodeAt(0) === 0xfeff;
  const textBody = bom ? raw.slice(1) : raw;
  const unmatched = [];
  const added = [];
  const updated = [];
  let nextText = "";
  const style = fileWriteStyle(raw, exists);

  try {
    if (platform === "opencode") {
      let parsed = null;
      if (exists) {
        parsed = JSON.parse(textBody);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
        }
      } else {
        parsed = { $schema: "https://opencode.ai/config.json" };
      }
      if (!parsed.provider || typeof parsed.provider !== "object") parsed.provider = {};
      const modelEntries = {};
      for (const id of modelIds) {
        const built = buildModelEntry(models, id);
        modelEntries[id] = built.entry;
        if (!built.matched) unmatched.push(id);
      }
      const proto = opencodeBuildArgs(protocol || "openai");
      const realNpm = proto.protocol === "openai" ? (proto.npm || probeRealNpm(file)) : proto.npm;
      const block = buildOpencodeProvider({
        name: providerName,
        baseURL: baseURL || "https://api.openai.com/v1",
        npm: realNpm,
        protocol: proto.protocol,
        modelEntries,
      });
      const existing = parsed.provider[providerName];
      if (existing && typeof existing === "object") {
        const merged = { ...existing };
        if (block.npm) merged.npm = block.npm;
        merged.options = isPlainObject(existing.options) ? { ...existing.options } : {};
        if (baseURL) merged.options.baseURL = baseURL;
        if (apiKey) merged.options.apiKey = apiKey;
        merged.models = isPlainObject(existing.models) ? { ...existing.models } : {};
        for (const id of Object.keys(modelEntries)) {
          if (Object.prototype.hasOwnProperty.call(merged.models, id)) updated.push(id);
          else added.push(id);
          merged.models[id] = modelEntries[id];
        }
        parsed.provider[providerName] = merged;
      } else {
        if (!baseURL) {
          return { ok: false, status: 400, error: "新建供应商需要填写 API 地址 (Base URL)" };
        }
        if (apiKey) block.options.apiKey = apiKey;
        parsed.provider[providerName] = block;
        added.push(...modelIds);
      }
      if (setDefault && modelIds[0]) parsed.model = `${providerName}/${modelIds[0]}`;
      nextText = serializeConfig(parsed, style);
    } else if (platform === "pi") {
      let parsed = null;
      if (exists) {
        parsed = JSON.parse(textBody);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
        }
      } else {
        parsed = {};
      }
      if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
      const existing = parsed.providers[providerName];
      const nextModels = [];
      const seen = new Set();
      if (existing && typeof existing === "object" && Array.isArray(existing.models)) {
        for (const item of existing.models) {
          if (item && typeof item === "object" && typeof item.id === "string" && item.id) {
            nextModels.push(item);
            seen.add(item.id);
          }
        }
      }
      for (const id of modelIds) {
        const built = buildPiModelEntry(models, id);
        if (!built.matched) unmatched.push(id);
        if (seen.has(id)) {
          const idx = nextModels.findIndex((m) => m && m.id === id);
          if (idx >= 0) nextModels[idx] = built.entry;
          updated.push(id);
        } else {
          nextModels.push(built.entry);
          added.push(id);
        }
      }
      if (!(existing && typeof existing === "object") && !baseURL) {
        return { ok: false, status: 400, error: "新建供应商需要填写 API 地址 (Base URL)" };
      }
      const block = existing && typeof existing === "object" ? { ...existing } : {};
      if (baseURL) block.baseURL = baseURL;
      if (apiKey) block.apiKey = apiKey;
      if (protocol) block.api = protocol;
      else if (!block.api) block.api = "openai-completions";
      block.models = nextModels;
      parsed.providers[providerName] = block;
      nextText = serializeConfig(parsed, style);
    } else if (platform === "claude") {
      let parsed = null;
      if (exists) {
        parsed = JSON.parse(textBody);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, status: 400, error: "目标文件不是 JSON 对象" };
        }
      } else {
        parsed = {};
      }
      if (!parsed.env || typeof parsed.env !== "object") parsed.env = {};
      const main = modelIds[0];
      const specs = claudeInjectSpecs(models, main);
      if (!specs.matched) unmatched.push(main);
      for (const extra of modelIds.slice(1)) {
        const extraSpec = claudeInjectSpecs(models, extra);
        if (!extraSpec.matched) unmatched.push(extra);
      }
      if (baseURL) parsed.env.ANTHROPIC_BASE_URL = baseURL;
      if (apiKey) parsed.env.ANTHROPIC_AUTH_TOKEN = apiKey;
      parsed.env.ANTHROPIC_MODEL = main;
      if (specs.effort) parsed.env.CLAUDE_CODE_EFFORT_LEVEL = String(specs.effort);
      if (specs.budget != null) parsed.env.MAX_THINKING_TOKENS = String(specs.budget);
      added.push(main);
      nextText = serializeConfig(parsed, style);
    } else if (platform === "codex") {
      const main = modelIds[0];
      const effortRes = matchModel(models, main);
      let effort = null;
      if (effortRes.entry && effortRes.entry.reasoning) {
        effort = effortRes.entry.reasoning.default_effort
          || (Array.isArray(effortRes.entry.reasoning.effort_values) && effortRes.entry.reasoning.effort_values[0])
          || null;
      }
      if (!effortRes.entry) unmatched.push(main);
      for (const extra of modelIds.slice(1)) {
        if (!matchModel(models, extra).entry) unmatched.push(extra);
      }
      const wire = protocol || "chat";
      if (!exists || !textBody.trim()) {
        if (!baseURL) {
          return { ok: false, status: 400, error: "新建配置需要填写 API 地址 (Base URL)" };
        }
        const url = baseURL;
        const lines = [
          `model = ${tomlQuoted(main)}`,
          `model_provider = ${tomlQuoted(providerName)}`,
        ];
        if (effort) lines.push(`model_reasoning_effort = ${tomlQuoted(effort)}`);
        if (modelIds.length > 1) {
          lines.push("");
          lines.push("# 备选模型（将上方 model 替换为下列之一即可）：");
          for (const alt of modelIds.slice(1)) lines.push(`# model = ${tomlQuoted(alt)}`);
        }
        lines.push("");
        const key = /^[A-Za-z0-9_-]+$/.test(providerName) ? providerName : tomlQuoted(providerName);
        lines.push(`[model_providers.${key}]`);
        lines.push(`name = ${tomlQuoted(providerName)}`);
        lines.push(`base_url = ${tomlQuoted(url)}`);
        lines.push(`wire_api = ${tomlQuoted(wire)}`);
        if (apiKey) lines.push(`experimental_bearer_token = ${tomlQuoted(apiKey)}`);
        nextText = lines.join(style.crlf ? "\r\n" : "\n") + (style.trailingNewline ? (style.crlf ? "\r\n" : "\n") : "");
        if (style.bom) nextText = "\ufeff" + nextText;
      } else {
        let next = textBody;
        next = upsertTomlTopLevel(next, "model", main);
        next = upsertTomlTopLevel(next, "model_provider", providerName);
        if (effort) next = upsertTomlTopLevel(next, "model_reasoning_effort", effort);
        const parsed = parseCodexToml(next);
        if (!parsed.providers || !parsed.providers[providerName]) {
          if (!baseURL) {
            return { ok: false, status: 400, error: "新建供应商需要填写 API 地址 (Base URL)" };
          }
          next = appendCodexProviderSection(next, { providerName, baseURL, protocol: wire, apiKey });
        } else {
          if (baseURL) next = upsertTomlSectionKey(next, providerName, "base_url", baseURL);
          if (protocol) next = upsertTomlSectionKey(next, providerName, "wire_api", wire);
          if (apiKey) next = upsertTomlSectionKey(next, providerName, "experimental_bearer_token", apiKey);
        }
        if (style.bom) next = "\ufeff" + next;
        nextText = next;
      }
      added.push(main);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : "写入准备失败";
    if (/JSON/.test(msg) || /parse/i.test(msg)) {
      return { ok: false, status: 400, error: "配置文件解析失败（内容未回显）" };
    }
    return { ok: false, status: 500, error: "写入准备失败" };
  }

  let backup = null;
  try {
    backup = writeLocalFile(file, nextText, { exists, noBackup });
  } catch (err) {
    return { ok: false, status: 500, error: `写入失败: ${err && err.code ? err.code : "未知错误"}` };
  }

  const after = readLocalConfig(platform);
  const displayPath = displayHomePath(file);
  return {
    ok: true,
    platform,
    file: displayPath,
    created: !exists,
    backup: backup ? displayHomePath(backup) : null,
    provider: providerName,
    added,
    updated,
    unmatched,
    setDefault: setDefault && platform === "opencode" ? `${providerName}/${modelIds[0]}` : (platform === "codex" || platform === "claude" ? modelIds[0] : null),
    local: after.ok ? after : null,
  };
}

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        req.destroy(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createUiServer() {
  return createServer(async (req, res) => {
    // 跨域预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    const urlPath = parsedUrl.pathname;

    // 模型嗅探 API 接口：支持 POST 或 GET
    if (urlPath === "/api/models" || urlPath === "/api/sniff") {
      let baseURL = "";
      let apiKey = "";

      if (req.method === "POST") {
        try {
          const bodyText = await readRequestBody(req);
          if (bodyText.trim()) {
            const parsed = JSON.parse(bodyText);
            if (parsed && typeof parsed === "object") {
              if (typeof parsed.baseURL === "string") baseURL = parsed.baseURL;
              if (typeof parsed.apiKey === "string") apiKey = parsed.apiKey;
            }
          }
        } catch {
          sendJson(res, 400, { ok: false, error: "请求格式错误，需提供合法 JSON" });
          return;
        }
      } else if (req.method === "GET") {
        baseURL = parsedUrl.searchParams.get("baseURL") || "";
        apiKey = parsedUrl.searchParams.get("apiKey") || "";
      } else {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, POST, OPTIONS" });
        res.end("405 Method Not Allowed\n");
        return;
      }

      if (!apiKey && req.headers.authorization) {
        const auth = req.headers.authorization.trim();
        if (auth.toLowerCase().startsWith("bearer ")) apiKey = auth.slice(7).trim();
      }

      if (!baseURL.trim()) {
        sendJson(res, 400, { ok: false, error: "baseURL 不能为空" });
        return;
      }
      if (!/^https?:\/\//i.test(baseURL.trim())) {
        sendJson(res, 400, { ok: false, error: "baseURL 必须以 http:// 或 https:// 开头" });
        return;
      }

      const result = await probeModelIdsDetailed(baseURL.trim(), apiKey);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (urlPath === "/api/local-config") {
      if (req.method === "GET") {
        const platform = parsedUrl.searchParams.get("platform") || "opencode";
        const result = readLocalConfig(platform);
        sendJson(res, result.status || (result.ok ? 200 : 400), result);
        return;
      }
      if (req.method === "POST") {
        let payload = null;
        try {
          const bodyText = await readRequestBody(req);
          payload = bodyText.trim() ? JSON.parse(bodyText) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "请求格式错误，需提供合法 JSON" });
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          sendJson(res, 400, { ok: false, error: "请求格式错误，需提供合法 JSON" });
          return;
        }
        const action = typeof payload.action === "string" && payload.action.trim()
          ? payload.action.trim()
          : "inject";
        if (action !== "inject" && action !== "delete" && action !== "delete-provider" && action !== "update-provider") {
          sendJson(res, 400, { ok: false, error: "未知 action（支持 inject / delete / delete-provider / update-provider）" });
          return;
        }
        const result = action === "delete" ? deleteLocalConfigModel(payload)
          : action === "delete-provider" ? deleteLocalProvider(payload)
            : action === "update-provider" ? updateLocalProvider(payload)
              : injectLocalConfig(payload);
        sendJson(res, result.status || (result.ok ? 200 : 400), result);
        return;
      }
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, POST, OPTIONS" });
      res.end("405 Method Not Allowed\n");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405 Method Not Allowed\n");
      return;
    }

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

async function main(argv) {
  // 子命令优先：apifix audit|fix|login|search|compare|protocols ...（其余走原有位置参数解析，行为不变）
  const SUBCOMMANDS = { audit: cmdAudit, fix: cmdFix, login: cmdLogin, search: cmdSearch, compare: cmdCompare, protocols: cmdProtocols };
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
      return await SUBCOMMANDS[name](subArgs, catalog.models);
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
      let detail = `（score=${res.score.toFixed(2)}）`;
      if (res.suggestionKind === "prefix") detail = "（前缀匹配）";
      else if (res.suggestionKind === "normalized") detail = "（归一化写法）";
      stderr(`[x] ${opts.modelId}: ${NOT_FOUND_TEXT} 最接近: ${res.suggestion}${detail}`);
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
    // 完整模式（-f）：字段由 core.mjs 决定，缺失数据说明经 onNote 走既有 stderr 通道。
    const onNote = (line) => stderr(line);
    if (emit === "opencode") {
      stdout(emitOpencode(entry, { name, keyId: key, full: opts.full, onNote }));
    } else if (emit === "pi") {
      stdout(emitPi(entry, { name, id: key, full: opts.full, onNote }));
    } else {
      // codex / claude-env 有配置文件级完整模式；curl / sdk 无 -f 语义。
      if (opts.full && emit !== "codex" && emit !== "claude-env") {
        stderr("[i] --full 仅对 opencode/pi/codex/claude-env 生效，已忽略");
      }
      stdout(emitExtra(entry, emit, { name, keyId: key, full: opts.full, onNote }));
    }
  }
  return 0;
}

// 输出被 head 等提前关闭时静默退出（对齐 Python 的 BrokenPipeError 处理）
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err && err.code === "EPIPE") process.exit(0);
  stderr(`[x] 运行失败: ${err && err.message ? err.message : err}`);
  process.exitCode = 2;
}
