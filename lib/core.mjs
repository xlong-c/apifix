// apifix core — 纯 ESM 共享模块（浏览器 / Node 通用）
//
// 本文件 **不使用任何 Node API**（无 fs/path/process/url），可直接被
// 浏览器 <script type="module"> 加载，也被 apifix.mjs（CLI/UI 服务端）复用。
//
// 行为与 legacy-python/apifix.py 逐项对齐：
//   匹配优先级 exact > alias > legacy > 去厂商前缀 > 去 relay 后缀 >
//   分隔符等价 > 模糊（difflib 语义，cutoff 0.75，仅给建议）。

// --------------------------------------------------------------------------
// 常量（与 apifix.py 完全一致）
// --------------------------------------------------------------------------

const VENDOR_PREFIXES = [
  "openai", "anthropic", "meta", "google", "x-ai", "xai", "deepseek",
  "moonshotai", "moonshot", "z-ai", "zhipu", "qwen", "dashscope",
  "minimax", "minimaxai", "volcengine", "volcengine-plan", "doubao",
  "tencent", "alibaba", "ark",
  // 目录内其余厂商 + 常见中转前缀（静态兜底；matchModel 还会把 catalog 的 vendor 动态并入，
  // 新增厂商无需改这里也能被识别）
  "stepfun", "mistral", "mistralai", "cohere", "nvidia", "microsoft", "azure",
  "amazon", "bedrock", "baidu", "qianfan", "iflytek", "xfyun", "01ai",
  "lingyiwanwu", "ai21", "writer", "aliyun", "bigmodel",
];

// 厂商前缀集合 = 静态表 + 目录内实际 vendor（自动跟随新增厂商，避免白名单漏加）
function vendorPrefixSet(models) {
  const set = new Set(VENDOR_PREFIXES);
  if (Array.isArray(models)) {
    for (const entry of models) {
      const vendor = isDict(entry) && typeof entry.vendor === "string" ? entry.vendor.toLowerCase() : "";
      if (vendor) set.add(vendor);
    }
  }
  return set;
}

// 中转/发布渠道后缀。顺序敏感：长后缀优先。
const SUFFIX_PATTERNS = [
  ["-vision-exp", /-vision-exp$/i],
  ["-experimental", /-experimental$/i],
  ["-expires-on-*", /-expires-on-[0-9a-z]+$/i],
  ["-ga-*", /-ga-[0-9a-z]+$/i],
  ["-contributor", /-contributor$/i],
  ["-preview", /-preview$/i],
  ["-free", /-free$/i],
  ["-latest", /-latest$/i],
  ["-build", /-build$/i],
  ["-exp", /-exp$/i],
  ["-YYYYMMDD", /-(19|20)\d{6}$/],
  ["-vN", /-v\d+$/i],
];

const SEP_RE = /[-._]/g;

// key 冲突（同一字符串既是某条 id 又是另一条 alias/legacy）时的类型优先级
const PRIO = { exact: 0, alias: 1, legacy: 2 };

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const NULL_TEXT = "未知/not documented";
const MISSING_TEXT = "unknown";

const MISSING = Symbol("missing");

const BASE_URL_ENV = {
  anthropic_messages: ["ANTHROPIC_BASE_URL", "/v1/messages"],
  responses: ["OPENAI_BASE_URL", "/v1/responses"],
  chat_completions: ["OPENAI_BASE_URL", "/v1/chat/completions"],
  gemini: ["GEMINI_BASE_URL", "/v1beta/models/{model}:generateContent"],
  native: ["BASE_URL", "/v1/complete"],
};

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function dig(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!isDict(cur)) return MISSING;
    if (!hasOwn(cur, key)) return MISSING;
    cur = cur[key];
  }
  return cur;
}

function asDict(value) {
  return isDict(value) ? value : {};
}

function valOrNone(entry, path) {
  const value = dig(entry, path);
  return value === MISSING ? null : value;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fmt(value, opts) {
  const missing = (opts && opts.missingText) || MISSING_TEXT;
  const nullText = (opts && opts.nullText) || NULL_TEXT;
  const yes = (opts && opts.yes) || "是";
  const no = (opts && opts.no) || "否";
  if (value === MISSING) return missing;
  if (value === null || value === undefined) return nullText;
  if (value === true) return yes;
  if (value === false) return no;
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => String(v)).join("、") : "(空)";
  }
  return String(value);
}

function fmtNum(value) {
  if (typeof value === "boolean" || !Number.isInteger(value)) return fmt(value);
  return groupThousands(value);
}

function fmtRange(value) {
  if (value === MISSING || value === null || value === undefined) return fmt(value);
  if (Array.isArray(value) && value.length === 2) return `[${value[0]}, ${value[1]}]`;
  return fmt(value);
}

function fmtFlagWithNote(value, constraint) {
  const base = fmt(value);
  if (constraint !== MISSING && constraint !== null && constraint !== undefined && constraint !== "") {
    return `${base}（${constraint}）`;
  }
  return base;
}

// --------------------------------------------------------------------------
// 宽度处理（东亚宽度感知；CJK 全角算 2）
// --------------------------------------------------------------------------

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

// 组合字符（对应 Python unicodedata.combining(ch) != 0 的常见情形）
const COMBINING_RE = /[\p{Mn}\p{Me}]/u;

function isWide(cp) {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// 东亚宽度感知的显示宽度（CJK 全角算 2，组合字符不计宽）。
// CLI（apifix.mjs --list/--match 的列对齐）与本模块共用同一份实现。
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    if (COMBINING_RE.test(ch)) continue;
    width += isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

// 按显示宽度补空格对齐；align 为 "left"（默认）/ "right" / "center"。
// 注意：不截断，超宽时原样返回（列可能被顶开，与历史 CLI 行为一致）。
export function pad(text, width, align) {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

// 千分位分组：1e9 -> "1,000,000,000"。非整数走 fmt 的通用文案，由调用方保证传整数。
export function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// --------------------------------------------------------------------------
// 归一化 / 匹配
// --------------------------------------------------------------------------

function sepKey(text) {
  return String(text).trim().toLowerCase().replace(SEP_RE, "-");
}

function normalizeStages(rawInput, prefixes) {
  const prefixSet = prefixes instanceof Set ? prefixes : new Set(VENDOR_PREFIXES);
  const stages = [];
  let cand = String(rawInput == null ? "" : rawInput).trim();
  let ops = [];
  stages.push({ cand, ops: ops.slice() });

  if (cand.includes("/")) {
    const idx = cand.indexOf("/");
    const prefix = cand.slice(0, idx);
    const rest = cand.slice(idx + 1);
    if (prefixSet.has(prefix.toLowerCase()) && rest) {
      cand = rest;
      ops = ops.concat([`去除厂商前缀 ${prefix.toLowerCase()}/`]);
      stages.push({ cand, ops: ops.slice() });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [label, pattern] of SUFFIX_PATTERNS) {
      if (pattern.test(cand)) {
        cand = cand.replace(pattern, "");
        ops = ops.concat([`去除 relay 后缀 ${label}`]);
        stages.push({ cand, ops: ops.slice() });
        changed = true;
        break;
      }
    }
  }

  if (sepKey(cand) !== cand.trim().toLowerCase()) {
    ops = ops.concat(["分隔符归一化 (-/./_ 等价)"]);
    stages.push({ cand, ops: ops.slice() });
  }

  return stages;
}

function catalogKeys(models) {
  const keys = [];
  for (const entry of models) {
    const id = isDict(entry) && typeof entry.id === "string" ? entry.id : "";
    keys.push([id, entry, "exact"]);
    const aliases = isDict(entry) && Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const alias of aliases) {
      if (typeof alias === "string" && alias) keys.push([alias, entry, "alias"]);
    }
    const legacy = isDict(entry) && Array.isArray(entry.legacy_ids) ? entry.legacy_ids : [];
    for (const item of legacy) {
      if (isDict(item) && typeof item.id === "string" && item.id) keys.push([item.id, entry, "legacy"]);
    }
  }
  return keys;
}

function exactLookup(cand, keys) {
  const low = cand.toLowerCase();
  let best = null;
  let bestPrio = null;
  for (const [text, entry, kind] of keys) {
    if (String(text).toLowerCase() !== low) continue;
    const prio = PRIO[kind] === undefined ? 3 : PRIO[kind];
    if (bestPrio === null || prio < bestPrio) {
      best = [entry, kind];
      bestPrio = prio;
      if (prio === 0) break;
    }
  }
  return best;
}

// --- difflib.SequenceMatcher 语义（无 junk / autojunk，等价实现） -----------

function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const indices = b2j.get(a[i]);
    if (indices) {
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

function matchingBlocks(a, b) {
  const la = a.length;
  const lb = b.length;
  const b2j = new Map();
  for (let i = 0; i < lb; i++) {
    const elt = b[i];
    if (!b2j.has(elt)) b2j.set(elt, []);
    b2j.get(elt).push(i);
  }

  const queue = [[0, la, 0, lb]];
  const found = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      found.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent = [];
  for (const [i2, j2, k2] of found) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  return nonAdjacent;
}

function seqRatio(a, b) {
  const aArr = Array.from(a);
  const bArr = Array.from(b);
  let matches = 0;
  for (const [, , size] of matchingBlocks(aArr, bArr)) matches += size;
  const total = aArr.length + bArr.length;
  return total === 0 ? 1 : (2 * matches) / total;
}

// difflib.get_close_matches(word, possibilities, n, cutoff) 等价实现。
// _nlargest 对 (score, x) 元组取最大：同分时按字符串字典序取较大者。
function getCloseMatches(word, possibilities, n, cutoff) {
  const result = [];
  for (const x of possibilities) {
    const ratio = seqRatio(x, word);
    if (ratio >= cutoff) result.push([ratio, x]);
  }
  result.sort((p, q) => q[0] - p[0] || cmpStr(q[1], p[1]));
  return result.slice(0, n).map((p) => p[1]);
}

// --------------------------------------------------------------------------
// 对外 API
// --------------------------------------------------------------------------

export function normalizeId(input) {
  const stages = normalizeStages(input);
  const last = stages[stages.length - 1];
  return {
    normalized: last.cand,
    notes: last.ops.slice(),
    stages: stages.map((s) => ({ candidate: s.cand, ops: s.ops.slice() })),
  };
}

export function matchModel(catalog, input) {
  const models = Array.isArray(catalog)
    ? catalog
    : isDict(catalog) && Array.isArray(catalog.models)
      ? catalog.models
      : [];

  const raw = String(input == null ? "" : input).trim();
  const res = {
    input: raw,
    kind: "none",
    matchedId: null,
    note: null,
    entry: null,
    suggestion: null,
    suggestionKind: null,
    score: 0,
    ops: [],
    notes: [],
  };
  if (!raw) return res;

  const keys = catalogKeys(models);
  const prefixes = vendorPrefixSet(models);

  // 分隔符等价表：同一 key 出现多种类型时，优先级 exact > alias > legacy
  const sepMap = new Map();
  const sepKinds = new Map();
  for (const [text, entry, kind] of keys) {
    const sk = sepKey(text);
    if (!sepMap.has(sk) || PRIO[kind] < PRIO[sepKinds.get(sk)]) {
      sepMap.set(sk, entry);
      sepKinds.set(sk, kind);
    }
  }

  // 第 1 阶段：原始输入（含大小写不敏感）直接命中 id / alias / legacy
  const direct = exactLookup(raw, keys);
  if (direct) {
    res.entry = direct[0];
    res.matchedId = direct[0] ? (direct[0].id ?? null) : null;
    res.kind = direct[1];
    res.notes = notesFor(res);
    res.note = res.notes.length ? res.notes[0] : null;
    return res;
  }

  // 第 2 阶段：归一化后命中（去前缀/后缀/分隔符）
  for (const stage of normalizeStages(raw, prefixes)) {
    if (!stage.ops.length) continue;
    const cand = stage.cand;
    let ops = stage.ops.slice();
    const hit = exactLookup(cand, keys);
    if (hit) {
      res.entry = hit[0];
      res.matchedId = hit[0] ? (hit[0].id ?? null) : null;
      res.ops = ops;
      res.kind = hit[1] === "legacy" ? "legacy" : "normalized";
      res.notes = notesFor(res);
      res.note = res.notes.length ? res.notes[0] : null;
      return res;
    }
    const sepHit = sepMap.get(sepKey(cand));
    if (sepHit !== undefined) {
      const sk = sepKey(cand);
      const kind = sepKinds.get(sk);
      if (kind === "legacy") {
        res.entry = sepHit;
        res.matchedId = sepHit ? (sepHit.id ?? null) : null;
        res.ops = ops;
        res.kind = "legacy";
        res.notes = notesFor(res);
        res.note = res.notes.length ? res.notes[0] : null;
        return res;
      }
      const cid = String((sepHit && sepHit.id) || "").toLowerCase();
      if (cand.trim().toLowerCase() !== cid) {
        ops = ops.concat(["分隔符等价匹配 (-/./_ 视为相同)"]);
      }
      res.entry = sepHit;
      res.matchedId = sepHit ? (sepHit.id ?? null) : null;
      res.ops = ops;
      res.kind = "normalized";
      res.notes = notesFor(res);
      res.note = res.notes.length ? res.notes[0] : null;
      return res;
    }
  }

  // 第 3 阶段：分隔符等价（无前缀/后缀变更）
  const rawSepHit = sepMap.get(sepKey(raw));
  if (rawSepHit !== undefined) {
    const sk = sepKey(raw);
    const kind = sepKinds.get(sk);
    const cid = String((rawSepHit && rawSepHit.id) || "").toLowerCase();
    if (kind === "legacy") {
      res.entry = rawSepHit;
      res.matchedId = rawSepHit ? (rawSepHit.id ?? null) : null;
      res.kind = "legacy";
      res.notes = notesFor(res);
      res.note = res.notes.length ? res.notes[0] : null;
      return res;
    }
    if (raw.trim().toLowerCase() !== cid) {
      res.ops = ["分隔符等价匹配 (-/./_ 视为相同)"];
    }
    res.entry = rawSepHit;
    res.matchedId = rawSepHit ? (rawSepHit.id ?? null) : null;
    res.kind = "normalized";
    res.notes = notesFor(res);
    res.note = res.notes.length ? res.notes[0] : null;
    return res;
  }

  // 模糊兜底（仅给建议，不自动纠错）
  const pool = Array.from(new Set(keys.map((k) => k[0]).filter((t) => t))).sort(cmpStr);
  const probe = sepKey(raw);
  const close = getCloseMatches(probe, pool.map(sepKey), 1, 0.75);
  if (close.length) {
    const wanted = close[0];
    for (const p of pool) {
      if (sepKey(p) === wanted) {
        res.suggestion = p;
        break;
      }
    }
    res.score = seqRatio(probe, wanted);
    res.kind = "fuzzy";
  } else {
    // 短缩写兜底建议（如 step5 → step-5-preview）：压缩分隔符后做前缀扫描。
    // 仍然只是"建议"——kind 保持 none、退出码不变，仅在展示层标注"前缀匹配"。
    const compact = (text) => sepKey(text).replace(/[-._/]/g, "");
    const compactProbe = compact(raw);
    if (compactProbe.length >= 3) {
      const hits = pool.filter((p) => compact(p).startsWith(compactProbe));
      if (hits.length && hits.length <= 5) {
        res.suggestion = hits[0];
        res.suggestionKind = "prefix";
      }
    }
  }
  return res;
}

function notesFor(res) {
  if (!res || !res.entry || !res.input) return [];
  const cid = res.matchedId || "";
  const out = [];

  if (res.kind === "legacy") {
    out.push(
      `[i] ${res.input} 是旧版/退役 id，对应 ${cid}；中转仍在沿用，值按官网当前规格输出`,
    );
  } else if (res.kind === "alias") {
    out.push(`[i] ${res.input} -> ${cid}（别名解析）`);
  } else if (res.kind === "normalized") {
    const detail = res.ops && res.ops.length ? res.ops.join("；") : "归一化解析";
    out.push(`[i] ${res.input} -> 官网规范 id ${cid}（值采用官方规格，${detail}）`);
  }

  const entry = res.entry || {};
  const lifecycle = dig(entry, ["lifecycle"]);
  const note = dig(entry, ["lifecycle_note"]);
  const hasNote = typeof note === "string" && Boolean(note);
  if (lifecycle === "retired") {
    if (hasNote) out.push(`[!] ${cid} ${note}`);
    else out.push(`[!] ${cid} 官方已退役；第三方可能仍提供，参数为退役前规格`);
  } else if (lifecycle === "unreleased") {
    if (hasNote) out.push(`[!] ${cid} ${note}`);
    else out.push(`[!] ${cid} 官方尚未发布`);
  }
  return out;
}

// --------------------------------------------------------------------------
// 列表行
// --------------------------------------------------------------------------

export function listRows(catalog) {
  const models = Array.isArray(catalog)
    ? catalog
    : isDict(catalog) && Array.isArray(catalog.models)
      ? catalog.models
      : [];
  return models.map((e) => {
    const entry = isDict(e) ? e : {};
    const reasoning = asDict(entry.reasoning);
    return {
      id: entry.id ?? null,
      vendor: entry.vendor ?? null,
      family: entry.family ?? null,
      lifecycle: entry.lifecycle ?? null,
      verified: entry.verified ?? null,
      context_window: entry.context_window ?? null,
      max_output_tokens: entry.max_output_tokens ?? null,
      reasoning: reasoning.supported ?? null,
    };
  });
}

// --------------------------------------------------------------------------
// 卡片渲染
// --------------------------------------------------------------------------

function fmtLifecycle(entry) {
  const lifecycle = dig(entry, ["lifecycle"]);
  const note = dig(entry, ["lifecycle_note"]);
  const base = fmt(lifecycle);
  if (typeof note === "string" && note) return `${base}（${note}）`;
  const legacy = dig(entry, ["legacy_ids"]);
  if (Array.isArray(legacy) && legacy.length) {
    const ids = legacy
      .filter((x) => isDict(x) && x.id)
      .map((x) => String(x.id));
    if (ids.length) return `${base}（含 legacy id: ${ids.join("、")}）`;
  }
  return base;
}

function fmtBudget(tb) {
  if (tb === MISSING) return MISSING_TEXT;
  if (tb === null || tb === undefined) return NULL_TEXT;
  if (isDict(tb)) {
    const parts = [];
    if (tb.min !== null && tb.min !== undefined) parts.push(`min=${tb.min}`);
    if (tb.max !== null && tb.max !== undefined) parts.push(`max=${tb.max}`);
    if (tb.less_than_max_tokens === true) parts.push("< max_tokens");
    return parts.length ? parts.join("、") : "已文档化（无具体数值）";
  }
  return fmt(tb);
}

export function renderCard(entry, note) {
  const e = isDict(entry) ? entry : {};
  const eid = fmt(dig(e, ["id"]));
  const vendor = fmt(dig(e, ["vendor"]));
  const family = fmt(dig(e, ["family"]));
  const protocol = fmt(dig(e, ["api_protocol"]));
  const verified = dig(e, ["verified"]);
  let vflag;
  if (verified === true) vflag = "已核验官网";
  else if (verified === false) vflag = "未核验 (unofficial)";
  else vflag = fmt(verified);

  const reasoning = asDict(dig(e, ["reasoning"]));
  const sampling = asDict(dig(e, ["sampling"]));
  const tools = asDict(dig(e, ["tools"]));
  const caching = asDict(dig(e, ["caching"]));
  const so = asDict(dig(e, ["structured_output"]));
  const tb = "thinking_budget" in reasoning ? reasoning.thinking_budget : MISSING;

  const temp = asDict(sampling.temperature);
  const topP = asDict(sampling.top_p);
  const topK = asDict(sampling.top_k);

  const rows = [
    ["上下文窗口", fmtNum(dig(e, ["context_window"]))],
    ["最大输出", fmtNum(dig(e, ["max_output_tokens"]))],
    ["推理/思考", fmt("supported" in reasoning ? reasoning.supported : MISSING)],
    ["effort 档位", fmt("effort_values" in reasoning ? reasoning.effort_values : MISSING)],
    ["默认 effort", fmt("default_effort" in reasoning ? reasoning.default_effort : MISSING)],
    ["可关闭思考", fmt("can_disable" in reasoning ? reasoning.can_disable : MISSING)],
    ["思考预算", fmtBudget(tb)],
    ["摘要模式", fmt("summary_values" in reasoning ? reasoning.summary_values : MISSING)],
    ["temperature", fmtFlagWithNote("supported" in temp ? temp.supported : MISSING, "constraint" in temp ? temp.constraint : MISSING)],
    ["temperature 范围", fmtRange("range" in temp ? temp.range : MISSING)],
    ["top_p", fmtFlagWithNote("supported" in topP ? topP.supported : MISSING, "constraint" in topP ? topP.constraint : MISSING)],
    ["top_k", fmtFlagWithNote("supported" in topK ? topK.supported : MISSING, "constraint" in topK ? topK.constraint : MISSING)],
    ["工具调用", fmt("function_calling" in tools ? tools.function_calling : MISSING)],
    ["并行工具", fmt("parallel" in tools ? tools.parallel : MISSING)],
    ["严格 schema", fmt("strict" in tools ? tools.strict : MISSING)],
    ["tool_choice", fmt("choice_modes" in tools ? tools.choice_modes : MISSING)],
    ["结构化输出", fmtFlagWithNote("supported" in so ? so.supported : MISSING, "mechanism" in so ? so.mechanism : MISSING)],
    ["视觉", fmt(dig(e, ["vision"]))],
    ["PDF", fmt(dig(e, ["pdf"]))],
    ["缓存模式", fmt("mode" in caching ? caching.mode : MISSING)],
    ["缓存最小 token", fmtNum("min_tokens" in caching ? caching.min_tokens : MISSING)],
    ["缓存 TTL", fmt("ttl_options" in caching ? caching.ttl_options : MISSING)],
    ["服务层级", fmt(dig(e, ["service_tiers"]))],
    ["别名", fmt(dig(e, ["aliases"]))],
    ["数据来源", fmt(dig(e, ["data_origin"]))],
    ["生命周期", fmtLifecycle(e)],
    ["置信度", fmt(dig(e, ["confidence"]))],
  ];

  let labelW = 0;
  for (const [label] of rows) labelW = Math.max(labelW, displayWidth(label));
  const body = rows.map(([label, value]) => `${pad(label, labelW)} │ ${value}`);

  const warnings = [];
  const gotchas = dig(e, ["gotchas"]);
  if (Array.isArray(gotchas)) {
    for (const g of gotchas) warnings.push(`[!] ${g}`);
  }
  const sources = dig(e, ["sources"]);
  if (Array.isArray(sources) && sources.length) {
    warnings.push("来源:");
    for (const s of sources) warnings.push(`    ${s}`);
  }
  if (note) warnings.push(note);

  const head = [eid, `${vendor} / ${family} · ${protocol} · ${vflag}`];
  if (verified === false) head.push("[!] 该条目未与官网核验，数值仅供排查参考");

  let content = head.concat(body);
  if (warnings.length) content = content.concat(["─".repeat(8)]).concat(warnings);

  let width = 0;
  for (const line of content) width = Math.max(width, displayWidth(line));
  width = Math.max(width + 2, 54);

  const out = ["┌" + "─".repeat(width) + "┐"];
  for (const line of head) out.push("│ " + pad(line, width - 1) + "│");
  out.push("├" + "─".repeat(width) + "┤");
  for (const line of body) out.push("│ " + pad(line, width - 1) + "│");
  if (warnings.length) {
    out.push("├" + "─".repeat(width) + "┤");
    for (const line of warnings) out.push("│ " + pad(line, width - 1) + "│");
  }
  out.push("└" + "─".repeat(width) + "┘");
  return out.join("\n");
}

// --------------------------------------------------------------------------
// emit: opencode / pi （主要输出）
// --------------------------------------------------------------------------

function bestEffort(entry) {
  const reasoning = dig(entry, ["reasoning"]);
  if (!isDict(reasoning)) return null;
  const efforts = reasoning.effort_values;
  if (!Array.isArray(efforts) || !efforts.length) return null;
  const def = reasoning.default_effort;
  if (efforts.includes(def)) return def;
  for (const candidate of ["high", "medium", "low", "xhigh", "max", "minimal", "none"]) {
    if (efforts.includes(candidate)) return candidate;
  }
  return efforts[0];
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort(cmpStr)) out[key] = obj[key];
  return out;
}

// 完整模式（-f / --full）：catalog 里没有官方数据的字段一律不输出（不臆造数值），
// 只补 catalog 能提供的字段；缺失项由 note 统一说明（note 内容动态生成，
// 已成功输出的字段会从列表里去掉）。
const OPENCODE_FULL_OMITTED = [
  "cost",
  "release_date",
  "interleaved",
  "experimental",
  "options",
  "headers",
];
const PI_FULL_OMITTED = ["provider", "baseUrl", "compat", "cost"];

function fullNote(omitted) {
  return `[i] 完整模式：${omitted.join("/")} 因 catalog 无官方数据未输出（不臆造数值）`;
}

const OPENCODE_STATUS = {
  current: "active",
  legacy: "deprecated",
  retired: "deprecated",
  unreleased: "beta",
};

const PI_API_MAP = {
  anthropic_messages: "anthropic-messages",
  responses: "openai-responses",
  chat_completions: "openai-completions",
};

// api_protocol 可能是 N 路 pipe 值（如 chat_completions|responses|anthropic_messages，
// 表示"任一皆可"）。emit 时取**首个**元素映射（first-listed-wins）：
//   responses|chat_completions -> openai-responses（与历史行为一致）
//   chat_completions|responses|anthropic_messages -> openai-completions
// 首项不可映射（native/gemini 等）时返回 undefined，由调用方按"无法映射"处理。
function mapPiApi(protocol) {
  if (typeof protocol !== "string" || !protocol) return undefined;
  const first = protocol.split("|")[0].trim();
  return PI_API_MAP[first];
}

// core.mjs 不依赖任何 Node API，因此 note 通过调用方注入的回调转交（CLI 接到 stderr）。
function emitNote(options, text) {
  if (typeof options.onNote === "function") options.onNote(text);
}

// 从 entry.cost（一律 USD）构造 opencode 的 cost 字段。
// opencode schema 只接受数字，故 null 键一律省略；input/output 缺一即整体省略。
function opencodeCost(entry) {
  const cost = dig(entry, ["cost"]);
  if (!isDict(cost)) return null;
  if (!isNum(cost.input) || !isNum(cost.output)) return null;

  const out = { input: cost.input, output: cost.output };
  for (const key of ["cache_read", "cache_write"]) {
    if (isNum(cost[key])) out[key] = cost[key];
  }

  const over = cost.context_over_200k;
  if (isDict(over) && isNum(over.input) && isNum(over.output)) {
    const sub = { input: over.input, output: over.output };
    for (const key of ["cache_read", "cache_write"]) {
      if (isNum(over[key])) sub[key] = over[key];
    }
    out.context_over_200k = sub;
  }
  return out;
}

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function emitOpencode(entry, opts) {
  const options = opts || {};
  const key = options.keyId !== null && options.keyId !== undefined ? options.keyId : entry.id;
  const name = options.name !== null && options.name !== undefined ? options.name : key;

  const reasoning = asDict(dig(entry, ["reasoning"]));
  const tools = asDict(dig(entry, ["tools"]));
  const sampling = asDict(dig(entry, ["sampling"]));
  const temp = asDict(sampling.temperature);

  const payload = {
    attachment: valOrNone(entry, ["vision"]),
    limit: {
      context: valOrNone(entry, ["context_window"]),
      output: valOrNone(entry, ["max_output_tokens"]),
    },
    name,
    reasoning: "supported" in reasoning ? reasoning.supported : null,
    temperature: "supported" in temp ? temp.supported : null,
    tool_call: "function_calling" in tools ? tools.function_calling : null,
  };

  const efforts = reasoning.effort_values;
  if (Array.isArray(efforts) && efforts.length) {
    const variants = {};
    for (const effort of efforts.slice().sort(cmpStr)) {
      variants[effort] = { reasoningEffort: effort };
    }
    payload.variants = variants;
  }

  if (options.full) {
    const family = dig(entry, ["family"]);
    if (typeof family === "string" && family) payload.family = family;

    const status = OPENCODE_STATUS[dig(entry, ["lifecycle"])];
    if (status) payload.status = status;

    const modalities = { input: ["text"] };
    if (dig(entry, ["vision"]) === true) modalities.input.push("image");
    if (dig(entry, ["pdf"]) === true) modalities.input.push("pdf");
    modalities.output = ["text"];
    payload.modalities = modalities;

    // 动态 omission note：成功输出的字段从缺失列表里去掉
    const omitted = OPENCODE_FULL_OMITTED.slice();
    const cost = opencodeCost(entry);
    if (cost) {
      payload.cost = cost;
      omitted.splice(omitted.indexOf("cost"), 1);
    }

    emitNote(options, fullNote(omitted));
  }

  return JSON.stringify({ [key]: sortedObject(payload) }, null, 2);
}

// pi 的 thinkingLevelMap 推导（emitPi 与 fix 共用，保证两者一致）：
// "off" 是 pi 的「关闭思考」档位；官方用 none 表示关闭时映射为 "none"（与 pi 自带
// models-store.json 中 grok 的 "off": "none" 写法一致），否则保持 null。
function piThinkingLevelMap(entry) {
  const reasoning = asDict(dig(entry, ["reasoning"]));
  const supported = "supported" in reasoning ? reasoning.supported : null;
  const efforts = Array.isArray(reasoning.effort_values) ? reasoning.effort_values : [];

  const levelMap = {};
  for (const level of PI_LEVELS) {
    if (!supported) {
      levelMap[level] = null;
    } else if (level === "off") {
      levelMap[level] = efforts.includes("none") ? "none" : null;
    } else {
      levelMap[level] = efforts.includes(level) ? level : null;
    }
  }
  return levelMap;
}

export function emitPi(entry, opts) {
  const options = opts || {};
  const key = options.id !== null && options.id !== undefined ? options.id : entry.id;
  const name = options.name !== null && options.name !== undefined ? options.name : key;

  const reasoning = asDict(dig(entry, ["reasoning"]));
  const supported = "supported" in reasoning ? reasoning.supported : null;
  const levelMap = piThinkingLevelMap(entry);

  const inputs = dig(entry, ["vision"]) === true ? ["text", "image"] : ["text"];

  const payload = {
    id: key,
    name,
    reasoning: supported,
    input: inputs,
    contextWindow: valOrNone(entry, ["context_window"]),
    maxTokens: valOrNone(entry, ["max_output_tokens"]),
    thinkingLevelMap: levelMap,
  };

  if (options.full) {
    const protocol = valOrNone(entry, ["api_protocol"]);
    const api = mapPiApi(protocol);
    // pi 无 cost 字段，故 cost 始终保留在缺失列表中（行为与之前一致）。
    let note = fullNote(PI_FULL_OMITTED);
    if (api) {
      payload.api = api;
    } else {
      const shown = protocol === null || protocol === undefined ? "null" : String(protocol);
      note += `；api 无法映射（api_protocol=${shown}）`;
    }
    emitNote(options, note);
  }

  return JSON.stringify(payload, null, 2);
}

// --------------------------------------------------------------------------
// emit: 次要目标（best-effort）
//
// 配置文件级片段（-f）使用固定占位符：不联网、不臆造；catalog 没有官方值的字段
// 一律省略并由 onNote 说明（不变量 4）。
// --------------------------------------------------------------------------

const CODEX_BASE_URL_PLACEHOLDER = "https://YOUR_BASE_URL/v1";
const CLAUDE_BASE_URL_PLACEHOLDER = "https://YOUR_BASE_URL";
const API_KEY_PLACEHOLDER = "YOUR_API_KEY";

// TOML 双引号字符串（转义反斜杠 / 双引号 / 控制字符）
function tomlString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

// TOML 键：仅 [A-Za-z0-9_-] 可裸写；含 . 等特殊字符必须用引号键
function tomlKeyText(key) {
  return /^[A-Za-z0-9_-]+$/.test(String(key)) ? String(key) : tomlString(key);
}

// codex 的 wire_api 由 api_protocol 首段推导（chat_completions→chat、responses→responses）；
// 其余协议（native / gemini / anthropic_messages / null）codex 无法表达 → null（不臆造）。
function codexWireApi(entry) {
  const protocol = valOrNone(entry, ["api_protocol"]);
  if (typeof protocol !== "string") return null;
  const first = protocol.split("|")[0].trim();
  if (first === "chat_completions") return "chat";
  if (first === "responses") return "responses";
  return null;
}

// 与 codex 兼容的 wire_api 取值集合（audit / fix 共用，保证判定一致）
function codexWireOptions(entry) {
  const protocol = valOrNone(entry, ["api_protocol"]);
  if (typeof protocol !== "string") return [];
  const segments = protocol.split("|").map((s) => s.trim());
  const out = [];
  if (segments.includes("responses")) out.push("responses");
  if (segments.includes("chat_completions")) out.push("chat");
  return out;
}

function buildCodex(entry, key, opts) {
  const options = opts || {};
  const effort = bestEffort(entry);
  const lines = [`model = "${key}"`];
  if (effort) {
    lines.push(`model_reasoning_effort = "${effort}"`);
  } else {
    lines.push("# model_reasoning_effort = 未知，需确认（该模型未文档化 reasoning effort 档位）");
  }
  if (!options.full) return lines.join("\n");

  // 完整模式：补全 provider 段（base_url / env_key 为占位符，替换后再用）
  const providerKey = key;
  const providerName = options.name !== null && options.name !== undefined ? options.name : key;
  const wire = codexWireApi(entry);
  lines.push(`model_provider = ${tomlString(providerKey)}`);
  lines.push("");
  lines.push(`[model_providers.${tomlKeyText(providerKey)}]`);
  lines.push(`name = ${tomlString(providerName)}`);
  lines.push(`base_url = "${CODEX_BASE_URL_PLACEHOLDER}"  # 占位符：替换为你的网关/中转地址`);
  if (wire) {
    lines.push(`wire_api = "${wire}"`);
  } else {
    const protocol = valOrNone(entry, ["api_protocol"]);
    const shown = protocol === null || protocol === undefined ? "null" : String(protocol);
    lines.push(`# wire_api 无法映射（api_protocol=${shown}；codex 仅支持 responses / chat）`);
  }
  lines.push(`# env_key = "YOUR_API_KEY_ENV"  # 可选：API key 所处的环境变量名（占位，需自行设置）`);
  emitNote(options, "[i] 完整模式：codex 片段含占位符（base_url / env_key），替换后再使用");
  return lines.join("\n");
}

function buildClaudeEnv(entry, key, opts) {
  const options = opts || {};
  const reasoning = asDict(dig(entry, ["reasoning"]));
  const lines = [`ANTHROPIC_MODEL=${key}`];

  const tb = "thinking_budget" in reasoning ? reasoning.thinking_budget : MISSING;
  const budget = isDict(tb) && tb.min !== null && tb.min !== undefined ? tb.min : null;
  if (budget !== null) {
    lines.push(`MAX_THINKING_TOKENS=${budget}`);
  } else {
    lines.push("# MAX_THINKING_TOKENS=未知，需确认（该模型未文档化 thinking budget）");
  }

  let effort = null;
  if (reasoning.supported === false) {
    lines.push("# CLAUDE_CODE_EFFORT_LEVEL=不适用（该模型不支持推理）");
  } else {
    effort = bestEffort(entry);
    if (effort) {
      lines.push(`CLAUDE_CODE_EFFORT_LEVEL=${effort}`);
    } else {
      lines.push("# CLAUDE_CODE_EFFORT_LEVEL=未知，需确认（该模型未文档化 effort 档位）");
    }
  }

  if (!options.full) return lines.join("\n");

  // 完整模式：输出 ~/.claude/settings.json 的 env 块（值必须是字符串）；
  // 凭证只允许占位符——真实 AUTH_TOKEN 永不出现。
  const env = {
    ANTHROPIC_BASE_URL: CLAUDE_BASE_URL_PLACEHOLDER,
    ANTHROPIC_AUTH_TOKEN: API_KEY_PLACEHOLDER,
    ANTHROPIC_MODEL: key,
  };
  if (budget !== null) env.MAX_THINKING_TOKENS = String(budget);
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  emitNote(options, "[i] 完整模式：输出 ~/.claude/settings.json 的 env 块（值均为字符串），BASE_URL / AUTH_TOKEN 为占位符");
  if (budget === null) {
    emitNote(options, "[i] MAX_THINKING_TOKENS 未输出：该模型官网未文档化 thinking budget（不臆造数值）");
  }
  if (!effort) {
    emitNote(options, "[i] CLAUDE_CODE_EFFORT_LEVEL 未输出：该模型官网未文档化 effort 档位（不臆造数值）");
  }
  return JSON.stringify({ env }, null, 2);
}

function buildCurl(entry, key) {
  const rawProtocol = valOrNone(entry, ["api_protocol"]);
  const protocol = typeof rawProtocol === "string" ? rawProtocol : "chat_completions";
  const mapped = BASE_URL_ENV[protocol] || ["BASE_URL", "/v1/chat/completions"];
  const env = mapped[0];
  const path = mapped[1].split("{model}").join(String(key));

  if (protocol === "anthropic_messages") {
    const maxTokens = valOrNone(entry, ["max_output_tokens"]);
    let head;
    let body;
    if (Number.isInteger(maxTokens)) {
      head = [`MAX_TOKENS=${maxTokens}  # 官网 max_output_tokens`];
    } else {
      head = ["MAX_TOKENS=4096  # 未知，需确认：官方未文档化 max_output_tokens，请填入实际值"];
    }
    body = `{"model":"${key}","max_tokens":\${MAX_TOKENS},"messages":[{"role":"user","content":"hi"}]}`;
    const escaped = body.replace(/"/g, '\\"');
    return head
      .concat([
        `curl -sS "$${env}${path}" \\`,
        '  -H "x-api-key: $ANTHROPIC_API_KEY" \\',
        '  -H "anthropic-version: 2023-06-01" \\',
        '  -H "content-type: application/json" \\',
        `  -d "${escaped}"`,
      ])
      .join("\n");
  }

  if (protocol === "gemini") {
    return [
      `curl -sS "$${env}${path}?key=$GEMINI_API_KEY" \\`,
      '  -H "content-type: application/json" \\',
      '  -d \'{"contents":[{"parts":[{"text":"hi"}]}]}\'',
    ].join("\n");
  }

  // chat_completions / responses / native
  const effort = bestEffort(entry);
  let payload;
  if (protocol === "responses") {
    const extra = effort ? `,"reasoning":{"effort":"${effort}"}` : "";
    payload = `{"model":"${key}","input":"hi"${extra}}`;
  } else {
    const extra = effort ? `,"reasoning_effort":"${effort}"` : "";
    payload = `{"model":"${key}","messages":[{"role":"user","content":"hi"}]${extra}}`;
  }
  return [
    `curl -sS "$${env}${path}" \\`,
    '  -H "Authorization: Bearer $OPENAI_API_KEY" \\',
    '  -H "content-type: application/json" \\',
    `  -d '${payload}'`,
  ].join("\n");
}

function buildSdk(entry, key) {
  const rawProtocol = valOrNone(entry, ["api_protocol"]);
  const protocol = typeof rawProtocol === "string" ? rawProtocol : "chat_completions";
  const effort = bestEffort(entry);
  const maxTokens = dig(entry, ["max_output_tokens"]);
  const maxIsInt = Number.isInteger(maxTokens);
  const maxNote = maxIsInt ? "" : "  # 未知，需确认（官方未文档化 max_output_tokens）";
  const maxValue = maxIsInt ? maxTokens : 4096;

  if (protocol === "anthropic_messages") {
    const lines = [
      "# pip install anthropic",
      "from anthropic import Anthropic",
      "",
      "client = Anthropic()",
      "resp = client.messages.create(",
      `    model="${key}",`,
      `    max_tokens=${maxValue},${maxNote}`,
      '    messages=[{"role": "user", "content": "hi"}],',
    ];
    if (effort) lines.push(`    # effort: "${effort}"（官方档位）`);
    lines.push(")");
    lines.push("print(resp.content)");
    return lines.join("\n");
  }

  if (protocol === "gemini") {
    return [
      "# pip install google-genai",
      "from google import genai",
      "",
      "client = genai.Client()",
      "resp = client.models.generate_content(",
      `    model="${key}",`,
      '    contents="hi",',
      ")",
      "print(resp.text)",
    ].join("\n");
  }

  if (protocol === "responses") {
    const lines = [
      "# pip install openai",
      "from openai import OpenAI",
      "",
      "client = OpenAI()",
      "resp = client.responses.create(",
      `    model="${key}",`,
      '    input="hi",',
    ];
    if (effort) lines.push(`    reasoning={"effort": "${effort}"},`);
    else lines.push("    # reasoning=未知，需确认（官方未文档化 effort 档位）");
    lines.push(")");
    lines.push("print(resp.output_text)");
    return lines.join("\n");
  }

  const lines = [
    "# pip install openai",
    "from openai import OpenAI",
    "",
    "client = OpenAI()  # 中转需设置 base_url",
    "resp = client.chat.completions.create(",
    `    model="${key}",`,
    '    messages=[{"role": "user", "content": "hi"}],',
  ];
  if (effort) lines.push(`    extra_body={"reasoning_effort": "${effort}"},`);
  lines.push(")");
  lines.push("print(resp.choices[0].message.content)");
  return lines.join("\n");
}

export function emitExtra(entry, target, opts) {
  const options = opts || {};
  const key = options.keyId !== null && options.keyId !== undefined ? options.keyId : entry.id;
  switch (target) {
    case "codex":
      return buildCodex(entry, key, options);
    case "claude-env":
      return buildClaudeEnv(entry, key, options);
    case "curl":
      return buildCurl(entry, key);
    case "sdk":
      return buildSdk(entry, key);
    default:
      throw new Error(`未知 emit 目标: ${target}`);
  }
}

// --------------------------------------------------------------------------
// login 子命令：opencode 供应商块构造（纯函数，浏览器 / Node 通用）
// --------------------------------------------------------------------------

// 从 baseURL 主机名派生 provider 默认名称：去 www. 前缀、取第一段。
//   api.r4.codes -> api；www.mcgrox.top -> mcgrox；裸 IP / 空串 -> null（由调用方回退）。
// 注意：不做 DNS/URL 解析（保持纯函数），入参为主机名字符串。
export function deriveProviderName(host) {
  if (typeof host !== "string") return null;
  let name = host.trim().toLowerCase();
  if (!name) return null;
  if (name.startsWith("www.")) name = name.slice(4);
  // 裸 IP（IPv4）不给名字，由调用方提示用户手输
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return null;
  const first = name.split(".")[0];
  // 主域第一段只保留安全的 [a-z0-9-] 字符，空结果视为失败
  const cleaned = first.replace(/[^a-z0-9-]/g, "");
  return cleaned || null;
}

// login 的协议 → opencode provider.npm 包映射。
// openai 兼容中转优先复用真实配置里的实际 npm 值（CLI 负责），查不到时用这个兜底。
export const OPENCODE_NPM_DEFAULTS = {
  openai: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
};

// 构造 opencode provider 块（**不含 apiKey**——key 由 CLI 写入时单独注入 options，
// 避免凭证流入纯函数层）。modelEntries 为 { id -> 规格对象 } 映射，规格对象由
// CLI 用 emitOpencode 的最小集产出（见 opencodeModelSpec / CLI login 流程）。
// 返回的块键序与 emitOpencode 一致：npm → options.baseURL → models。
export function buildOpencodeProvider({ name, baseURL, npm, protocol, modelEntries }) {
  if (typeof name !== "string" || !name) throw new Error("buildOpencodeProvider: name 必须为非空字符串");
  if (typeof baseURL !== "string" || !baseURL) throw new Error("buildOpencodeProvider: baseURL 必须为非空字符串");
  if (!Object.prototype.hasOwnProperty.call(OPENCODE_NPM_DEFAULTS, protocol)) {
    throw new Error(`buildOpencodeProvider: 未知协议 ${JSON.stringify(protocol)}（可选 openai|anthropic|gemini）`);
  }
  const block = {
    npm: typeof npm === "string" && npm ? npm : OPENCODE_NPM_DEFAULTS[protocol],
    options: { baseURL },
    models: {},
  };
  const entries = isDict(modelEntries) ? modelEntries : {};
  for (const id of Object.keys(entries).sort(cmpStr)) {
    // 规格对象必须是纯 dict（emitOpencode 的 payload 形状）；原样收编、按字母序排键
    const spec = entries[id];
    block.models[id] = isDict(spec) ? sortedObject(spec) : { name: id };
  }
  return block;
}

// --------------------------------------------------------------------------
// 凭证脱敏（audit 的硬要求：任何输出/错误信息都不得泄露 key/token/secret）
// --------------------------------------------------------------------------

// 凭证样式的 key 名：命中即整体跳过（任意嵌套深度）
const CREDENTIAL_KEY_RE = /(key|token|secret|password|auth|credential)/i;
const CREDENTIAL_KEY_EXTRA = new Set(["env", "environment", "headers"]);

// 与上面正则撞名的"非凭证"规格字段：maxTokens 之类是数值配置，必须保留才能完成
// audit 比对（值本身仍会经 scrub 兜底）。仅在"值确为数字"时豁免。
const NUMERIC_SPEC_FIELD_KEYS = new Set([
  "maxTokens",
  "max_tokens",
  "maxOutputTokens",
  "max_output_tokens",
]);

export function isCredentialKey(name) {
  const text = String(name);
  if (CREDENTIAL_KEY_EXTRA.has(text) || CREDENTIAL_KEY_EXTRA.has(text.toUpperCase())) return true;
  return CREDENTIAL_KEY_RE.test(text);
}

// 深拷贝并删除所有凭证样式的键（数组保持数组；字符串原样返回，由 scrub 兜底）。
export function stripCredentials(value) {
  if (Array.isArray(value)) return value.map((item) => stripCredentials(item));
  if (isDict(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      const numericSpec = NUMERIC_SPEC_FIELD_KEYS.has(String(key)) && isNum(item);
      if (!numericSpec && isCredentialKey(key)) continue;
      out[key] = stripCredentials(item);
    }
    return out;
  }
  return value;
}

// 凭证字符串兜底脱敏。宁可多脱敏，不可漏脱敏。
// 规则顺序有意义：先处理具名前缀，再处理 key=value，最后是长不透明串。
const SCRUB_RULES = [
  [/sk-or-v1-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/ark-[A-Za-z0-9-]{8,}/g, "[REDACTED]"],
  [/coder_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  // 保留 "Bearer"，只脱敏后面的值；引号/分隔符保留以免破坏 JSON 结构
  [/Bearer\s+[^\s"'`,;)]+/gi, "Bearer [REDACTED]"],
  // key/token/secret/... = <16+ 字符的值>；保留键名与分隔符（含可选引号）
  [
    /([A-Za-z0-9_-]*(?:key|token|secret|password|auth)[A-Za-z0-9_-]*\s*[:=]\s*)(["']?)([A-Za-z0-9_\-.]{16,})\2/gi,
    "$1$2[REDACTED]$2",
  ],
];

// 32+ 字符的全 [A-Za-z0-9+/=_-] 不透明串（无空格）
const OPAQUE_TOKEN_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;

// 输出脱敏。allow 是可选的"已知公开串"白名单（如 catalog 模型 id）：这些串会临时
// 占位，避免被凭证规则误伤（如公开 id `ark-code-latest` 撞上 ark- 前缀规则）。
// 仅当公开串"独立出现"时才保护：前后若仍是 token 字符，说明它只是更大串的一部分
// （可能是凭证），此时不做保护、照常脱敏。
export function scrub(text, allow) {
  let out = String(text === null || text === undefined ? "" : text);

  const placeholders = [];
  if (Array.isArray(allow)) {
    const seen = new Set();
    for (const token of allow) {
      if (typeof token !== "string" || !token || seen.has(token)) continue;
      seen.add(token);
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![A-Za-z0-9+/=_-])${escaped}(?![A-Za-z0-9+/=_-])`, "g");
      if (!pattern.test(out)) continue;
      const placeholder = `\u0001A${placeholders.length}\u0001`;
      out = out.replace(pattern, placeholder);
      placeholders.push([placeholder, token]);
    }
  }

  for (const [pattern, replacement] of SCRUB_RULES) out = out.replace(pattern, replacement);
  for (const [placeholder, token] of placeholders) out = out.split(placeholder).join(token);
  return out;
}

// --------------------------------------------------------------------------
// audit：配置 ↔ 官网规格审计（纯函数；文件/stdin 读取由 CLI 负责）
// --------------------------------------------------------------------------

const AUDIT_FIELD_LABELS = {
  context: "上下文",
  output: "最大输出",
  reasoning: "推理",
  efforts: "推理档位",
  temperature: "temperature",
  tool_call: "tool_call",
  attachment: "视觉",
  input: "输入模态",
  wire_api: "wire_api",
  budget: "思考预算",
};

const AUDIT_KIND_LABELS = { exact: "[OK]", alias: "[A]", legacy: "[L]", normalized: "[~]" };

const AUDIT_NOT_FOUND_TEXT = "未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）";

function asModelList(catalog) {
  return Array.isArray(catalog)
    ? catalog
    : isDict(catalog) && Array.isArray(catalog.models)
      ? catalog.models
      : [];
}

function isDeclared(value) {
  return value !== undefined && value !== null && value !== MISSING;
}

function numValue(value) {
  return isNum(value) ? value : undefined;
}

function boolValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function variantsEfforts(variants) {
  if (!isDict(variants)) return undefined;
  return Object.keys(variants);
}

function levelMapEfforts(levelMap) {
  if (!isDict(levelMap)) return undefined;
  const out = [];
  for (const value of Object.values(levelMap)) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

// 自动识别配置格式（返回 null 表示无法识别）：
//   1. opencode：顶层 provider 对象
//   2. pi：顶层 providers 对象，其值含 models 数组
//   3. generic：{models: [...]} / 裸数组（纯文本由调用方先判定）
export function detectConfigFormat(config) {
  if (isDict(config)) {
    if (isDict(config.provider)) return "opencode";
    if (isDict(config.providers)) {
      for (const value of Object.values(config.providers)) {
        if (isDict(value) && Array.isArray(value.models)) return "pi";
      }
    }
    if (Array.isArray(config.models)) return "generic";
    // claude code ~/.claude/settings.json：env 下出现 BASE_URL 或任一模型键
    if (isDict(config.env)) {
      const env = config.env;
      if (typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL) return "claude";
      for (const key of CLAUDE_MODEL_KEYS) {
        if (typeof env[key] === "string" && env[key]) return "claude";
      }
    }
    return null;
  }
  if (Array.isArray(config)) return "generic";
  return null;
}

export function extractConfigEntries(config, format) {
  const entries = [];
  if (format === "opencode") {
    const providers = isDict(config) && isDict(config.provider) ? config.provider : {};
    for (const providerName of Object.keys(providers).sort(cmpStr)) {
      const provider = providers[providerName];
      const models = isDict(provider) && isDict(provider.models) ? provider.models : {};
      for (const modelId of Object.keys(models).sort(cmpStr)) {
        const raw = isDict(models[modelId]) ? models[modelId] : {};
        const values = {};
        const context = numValue(dig(raw, ["limit", "context"]));
        const output = numValue(dig(raw, ["limit", "output"]));
        const efforts = variantsEfforts(dig(raw, ["variants"]));
        const reasoning = boolValue(dig(raw, ["reasoning"]));
        const attachment = boolValue(dig(raw, ["attachment"]));
        const temperature = boolValue(dig(raw, ["temperature"]));
        const toolCall = boolValue(dig(raw, ["tool_call"]));
        if (context !== undefined) values.context = context;
        if (output !== undefined) values.output = output;
        if (efforts !== undefined) values.efforts = efforts;
        if (reasoning !== undefined) values.reasoning = reasoning;
        if (attachment !== undefined) values.attachment = attachment;
        if (temperature !== undefined) values.temperature = temperature;
        if (toolCall !== undefined) values.tool_call = toolCall;
        entries.push({ input: modelId, provider: providerName, values });
      }
    }
  } else if (format === "pi") {
    const providers = isDict(config) && isDict(config.providers) ? config.providers : {};
    for (const providerName of Object.keys(providers).sort(cmpStr)) {
      const provider = providers[providerName];
      const list = isDict(provider) && Array.isArray(provider.models) ? provider.models : [];
      for (const raw of list) {
        if (!isDict(raw)) continue;
        const modelId = typeof raw.id === "string" && raw.id ? raw.id : null;
        if (!modelId) continue;
        const values = {};
        const context = numValue(raw.contextWindow);
        const output = numValue(raw.maxTokens);
        const efforts = levelMapEfforts(raw.thinkingLevelMap);
        const reasoning = boolValue(raw.reasoning);
        const input = Array.isArray(raw.input) ? raw.input.map((x) => String(x)) : undefined;
        if (context !== undefined) values.context = context;
        if (output !== undefined) values.output = output;
        if (efforts !== undefined) values.efforts = efforts;
        if (reasoning !== undefined) values.reasoning = reasoning;
        if (input !== undefined) values.input = input;
        entries.push({ input: modelId, provider: providerName, values });
      }
    }
  } else if (format === "codex") {
    // codex config.toml：整份配置描述「当前模型」一条（model / model_provider / wire_api / effort）
    const parsed = isDict(config) && ("model" in config || "model_provider" in config || "model_reasoning_effort" in config)
      ? config
      : parseCodexToml(config);
    const modelId = typeof parsed.model === "string" && parsed.model ? parsed.model : null;
    if (modelId) {
      const provider = typeof parsed.model_provider === "string" && parsed.model_provider ? parsed.model_provider : null;
      const values = {};
      if (typeof parsed.model_reasoning_effort === "string" && parsed.model_reasoning_effort) {
        values.effort = parsed.model_reasoning_effort;
      }
      const providerBlock = provider && isDict(parsed.providers) && isDict(parsed.providers[provider])
        ? parsed.providers[provider]
        : null;
      if (providerBlock && typeof providerBlock.wire_api === "string" && providerBlock.wire_api) {
        values.wire_api = providerBlock.wire_api;
      }
      entries.push({ input: modelId, provider, values });
    }
  } else if (format === "claude") {
    // claude code ~/.claude/settings.json：白名单提取 env 下的模型键；
    // AUTH_TOKEN 等凭证键根本不进入提取（调用方已先做 stripCredentials 兜底）。
    const env = isDict(config) && isDict(config.env) ? config.env : null;
    if (env) {
      const effort = typeof env.CLAUDE_CODE_EFFORT_LEVEL === "string" && env.CLAUDE_CODE_EFFORT_LEVEL
        ? env.CLAUDE_CODE_EFFORT_LEVEL
        : undefined;
      const rawBudget = env.MAX_THINKING_TOKENS;
      const budget = typeof rawBudget === "string" && /^\d+$/.test(rawBudget.trim())
        ? Number(rawBudget.trim())
        : isNum(rawBudget) ? rawBudget : undefined;
      for (const key of CLAUDE_MODEL_KEYS) {
        const value = env[key];
        if (typeof value !== "string" || !value) continue;
        const values = {};
        // MAX_THINKING_TOKENS / CLAUDE_CODE_EFFORT_LEVEL 是全局 env 值：只挂到主模型，
        // 避免把主模型的档位误判成其它角色模型（haiku/sonnet/…）的配置值。
        if (key === "ANTHROPIC_MODEL") {
          if (effort !== undefined) values.effort = effort;
          if (budget !== undefined) values.budget = budget;
        }
        entries.push({ input: value, provider: key, values });
      }
    }
  } else if (format === "generic") {
    const items = typeof config === "string"
      ? String(config).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      : Array.isArray(config)
        ? config
        : isDict(config) && Array.isArray(config.models)
          ? config.models
          : [];
    for (const item of items) {
      let modelId = null;
      if (typeof item === "string") modelId = item.trim();
      else if (isDict(item) && typeof item.id === "string") modelId = item.id.trim();
      if (!modelId) continue;
      entries.push({ input: modelId, provider: null, values: {} });
    }
  }
  return entries;
}

function auditMatch(field, config, official) {
  return { field, config, official, status: "match", note: null };
}

function auditUnknown(field, config, official) {
  return { field, config, official: official === MISSING ? null : official, status: "unknown", note: "官网未文档化" };
}

function compareAuditNum(field, config, official) {
  if (!isDeclared(official)) return auditUnknown(field, config, official);
  if (!isNum(official)) return { field, config, official, status: "diff", note: "官网值非数值" };
  if (config === official) return auditMatch(field, config, official);
  const pct = official !== 0 ? (Math.abs(official - config) / official) * 100 : null;
  const direction = config < official ? "偏小" : "偏大";
  return {
    field,
    config,
    official,
    status: "diff",
    note: pct === null ? direction : `${direction} ${pct.toFixed(1)}%`,
  };
}

function compareAuditBool(field, config, official) {
  if (!isDeclared(official)) return auditUnknown(field, config, official);
  if (typeof official !== "boolean") return { field, config, official, status: "diff", note: "官网值非布尔" };
  if (config === official) return auditMatch(field, config, official);
  return { field, config, official, status: "diff", note: config === true ? "不支持" : "官方支持" };
}

function compareAuditLevels(field, config, official) {
  if (!Array.isArray(official)) return auditUnknown(field, config, official);
  const cfg = Array.isArray(config) ? config : [];
  const missing = official.filter((x) => !cfg.includes(x));
  const extra = cfg.filter((x) => !official.includes(x));
  if (!missing.length && !extra.length) return auditMatch(field, cfg, official);
  const parts = [];
  if (missing.length) parts.push(`缺 ${missing.join(",")}`);
  if (extra.length) parts.push(`多 ${extra.join(",")}`);
  return { field, config: cfg, official, status: "diff", note: parts.join("，") };
}

// pi 的 input 数组 vs 由官网能力推导的模态（text 恒有；vision→image）。
// pi 的 Model.input 类型为 ("text" | "image")[]（见 pi-ai/dist/types.d.ts），
// 不支持 pdf，因此不比较 pdf 维度（历史上把 pdf 当官方模态属误报）。
function compareAuditInput(field, config, entry) {
  const vision = dig(entry, ["vision"]);
  const cfg = Array.isArray(config) ? config : [];
  const official = ["text"];
  if (vision === true) official.push("image");

  const missing = official.filter((x) => !cfg.includes(x));
  const extras = cfg.filter((x) => !official.includes(x));
  const knownExtras = [];
  const unknownExtras = [];
  for (const item of extras) {
    if (item === "image" && !isDeclared(vision)) unknownExtras.push(item);
    else knownExtras.push(item);
  }
  if (missing.length || knownExtras.length) {
    const parts = [];
    if (missing.length) parts.push(`缺 ${missing.join(",")}`);
    if (knownExtras.length) parts.push(`多 ${knownExtras.join(",")}`);
    return { field, config: cfg, official, status: "diff", note: parts.join("，") };
  }
  if (unknownExtras.length) return { field, config: cfg, official: null, status: "unknown", note: "官网未文档化" };
  return auditMatch(field, cfg, official);
}

// 单值 ∈ 官方档位集合（codex 的 model_reasoning_effort / claude 的 CLAUDE_CODE_EFFORT_LEVEL）
function compareAuditMember(field, config, official) {
  if (!Array.isArray(official) || !official.length) return auditUnknown(field, config, official);
  const value = String(config);
  if (official.includes(value)) return auditMatch(field, value, official);
  return { field, config: value, official, status: "diff", note: `不在官方档位（${official.join(",")}）` };
}

// codex wire_api vs api_protocol 可映射集合
function compareAuditWire(config, entry) {
  const official = codexWireOptions(entry);
  if (!official.length) return auditUnknown("wire_api", config, null);
  const value = String(config);
  if (official.includes(value)) return auditMatch("wire_api", value, official);
  return { field: "wire_api", config: value, official, status: "diff", note: `需 ${official[0]}` };
}

// claude MAX_THINKING_TOKENS vs 官方 thinking_budget 区间
function compareAuditBudget(config, entry) {
  const tb = valOrNone(entry, ["reasoning", "thinking_budget"]);
  if (!isDict(tb) || (!isNum(tb.min) && !isNum(tb.max))) return auditUnknown("budget", config, null);
  const min = isNum(tb.min) ? tb.min : null;
  const max = isNum(tb.max) ? tb.max : null;
  const bounds = [];
  if (min !== null) bounds.push(groupThousands(min));
  if (max !== null) bounds.push(groupThousands(max));
  const rangeText = bounds.join("–");
  const value = isNum(config) ? config : Number(config);
  if (!isNum(value)) return { field: "budget", config, official: rangeText, status: "diff", note: "配置值非数字" };
  if (min !== null && value < min) {
    return { field: "budget", config: value, official: rangeText, status: "diff", note: `低于官方下限（${rangeText}）` };
  }
  if (max !== null && value > max) {
    return { field: "budget", config: value, official: rangeText, status: "diff", note: `超出官方上限（${rangeText}）` };
  }
  return auditMatch("budget", value, rangeText);
}

// claude settings.json 的白名单投影：只保留协议/规格相关的 env 键。
// stripCredentials 会整段删除 env（凭证容器），因此 claude 必须先投影再提取——
// AUTH_TOKEN 等凭证键在这个函数里就被丢弃，永不进入后续条目/计划对象。
function projectClaudeEnv(config) {
  if (!isDict(config) || !isDict(config.env)) return config;
  const env = {};
  if (typeof config.env.ANTHROPIC_BASE_URL === "string") env.ANTHROPIC_BASE_URL = config.env.ANTHROPIC_BASE_URL;
  for (const key of CLAUDE_MODEL_KEYS) {
    if (typeof config.env[key] === "string") env[key] = config.env[key];
  }
  if (typeof config.env.MAX_THINKING_TOKENS === "string") env.MAX_THINKING_TOKENS = config.env.MAX_THINKING_TOKENS;
  if (typeof config.env.CLAUDE_CODE_EFFORT_LEVEL === "string") env.CLAUDE_CODE_EFFORT_LEVEL = config.env.CLAUDE_CODE_EFFORT_LEVEL;
  const out = {};
  for (const key of Object.keys(config)) out[key] = key === "env" ? env : config[key];
  return out;
}

function auditOneModel(models, entry, format) {
  const match = matchModel(models, entry.input);
  const result = {
    input: entry.input,
    provider: entry.provider ?? null,
    kind: match.entry ? match.kind : "none",
    matchedId: match.matchedId,
    suggestion: match.entry ? null : match.suggestion,
    diffs: [],
    clean: false,
  };
  if (!match.entry) return result;

  const e = match.entry;
  const v = entry.values || {};
  if (format === "opencode") {
    if (v.context !== undefined) result.diffs.push(compareAuditNum("context", v.context, valOrNone(e, ["context_window"])));
    if (v.output !== undefined) result.diffs.push(compareAuditNum("output", v.output, valOrNone(e, ["max_output_tokens"])));
    if (v.reasoning !== undefined) result.diffs.push(compareAuditBool("reasoning", v.reasoning, valOrNone(e, ["reasoning", "supported"])));
    if (v.efforts !== undefined) result.diffs.push(compareAuditLevels("efforts", v.efforts, valOrNone(e, ["reasoning", "effort_values"])));
    if (v.temperature !== undefined) result.diffs.push(compareAuditBool("temperature", v.temperature, valOrNone(e, ["sampling", "temperature", "supported"])));
    if (v.tool_call !== undefined) result.diffs.push(compareAuditBool("tool_call", v.tool_call, valOrNone(e, ["tools", "function_calling"])));
    if (v.attachment !== undefined) result.diffs.push(compareAuditBool("attachment", v.attachment, valOrNone(e, ["vision"])));
  } else if (format === "pi") {
    if (v.context !== undefined) result.diffs.push(compareAuditNum("context", v.context, valOrNone(e, ["context_window"])));
    if (v.output !== undefined) result.diffs.push(compareAuditNum("output", v.output, valOrNone(e, ["max_output_tokens"])));
    if (v.reasoning !== undefined) result.diffs.push(compareAuditBool("reasoning", v.reasoning, valOrNone(e, ["reasoning", "supported"])));
    if (v.efforts !== undefined) result.diffs.push(compareAuditLevels("efforts", v.efforts, valOrNone(e, ["reasoning", "effort_values"])));
    if (v.input !== undefined) result.diffs.push(compareAuditInput("input", v.input, e));
  } else if (format === "codex") {
    if (v.effort !== undefined) result.diffs.push(compareAuditMember("efforts", v.effort, valOrNone(e, ["reasoning", "effort_values"])));
    if (v.wire_api !== undefined) result.diffs.push(compareAuditWire(v.wire_api, e));
  } else if (format === "claude") {
    if (v.effort !== undefined) result.diffs.push(compareAuditMember("efforts", v.effort, valOrNone(e, ["reasoning", "effort_values"])));
    if (v.budget !== undefined) result.diffs.push(compareAuditBudget(v.budget, e));
  }
  result.clean = result.diffs.every((d) => d.status === "match");
  return result;
}

export function auditConfig(catalog, config, format) {
  const models = asModelList(catalog);
  // 防御性：先剥离凭证键，再做白名单字段提取（凭证永远不会进入条目）。
  // claude 的 env 是「凭证容器」（含 AUTH_TOKEN）：先做白名单投影，而不是整段删除。
  const safe = format === "claude" ? projectClaudeEnv(config) : stripCredentials(config);
  const extracted = extractConfigEntries(safe, format);
  const entries = extracted.map((entry) => auditOneModel(models, entry, format));

  const inputCounts = new Map();
  for (const entry of entries) inputCounts.set(entry.input, (inputCounts.get(entry.input) || 0) + 1);
  for (const entry of entries) entry.duplicate = (inputCounts.get(entry.input) || 0) > 1;

  const summary = {
    total: entries.length,
    exact: 0,
    alias: 0,
    legacy: 0,
    normalized: 0,
    unmatched: 0,
    with_diffs: 0,
    diff_items: 0,
    clean: 0,
  };
  for (const entry of entries) {
    if (entry.kind === "none") summary.unmatched += 1;
    else if (summary[entry.kind] !== undefined) summary[entry.kind] += 1;
    if (entry.clean) {
      summary.clean += 1;
    } else {
      summary.with_diffs += 1;
      summary.diff_items += entry.matchedId
        ? entry.diffs.filter((d) => d.status !== "match").length
        : 1;
    }
  }
  return { format, entries, summary };
}

function auditValueText(value) {
  if (!isDeclared(value)) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length ? value.map((x) => String(x)).join(",") : "(空)";
  if (isNum(value)) return groupThousands(value);
  return String(value);
}

export function renderAudit(report, file) {
  const label = file === "-" ? "<stdin>" : String(file);
  const lines = [`审计 ${label}（识别为 ${report.format} 配置）`, "═".repeat(40)];

  let labelWidth = 0;
  for (const entry of report.entries) {
    for (const diff of entry.diffs) {
      labelWidth = Math.max(labelWidth, displayWidth(AUDIT_FIELD_LABELS[diff.field] || diff.field));
    }
  }

  for (const entry of report.entries) {
    if (!entry.matchedId) {
      lines.push(`[?] ${entry.input} → ${AUDIT_NOT_FOUND_TEXT}`);
      if (entry.suggestion) lines.push(`    最接近: ${entry.suggestion}`);
      lines.push("");
      continue;
    }

    const kindLabel = AUDIT_KIND_LABELS[entry.kind] || "[OK]";
    const providerText = entry.duplicate && entry.provider ? `（${entry.provider}）` : "";
    const arrow = entry.input === entry.matchedId ? "" : ` → ${entry.matchedId}`;
    lines.push(`${kindLabel} ${entry.input}${providerText}${arrow}`);

    if (!entry.diffs.length) {
      lines.push("    与官网一致 ✓（配置未声明可比对字段）");
      lines.push("");
      continue;
    }

    const fields = entry.diffs.map((d) => AUDIT_FIELD_LABELS[d.field] || d.field);
    if (entry.diffs.every((d) => d.status === "match")) {
      lines.push(`    与官网一致 ✓（${fields.join("、")}）`);
      lines.push("");
      continue;
    }

    // 同一模型内共享列宽：配置侧 / 官网侧各算一次，使数值与布尔值纵向对齐
    let configWidth = 0;
    let officialWidth = 0;
    for (const diff of entry.diffs) {
      configWidth = Math.max(configWidth, displayWidth(auditValueText(diff.config)));
      officialWidth = Math.max(officialWidth, displayWidth(auditValueText(diff.official)));
    }

    for (const diff of entry.diffs) {
      const name = AUDIT_FIELD_LABELS[diff.field] || diff.field;
      const configText = pad(auditValueText(diff.config), configWidth, "right");
      const officialText = pad(auditValueText(diff.official), officialWidth, "right");
      const status = diff.status === "match"
        ? "✓"
        : diff.status === "diff"
          ? `⚠ ${diff.note}`
          : `? ${diff.note}`;
      lines.push(`    ${pad(name, labelWidth)}  ${configText} → ${officialText}   ${status}`);
    }
    if (entry.diffs.some((d) => d.status === "diff")) {
      const emit = { pi: "pi", codex: "codex", claude: "claude-env" }[report.format] || "opencode";
      lines.push(`    修正：node apifix.mjs ${entry.input} --emit ${emit}`);
    }
    lines.push("");
  }

  lines.push("─".repeat(40));
  const parts = [];
  for (const [kind, text] of [["exact", "精确"], ["alias", "别名"], ["legacy", "旧版 id"], ["normalized", "归一化"]]) {
    if (report.summary[kind]) parts.push(`${report.summary[kind]} ${text}`);
  }
  if (report.summary.unmatched) parts.push(`${report.summary.unmatched} 未收录`);
  lines.push(`共 ${report.summary.total} 个模型${parts.length ? "：" + parts.join(" · ") : ""}`);
  if (report.summary.with_diffs === 0) {
    lines.push("全部与官网一致 ✓");
  } else {
    lines.push(`${report.summary.with_diffs} 个模型存在差异（共 ${report.summary.diff_items} 项）`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// fix：配置修复计划（纯函数；文件读写 / 询问由 CLI 负责）
//
// 保守原则：
//   - 只修正配置中「已声明」的可修字段，未声明的字段绝不新增；
//   - 官方值 null / 缺失（MISSING）→ 记入 skipped（官网未文档化），不臆造；
//   - 只触及规格字段，永不读写 apiKey / token 等凭证。
// --------------------------------------------------------------------------

// 纯数据深拷贝（仅处理 JSON 可序列化值；core 零 Node API）
function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// 配置中该路径是否已声明（含显式 null）
function declaredAt(raw, path) {
  return dig(raw, path) !== MISSING;
}

// 数值字段：仅当配置已声明时比对；官方未文档化/非数值 → skip。
function planNumChange(entry, field, path, raw, official) {
  if (!declaredAt(raw, path)) return;
  const current = dig(raw, path);
  if (!isDeclared(official)) {
    entry.skipped.push({ field, reason: "官网未文档化" });
    return;
  }
  if (!isNum(official)) {
    entry.skipped.push({ field, reason: "官网值非数值" });
    return;
  }
  if (current === official) return;
  entry.changes.push({ field, path: path.slice(), from: current, to: official });
}

// 布尔字段：仅当配置已声明时比对；官方未文档化/非布尔 → skip。
function planBoolChange(entry, field, path, raw, official) {
  if (!declaredAt(raw, path)) return;
  const current = dig(raw, path);
  if (!isDeclared(official)) {
    entry.skipped.push({ field, reason: "官网未文档化" });
    return;
  }
  if (typeof official !== "boolean") {
    entry.skipped.push({ field, reason: "官网值非布尔" });
    return;
  }
  if (current === official) return;
  entry.changes.push({ field, path: path.slice(), from: current, to: official });
}

// opencode variants：缺失档位补 {reasoningEffort:<档位>}；多余档位若为「纯 effort 形状」
// 则删除，否则保留并记 skipped；官方档位为空/未文档化 → 整体 skip。
function planOpencodeVariants(entry, raw, e) {
  if (!declaredAt(raw, ["variants"])) return;
  const efforts = valOrNone(e, ["reasoning", "effort_values"]);
  if (!Array.isArray(efforts) || !efforts.length) {
    entry.skipped.push({ field: "efforts", reason: "官网未文档化" });
    return;
  }
  const current = isDict(raw.variants) ? raw.variants : {};
  const currentKeys = Object.keys(current);
  const next = {};
  for (const key of currentKeys) next[key] = current[key];

  let changed = false;
  for (const level of efforts) {
    if (!hasOwn(next, level)) {
      next[level] = { reasoningEffort: level };
      changed = true;
    }
  }
  for (const key of currentKeys) {
    if (efforts.includes(key)) continue;
    const value = current[key];
    const pure = isDict(value) && Object.keys(value).length === 1 && hasOwn(value, "reasoningEffort");
    if (pure) {
      delete next[key];
      changed = true;
    } else {
      entry.skipped.push({ field: "efforts", reason: `保留自定义变体 ${key}` });
    }
  }
  if (!changed) return;
  entry.changes.push({ field: "efforts", path: ["variants"], from: cloneValue(current), to: cloneValue(next) });
}

function planOpencodeModel(entry, raw, e) {
  planNumChange(entry, "context", ["limit", "context"], raw, valOrNone(e, ["context_window"]));
  planNumChange(entry, "output", ["limit", "output"], raw, valOrNone(e, ["max_output_tokens"]));
  planBoolChange(entry, "reasoning", ["reasoning"], raw, valOrNone(e, ["reasoning", "supported"]));
  planBoolChange(entry, "temperature", ["temperature"], raw, valOrNone(e, ["sampling", "temperature", "supported"]));
  planBoolChange(entry, "tool_call", ["tool_call"], raw, valOrNone(e, ["tools", "function_calling"]));
  planBoolChange(entry, "attachment", ["attachment"], raw, valOrNone(e, ["vision"]));
  planOpencodeVariants(entry, raw, e);
}

// pi thinkingLevelMap：与 emitPi 相同的 7 键推导逻辑，整体替换；
// 原 map 含 7 键之外的键 → 记 skipped（仍会替换掉）。
function planPiLevelMap(entry, raw, e) {
  if (!declaredAt(raw, ["thinkingLevelMap"])) return;
  const supported = valOrNone(e, ["reasoning", "supported"]);
  if (!isDeclared(supported)) {
    entry.skipped.push({ field: "efforts", reason: "官网未文档化" });
    return;
  }
  const current = isDict(raw.thinkingLevelMap) ? raw.thinkingLevelMap : {};
  const next = piThinkingLevelMap(e);

  const extraKeys = Object.keys(current).filter((key) => !PI_LEVELS.includes(key));
  for (const key of extraKeys) {
    entry.skipped.push({ field: "efforts", reason: `7 键之外的档位 ${key}（整体替换后不再保留）` });
  }
  let same = extraKeys.length === 0;
  if (same) {
    for (const level of PI_LEVELS) {
      const a = current[level] === undefined ? null : current[level];
      const b = next[level] === undefined ? null : next[level];
      if (a !== b) { same = false; break; }
    }
  }
  if (same) return;
  entry.changes.push({ field: "efforts", path: ["thinkingLevelMap"], from: cloneValue(current), to: cloneValue(next) });
}

// pi input：["text"] + (vision === true ? ["image"] : [])。pi 不支持 pdf，不处理 pdf。
function planPiInput(entry, raw, e) {
  if (!declaredAt(raw, ["input"])) return;
  const vision = valOrNone(e, ["vision"]);
  if (!isDeclared(vision)) {
    entry.skipped.push({ field: "input", reason: "官网未文档化" });
    return;
  }
  const next = vision === true ? ["text", "image"] : ["text"];
  const current = Array.isArray(raw.input) ? raw.input.map((x) => String(x)) : [];
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  entry.changes.push({ field: "input", path: ["input"], from: cloneValue(raw.input), to: next });
}

function planPiModel(entry, raw, e) {
  planNumChange(entry, "context", ["contextWindow"], raw, valOrNone(e, ["context_window"]));
  planNumChange(entry, "output", ["maxTokens"], raw, valOrNone(e, ["max_output_tokens"]));
  planBoolChange(entry, "reasoning", ["reasoning"], raw, valOrNone(e, ["reasoning", "supported"]));
  planPiLevelMap(entry, raw, e);
  planPiInput(entry, raw, e);
}

// claude code 的 env 白名单可修字段：CLAUDE_CODE_EFFORT_LEVEL（档位成员）
// 与 MAX_THINKING_TOKENS（区间收窄）。AUTH_TOKEN / BASE_URL 永不进入计划。
function planClaudeEnv(entry, env, e) {
  const effortRaw = env.CLAUDE_CODE_EFFORT_LEVEL;
  if (typeof effortRaw === "string" && effortRaw) {
    const official = valOrNone(e, ["reasoning", "effort_values"]);
    if (!Array.isArray(official) || !official.length) {
      entry.skipped.push({ field: "efforts", reason: "官网未文档化" });
    } else if (!official.includes(effortRaw)) {
      const def = valOrNone(e, ["reasoning", "default_effort"]);
      if (typeof def === "string" && official.includes(def)) {
        entry.changes.push({ field: "efforts", path: ["env", "CLAUDE_CODE_EFFORT_LEVEL"], from: effortRaw, to: def });
      } else {
        entry.skipped.push({ field: "efforts", reason: "官网未文档化 default_effort，无法确定目标档位" });
      }
    }
  }

  const budgetRaw = env.MAX_THINKING_TOKENS;
  if (typeof budgetRaw === "string" && /^\d+$/.test(budgetRaw.trim())) {
    const tb = valOrNone(e, ["reasoning", "thinking_budget"]);
    if (!isDict(tb) || (!isNum(tb.min) && !isNum(tb.max))) {
      entry.skipped.push({ field: "budget", reason: "官网未文档化" });
      return;
    }
    const value = Number(budgetRaw.trim());
    const min = isNum(tb.min) ? tb.min : null;
    const max = isNum(tb.max) ? tb.max : null;
    if ((min !== null && value < min) || (max !== null && value > max)) {
      const target = min !== null && value < min ? min : max;
      entry.changes.push({ field: "budget", path: ["env", "MAX_THINKING_TOKENS"], from: budgetRaw, to: String(target) });
    }
  }
}

// 计算修复计划：对比配置与 catalog 官网规格，给出「可自动修复」与「需人工确认」两类项。
// 返回 entries 仅含存在可修项 / 跳过项 / 未收录的模型（其余视为已一致）。
export function planConfigFixes(catalog, config, format) {
  const models = asModelList(catalog);
  // 防御性：先剥离凭证键再做字段提取，凭证永不进入计划对象。
  // claude 的 env 含 AUTH_TOKEN：走白名单投影（projectClaudeEnv）而不是整段删除。
  const safe = format === "claude" ? projectClaudeEnv(config) : stripCredentials(config);
  const extracted = extractConfigEntries(safe, format);
  const inputCounts = new Map();
  for (const item of extracted) inputCounts.set(item.input, (inputCounts.get(item.input) || 0) + 1);

  const all = [];

  if (format === "opencode") {
    const providers = isDict(safe) && isDict(safe.provider) ? safe.provider : {};
    for (const providerName of Object.keys(providers).sort(cmpStr)) {
      const provider = providers[providerName];
      const modelMap = isDict(provider) && isDict(provider.models) ? provider.models : {};
      for (const modelId of Object.keys(modelMap).sort(cmpStr)) {
        const raw = isDict(modelMap[modelId]) ? modelMap[modelId] : {};
        const match = matchModel(models, modelId);
        const entry = {
          input: modelId,
          provider: providerName,
          kind: match.entry ? match.kind : "none",
          matchedId: match.matchedId,
          suggestion: match.entry ? null : match.suggestion,
          duplicate: (inputCounts.get(modelId) || 0) > 1,
          ref: { provider: providerName, key: modelId },
          changes: [],
          skipped: [],
        };
        if (match.entry) planOpencodeModel(entry, raw, match.entry);
        all.push(entry);
      }
    }
  } else if (format === "pi") {
    const providers = isDict(safe) && isDict(safe.providers) ? safe.providers : {};
    for (const providerName of Object.keys(providers).sort(cmpStr)) {
      const provider = providers[providerName];
      const list = isDict(provider) && Array.isArray(provider.models) ? provider.models : [];
      for (let index = 0; index < list.length; index++) {
        const raw = list[index];
        if (!isDict(raw)) continue;
        const modelId = typeof raw.id === "string" && raw.id ? raw.id : null;
        if (!modelId) continue;
        const match = matchModel(models, modelId);
        const entry = {
          input: modelId,
          provider: providerName,
          kind: match.entry ? match.kind : "none",
          matchedId: match.matchedId,
          suggestion: match.entry ? null : match.suggestion,
          duplicate: (inputCounts.get(modelId) || 0) > 1,
          ref: { provider: providerName, index },
          changes: [],
          skipped: [],
        };
        if (match.entry) planPiModel(entry, raw, match.entry);
        all.push(entry);
      }
    }
  } else if (format === "claude") {
    // claude code：env 下每个模型键各登记一条；只有主模型（ANTHROPIC_MODEL）有可修字段
    const env = isDict(safe) && isDict(safe.env) ? safe.env : null;
    for (const key of CLAUDE_MODEL_KEYS) {
      const value = env ? env[key] : null;
      if (typeof value !== "string" || !value) continue;
      const match = matchModel(models, value);
      const entry = {
        input: value,
        provider: key,
        kind: match.entry ? match.kind : "none",
        matchedId: match.matchedId,
        suggestion: match.entry ? null : match.suggestion,
        duplicate: false,
        ref: { env: true },
        changes: [],
        skipped: [],
      };
      if (match.entry && key === "ANTHROPIC_MODEL") planClaudeEnv(entry, env, match.entry);
      all.push(entry);
    }
  } else {
    // generic / 未知格式：仅登记模型，无可自动修复字段
    for (const item of extracted) {
      const match = matchModel(models, item.input);
      all.push({
        input: item.input,
        provider: item.provider,
        kind: match.entry ? match.kind : "none",
        matchedId: match.matchedId,
        suggestion: match.entry ? null : match.suggestion,
        duplicate: (inputCounts.get(item.input) || 0) > 1,
        ref: null,
        changes: [],
        skipped: [],
      });
    }
  }

  const entries = all.filter((entry) => !entry.matchedId || entry.changes.length || entry.skipped.length);

  const summary = { total: all.length, fixable_models: 0, change_items: 0, skipped_items: 0, unmatched: 0 };
  for (const entry of all) {
    if (!entry.matchedId) summary.unmatched += 1;
    if (entry.changes.length) summary.fixable_models += 1;
    summary.change_items += entry.changes.length;
    summary.skipped_items += entry.skipped.length;
  }

  return { format, entries, summary };
}

// 深拷贝配置并仅应用 plan.changes（用 ref 定位模型，用 path 定位字段）。
// 不修改入参；凭证字段原样保留（从不读取或改写）。
export function applyConfigFixes(config, plan) {
  const next = cloneValue(config);
  const format = plan && plan.format;
  for (const entry of (plan && plan.entries) || []) {
    if (!entry.changes || !entry.changes.length || !entry.ref) continue;
    let root = null;
    if (format === "opencode") {
      const provider = isDict(next) && isDict(next.provider) ? next.provider[entry.ref.provider] : null;
      root = isDict(provider) && isDict(provider.models) ? provider.models[entry.ref.key] : null;
    } else if (format === "pi") {
      const provider = isDict(next) && isDict(next.providers) ? next.providers[entry.ref.provider] : null;
      root = isDict(provider) && Array.isArray(provider.models) ? provider.models[entry.ref.index] : null;
    } else if (format === "claude") {
      // claude：路径从根开始（["env", KEY]），env 必须已存在（不新增结构）
      root = isDict(next) && isDict(next.env) ? next : null;
    }
    if (!isDict(root)) continue;
    for (const change of entry.changes) {
      let cur = root;
      for (let i = 0; i < change.path.length - 1; i++) {
        const key = change.path[i];
        if (!isDict(cur[key])) cur[key] = {};
        cur = cur[key];
      }
      cur[change.path[change.path.length - 1]] = cloneValue(change.to);
    }
  }
  return next;
}

// 修复计划里的值渲染：对象按「变体键」或「档位=值」两种形状呈现（风格对齐 audit）。
function fixValueText(value) {
  if (isDict(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return "(空)";
    if (keys.every((key) => isDict(value[key]))) return keys.join(",");
    const parts = [];
    for (const key of keys) {
      const item = value[key];
      if (item === null || item === undefined) continue;
      parts.push(`${key}=${isDict(item) ? JSON.stringify(item) : item}`);
    }
    return parts.length ? parts.join(",") : "(空)";
  }
  return auditValueText(value);
}

// 文本修复计划：按模型分组，仅列出有可修项或跳过项的模型（风格参照 renderAudit）。
export function renderFixPlan(plan, file) {
  const label = file === "-" ? "<stdin>" : String(file);
  const lines = [`修复 ${label}（识别为 ${plan.format} 配置）`, "═".repeat(40)];

  const shown = plan.entries.filter((entry) => entry.matchedId && (entry.changes.length || entry.skipped.length));

  let labelWidth = 0;
  for (const entry of shown) {
    for (const change of entry.changes) labelWidth = Math.max(labelWidth, displayWidth(AUDIT_FIELD_LABELS[change.field] || change.field));
    for (const skip of entry.skipped) labelWidth = Math.max(labelWidth, displayWidth(AUDIT_FIELD_LABELS[skip.field] || skip.field));
  }

  for (const entry of shown) {
    const kindLabel = AUDIT_KIND_LABELS[entry.kind] || "[OK]";
    const providerText = entry.duplicate && entry.provider ? `（${entry.provider}）` : "";
    const arrow = entry.input === entry.matchedId ? "" : ` → ${entry.matchedId}`;
    lines.push(`${kindLabel} ${entry.input}${providerText}${arrow}`);

    let fromWidth = 0;
    let toWidth = 0;
    for (const change of entry.changes) {
      fromWidth = Math.max(fromWidth, displayWidth(fixValueText(change.from)));
      toWidth = Math.max(toWidth, displayWidth(fixValueText(change.to)));
    }
    for (const change of entry.changes) {
      const name = AUDIT_FIELD_LABELS[change.field] || change.field;
      const fromText = pad(fixValueText(change.from), fromWidth, "right");
      const toText = pad(fixValueText(change.to), toWidth, "right");
      lines.push(`    ${pad(name, labelWidth)}  ${fromText} → ${toText}`);
    }
    for (const skip of entry.skipped) {
      const name = AUDIT_FIELD_LABELS[skip.field] || skip.field;
      lines.push(`    ${pad(name, labelWidth)}  ? ${skip.reason}`);
    }
    lines.push("");
  }

  lines.push("─".repeat(40));
  const s = plan.summary;
  const parts = [];
  if (s.fixable_models) parts.push(`${s.fixable_models} 个模型可修复（${s.change_items} 项）`);
  if (s.skipped_items) parts.push(`${s.skipped_items} 项需人工确认`);
  if (s.unmatched) parts.push(`${s.unmatched} 未收录`);
  lines.push(`共 ${s.total} 个模型${parts.length ? "：" + parts.join(" · ") : ""}`);
  if (s.change_items === 0 && s.skipped_items === 0 && s.unmatched === 0) lines.push("全部与官网一致 ✓");
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// search：按能力 / 价格 / 厂商 / 生命周期检索（纯函数）
// --------------------------------------------------------------------------

const SEARCH_HEADERS = ["id", "vendor", "lifecycle", "ctx", "output", "effort", "in$/M", "out$/M", "caps"];
const SEARCH_ALIGN = ["left", "left", "left", "right", "right", "left", "right", "right", "left"];

function searchLifecycleMark(lifecycle) {
  if (lifecycle === "legacy") return "(legacy)";
  if (lifecycle === "retired") return "(retired)";
  if (lifecycle === "unreleased") return "(unreleased)";
  if (lifecycle === null || lifecycle === undefined) return "?";
  return "";
}

function priceText(value) {
  if (!isNum(value)) return "—";
  return `$${Number(value.toFixed(4))}`;
}

function numText(value) {
  return isNum(value) ? groupThousands(value) : "—";
}

function searchCaps(row) {
  return [
    row.vision === true ? "V" : "-",
    row.reasoning === true ? "R" : "-",
    row.tool_call === true ? "T" : "-",
    row.pdf === true ? "P" : "-",
  ].join("");
}

function searchEffortText(row) {
  if (Array.isArray(row.effort_values) && row.effort_values.length) return row.effort_values.join(",");
  if (row.reasoning === false) return "不支持";
  return "—";
}

function nullsLast(a, b, direction) {
  const aNull = !isNum(a);
  const bNull = !isNum(b);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return direction * (a - b);
}

export function searchModels(catalog, filters) {
  const models = asModelList(catalog);
  const opts = filters || {};
  const rows = [];

  for (const raw of models) {
    const entry = isDict(raw) ? raw : {};
    const reasoning = asDict(entry.reasoning);
    const tools = asDict(entry.tools);
    const cost = isDict(entry.cost) ? entry.cost : null;

    if (opts.vision && entry.vision !== true) continue;
    if (opts.reasoning && reasoning.supported !== true) continue;
    if (opts.toolCall && tools.function_calling !== true) continue;
    if (opts.pdf && entry.pdf !== true) continue;
    if (opts.minContext !== undefined && opts.minContext !== null) {
      if (!isNum(entry.context_window) || entry.context_window < opts.minContext) continue;
    }
    if (opts.maxInputPrice !== undefined && opts.maxInputPrice !== null) {
      if (!cost || !isNum(cost.input) || cost.input > opts.maxInputPrice) continue;
    }
    if (opts.maxOutputPrice !== undefined && opts.maxOutputPrice !== null) {
      if (!cost || !isNum(cost.output) || cost.output > opts.maxOutputPrice) continue;
    }
    if (Array.isArray(opts.vendors) && opts.vendors.length && !opts.vendors.includes(String(entry.vendor))) continue;
    if (Array.isArray(opts.lifecycles) && opts.lifecycles.length && !opts.lifecycles.includes(String(entry.lifecycle))) continue;

    rows.push({
      id: entry.id ?? null,
      vendor: entry.vendor ?? null,
      family: entry.family ?? null,
      lifecycle: entry.lifecycle ?? null,
      verified: entry.verified ?? null,
      context_window: entry.context_window ?? null,
      max_output_tokens: entry.max_output_tokens ?? null,
      reasoning: reasoning.supported ?? null,
      effort_values: Array.isArray(reasoning.effort_values) ? reasoning.effort_values.slice() : null,
      default_effort: reasoning.default_effort ?? null,
      vision: entry.vision ?? null,
      pdf: entry.pdf ?? null,
      tool_call: tools.function_calling ?? null,
      cost,
    });
  }

  const sort = opts.sort || "price";
  const byId = (a, b) => cmpStr(String(a.id || ""), String(b.id || ""));
  if (sort === "context") {
    rows.sort((a, b) => nullsLast(a.context_window, b.context_window, -1) || byId(a, b));
  } else if (sort === "output") {
    rows.sort((a, b) => nullsLast(a.max_output_tokens, b.max_output_tokens, -1) || byId(a, b));
  } else if (sort === "id") {
    rows.sort(byId);
  } else {
    rows.sort((a, b) =>
      nullsLast(a.cost ? a.cost.input : null, b.cost ? b.cost.input : null, 1) ||
      nullsLast(a.cost ? a.cost.output : null, b.cost ? b.cost.output : null, 1) ||
      byId(a, b));
  }

  const limited = isNum(opts.limit) && opts.limit >= 0 ? rows.slice(0, opts.limit) : rows;
  return { total: models.length, rows: limited };
}

export function renderSearch(result) {
  const rows = result.rows || [];
  const cells = rows.map((row) => [
    String(row.id ?? "?"),
    String(row.vendor ?? "—"),
    searchLifecycleMark(row.lifecycle),
    numText(row.context_window),
    numText(row.max_output_tokens),
    searchEffortText(row),
    priceText(row.cost && row.cost.input),
    priceText(row.cost && row.cost.output),
    searchCaps(row),
  ]);
  const widths = SEARCH_HEADERS.map((header, index) =>
    Math.max(displayWidth(header), ...cells.map((row) => displayWidth(row[index]))));
  const renderRow = (values) =>
    values.map((value, index) => pad(value, widths[index], SEARCH_ALIGN[index])).join("  ");

  const lines = [renderRow(SEARCH_HEADERS)];
  lines.push("─".repeat(widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1)));
  for (const row of cells) lines.push(renderRow(row));
  lines.push(`共 ${rows.length} 个结果（筛选自 ${result.total}）`);
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// compare：2-4 个模型并排对比（纯函数）
// --------------------------------------------------------------------------

export function compareModels(catalog, ids, usage) {
  const models = asModelList(catalog);
  const results = [];

  for (const rawId of ids || []) {
    const input = String(rawId).trim();
    const match = matchModel(models, input);
    const entry = match.entry || {};
    const reasoning = isDict(entry.reasoning) ? entry.reasoning : null;
    const tempDict = asDict(dig(entry, ["sampling", "temperature"]));
    const toolsDict = asDict(dig(entry, ["tools"]));
    const caching = isDict(entry.caching) ? entry.caching : null;

    results.push({
      input,
      kind: match.entry ? match.kind : "none",
      matchedId: match.matchedId,
      suggestion: match.entry ? null : match.suggestion,
      vendor: entry.vendor ?? null,
      lifecycle: entry.lifecycle ?? null,
      context_window: entry.context_window ?? null,
      max_output_tokens: entry.max_output_tokens ?? null,
      reasoning: reasoning
        ? {
            supported: reasoning.supported ?? null,
            effort_values: Array.isArray(reasoning.effort_values) ? reasoning.effort_values.slice() : null,
            default_effort: reasoning.default_effort ?? null,
          }
        : null,
      temperature: "supported" in tempDict ? tempDict.supported ?? null : null,
      tool_call: "function_calling" in toolsDict ? toolsDict.function_calling ?? null : null,
      vision: entry.vision ?? null,
      pdf: entry.pdf ?? null,
      caching_mode: caching && "mode" in caching ? caching.mode : null,
      cost: isDict(entry.cost) ? entry.cost : null,
      verified: entry.verified ?? null,
      gotcha_count: Array.isArray(entry.gotchas) ? entry.gotchas.length : 0,
    });
  }

  let usageResult = null;
  if (usage && isNum(usage.input_tokens) && isNum(usage.output_tokens)) {
    const costs = {};
    for (const model of results) {
      const cost = model.cost;
      costs[model.matchedId || model.input] =
        cost && isNum(cost.input) && isNum(cost.output)
          ? (usage.input_tokens / 1e6) * cost.input + (usage.output_tokens / 1e6) * cost.output
          : null;
    }
    usageResult = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      costs,
    };
  }

  let cheapest = null;
  if (usageResult) {
    for (const model of results) {
      const value = usageResult.costs[model.matchedId || model.input];
      if (!isNum(value)) continue;
      if (!cheapest || value < cheapest.value) {
        cheapest = { matchedId: model.matchedId, input: model.input, basis: "usage", value, input_price: null, output_price: null };
      }
    }
  } else {
    for (const model of results) {
      const cost = model.cost;
      if (!cost || !isNum(cost.input) || !isNum(cost.output)) continue;
      const value = cost.input + cost.output;
      if (!cheapest || value < cheapest.value) {
        cheapest = { matchedId: model.matchedId, input: model.input, basis: "per_1m", value, input_price: cost.input, output_price: cost.output };
      }
    }
  }

  return { models: results, usage: usageResult, cheapest };
}

function compareBoolText(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  return "—";
}

function compareEffortText(reasoning) {
  if (!reasoning) return "—";
  if (reasoning.supported === false) return "不支持";
  if (reasoning.supported !== true) return "—";
  const efforts = Array.isArray(reasoning.effort_values) ? reasoning.effort_values : [];
  if (!efforts.length) return "—";
  const base = efforts.join(",");
  return reasoning.default_effort ? `${base}（默认 ${reasoning.default_effort}）` : base;
}

function compareTierText(over) {
  if (!isDict(over) || !isNum(over.input) || !isNum(over.output)) return "—";
  return `${priceText(over.input)} / ${priceText(over.output)}`;
}

function usageCostText(value) {
  return isNum(value) ? `$${value.toFixed(4)}` : "—";
}

export function renderCompare(data) {
  const models = data.models || [];
  const rows = [];
  const push = (label, values) => rows.push([label, values]);

  push("规范 id", models.map((m) => m.matchedId || m.input));
  push("厂商", models.map((m) => m.vendor ?? "—"));
  push("生命周期", models.map((m) => m.lifecycle ?? "—"));
  push("上下文", models.map((m) => numText(m.context_window)));
  push("最大输出", models.map((m) => numText(m.max_output_tokens)));
  push("推理档位", models.map((m) => compareEffortText(m.reasoning)));
  push("temperature", models.map((m) => compareBoolText(m.temperature)));
  push("工具调用", models.map((m) => compareBoolText(m.tool_call)));
  push("视觉", models.map((m) => compareBoolText(m.vision)));
  push("PDF", models.map((m) => compareBoolText(m.pdf)));
  push("缓存模式", models.map((m) => m.caching_mode ?? "—"));
  push("输入价", models.map((m) => priceText(m.cost && m.cost.input)));
  push("输出价", models.map((m) => priceText(m.cost && m.cost.output)));
  push("缓存读价", models.map((m) => priceText(m.cost && m.cost.cache_read)));
  push("长上下文档", models.map((m) => compareTierText(m.cost && m.cost.context_over_200k)));
  push("已验证", models.map((m) => compareBoolText(m.verified)));
  push("备注数", models.map((m) => String(m.gotcha_count ?? 0)));
  if (data.usage) {
    push("本次用量成本", models.map((m) => usageCostText(data.usage.costs[m.matchedId || m.input])));
  }

  const header = models.map((m) => m.input);
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label)));
  const columnWidths = header.map((h, index) =>
    Math.max(displayWidth(h), ...rows.map((row) => displayWidth(row[1][index]))));

  // 对比表统一左对齐：同一列里可能出现很宽的值（如完整档位串），
  // 右对齐会把数字推到远端、与行标签脱节，反而难读。
  const totalWidth = labelWidth + 2 + columnWidths.reduce((a, b) => a + b, 0) + 2 * Math.max(models.length - 1, 0);
  const lines = [];
  lines.push(`${pad("属性", labelWidth)}  ${header.map((h, i) => pad(h, columnWidths[i])).join("  ")}`);
  lines.push("─".repeat(totalWidth));
  for (const [label, values] of rows) {
    lines.push(`${pad(label, labelWidth)}  ${values.map((v, i) => pad(v, columnWidths[i])).join("  ")}`);
  }

  lines.push("");
  if (data.cheapest) {
    const cheapest = data.cheapest;
    const basis = data.usage
      ? `本次用量 ${usageCostText(cheapest.value)}`
      : `${priceText(cheapest.input_price)} / ${priceText(cheapest.output_price)} 每 1M tokens`;
    lines.push(`最低价：${cheapest.matchedId}（${basis}）`);
  } else {
    lines.push("最低价：—");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// protocols：跨工具协议总览（纯函数；文件发现/读取由 CLI 负责）
// --------------------------------------------------------------------------

// 把各工具的原始协议写法归一化到 catalog 的 api_protocol 词表。
// 返回 {protocol, raw, inferred}：inferred=true 表示这是推断值（不确定）。
const PI_API_PROTOCOLS = {
  "anthropic-messages": { protocol: "anthropic_messages", inferred: false },
  "openai-responses": { protocol: "responses", inferred: false },
  "openai-completions": { protocol: "chat_completions", inferred: false },
};

const OPENCODE_NPM_PROTOCOLS = {
  "@ai-sdk/anthropic": { protocol: "anthropic_messages", inferred: false },
  "@ai-sdk/google": { protocol: "gemini", inferred: false },
  "@ai-sdk/mistral": { protocol: "chat_completions", inferred: false },
};

// @ai-sdk/openai 可同时说 responses / chat_completions，只能看 baseURL 推断；
// 永远不要断言确定 —— inferred=true 会在渲染层显示为 "openai (推断)"。
function inferOpencodeOpenai(baseUrl) {
  const url = typeof baseUrl === "string" ? baseUrl : "";
  if (/\/responses(\/|$|\?)/i.test(url)) return { protocol: "responses", inferred: true };
  return { protocol: "openai", inferred: true };
}

function normalizeProtocolValue(raw) {
  if (raw === null || raw === undefined || raw === "") return { protocol: null, inferred: false };
  const text = String(raw);
  if (PI_API_PROTOCOLS[text]) return { ...PI_API_PROTOCOLS[text] };
  if (OPENCODE_NPM_PROTOCOLS[text]) return { ...OPENCODE_NPM_PROTOCOLS[text] };
  if (text === "@ai-sdk/openai") return inferOpencodeOpenai(null);
  return { protocol: text, inferred: false };
}

// 原始值的展示文本：不确定的加 (推断)，未识别的加 ?
export function protocolLabel(protocol, inferred, known) {
  if (!protocol) return "?";
  if (inferred) return `${protocol} (推断)`;
  if (known === false) return `${protocol} ?`;
  return protocol;
}

function protocolKnown(value) {
  return [
    "anthropic_messages", "responses", "chat_completions", "gemini", "native", "openai",
  ].includes(value) || Boolean(PI_API_PROTOCOLS[value]) || Boolean(OPENCODE_NPM_PROTOCOLS[value]);
}

// --- 各格式的 provider 提取（只读协议/模型相关字段，绝不读取凭证） -----------

function extractPiProviders(config) {
  const out = [];
  const providers = isDict(config) && isDict(config.providers) ? config.providers : {};
  for (const name of Object.keys(providers).sort(cmpStr)) {
    const provider = providers[name];
    if (!isDict(provider)) continue;
    const raw = provider.api;
    const normalized = normalizeProtocolValue(raw);
    const models = [];
    const list = Array.isArray(provider.models) ? provider.models : [];
    for (const model of list) {
      if (!isDict(model) || typeof model.id !== "string" || !model.id) continue;
      // 模型级 api 覆盖 provider 级（models-store.json 的条目带 api 字段）
      const modelNorm = typeof model.api === "string" && model.api
        ? normalizeProtocolValue(model.api)
        : normalized;
      models.push({ id: model.id, ...modelNorm, raw: typeof model.api === "string" && model.api ? model.api : raw });
    }
    out.push({ provider: name, raw: raw ?? null, ...normalized, models });
  }
  return out;
}

// ~/.pi/agent/models-store.json：顶层直接是 provider 名（无 providers 包装），
// 协议写在每条 model.api 上（provider 级可能缺失）。provider 级协议取首条模型的
// api 作为代表值，这样 --json 里 provider.protocol 不会是无意义的 null。
function extractPiStoreProviders(config) {
  if (!isDict(config)) return [];
  const out = [];
  for (const name of Object.keys(config).sort(cmpStr)) {
    const provider = config[name];
    if (!isDict(provider) || !Array.isArray(provider.models)) continue;
    let raw = provider.api;
    if (raw === undefined || raw === null || raw === "") {
      for (const model of provider.models) {
        if (isDict(model) && typeof model.api === "string" && model.api) {
          raw = model.api;
          break;
        }
      }
    }
    const providerNorm = normalizeProtocolValue(raw);
    const models = [];
    for (const model of provider.models) {
      if (!isDict(model) || typeof model.id !== "string" || !model.id) continue;
      const modelNorm = typeof model.api === "string" && model.api
        ? normalizeProtocolValue(model.api)
        : providerNorm;
      models.push({ id: model.id, ...modelNorm, raw: typeof model.api === "string" && model.api ? model.api : raw });
    }
    out.push({ provider: name, raw: raw ?? null, ...providerNorm, models });
  }
  return out;
}

function extractOpencodeProviders(config) {
  const out = [];
  const providers = isDict(config) && isDict(config.provider) ? config.provider : {};
  for (const name of Object.keys(providers).sort(cmpStr)) {
    const provider = providers[name];
    if (!isDict(provider)) continue;
    const npm = typeof provider.npm === "string" ? provider.npm : null;
    const baseUrl = isDict(provider.options) ? provider.options.baseURL : null;
    const normalized = npm === "@ai-sdk/openai"
      ? inferOpencodeOpenai(baseUrl)
      : normalizeProtocolValue(npm);
    const models = [];
    const modelMap = isDict(provider.models) ? provider.models : {};
    for (const id of Object.keys(modelMap).sort(cmpStr)) {
      const model = modelMap[id];
      // 模型级 provider.api 覆盖 provider 级推断
      const override = isDict(model) && typeof model.provider === "object" && isDict(model.provider)
        ? model.provider.api
        : null;
      const modelNorm = typeof override === "string" && override
        ? normalizeProtocolValue(override)
        : normalized;
      models.push({ id, ...modelNorm, raw: typeof override === "string" && override ? override : npm });
    }
    out.push({ provider: name, raw: npm, ...normalized, models });
  }
  return out;
}

// claude settings.json：只读 env 下的 BASE_URL / MODEL 类键，绝不碰 AUTH_TOKEN。
const CLAUDE_MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

// 白名单提取：只保留协议总览需要的 env 键（BASE_URL + 模型 id）。
// 凭证键（AUTH_TOKEN 等）在此被显式丢弃 —— 调用方可以用它的返回值
// 构造"已脱敏"的最小配置，而不必依赖 stripCredentials 把整个 env 删掉。
export function claudeProtocolEnv(config) {
  if (!isDict(config) || !isDict(config.env)) return null;
  const env = config.env;
  const out = {};
  if (typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL) {
    out.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }
  for (const key of CLAUDE_MODEL_KEYS) {
    if (typeof env[key] === "string" && env[key]) out[key] = env[key];
  }
  return Object.keys(out).length ? out : null;
}

// base URL -> 主机名（用于 provider 列；解析失败时退回原文，仍不含凭证）
function hostLabel(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.host) return url.host;
  } catch {
    // 非完整 URL：原样返回
  }
  return value;
}

function extractClaudeProviders(config) {
  const env = isDict(config) && isDict(config.env) ? config.env : null;
  if (!env) return [];
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null;
  const models = [];
  const seen = new Set();
  for (const key of CLAUDE_MODEL_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    models.push({ id: value, protocol: "anthropic_messages", raw: "anthropic_messages", inferred: false });
  }
  if (!models.length && !baseUrl) return [];
  return [{
    provider: hostLabel(baseUrl) || "claude-code",
    raw: "anthropic_messages",
    protocol: "anthropic_messages",
    inferred: false,
    models,
  }];
}

// codex config.toml：行级窄扫描（零依赖）。为 audit / fix 提供「键在哪一行、
// 值占哪些字符位置」的信息——fix 只重写目标值的字符区间，其余字节一律不动。
// 行结构用 split(/(\r\n|\n|\r)/) 保留原分隔符，因此 CRLF / LF / 混合行尾都不会被改写。

// 行内 `#` 注释的起点下标（跳过引号内的 #）；无注释返回 -1
function tomlCommentIndex(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#") return i;
  }
  return -1;
}

export function scanCodexToml(text) {
  const parts = String(text == null ? "" : text).split(/(\r\n|\n|\r)/);
  const top = new Map();
  const providerKeys = new Map();
  let section = null;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    if (typeof line !== "string") continue;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]/.exec(stripped);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      const pm = /^model_providers\.(.+)$/.exec(name);
      section = pm ? pm[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1") : null;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    const commentAt = tomlCommentIndex(line.slice(eq + 1));
    const tailStart = commentAt >= 0 ? eq + 1 + commentAt : line.length;
    let valueStart = eq + 1;
    while (valueStart < tailStart && /\s/.test(line[valueStart])) valueStart += 1;
    let valueEnd = tailStart;
    while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1])) valueEnd -= 1;
    const raw = line.slice(valueStart, valueEnd);
    const quote = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? '"'
      : raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
        ? "'"
        : null;
    const value = quote ? raw.slice(1, -1) : raw;
    const info = { lineIndex: i / 2, valueStart, valueEnd, quote, value };
    if (section === null) {
      if (key === "model" || key === "model_provider" || key === "model_reasoning_effort") top.set(key, info);
    } else if (key === "name" || key === "wire_api" || key === "base_url") {
      providerKeys.set(`${section}\u0000${key}`, info);
    }
  }
  return { top, providerKeys };
}

// 行级回写：只替换 [valueStart, valueEnd) 的字符区间，保留前置空白、`=` 周围空格、
// 引号风格（跟随原行）与行尾注释。
function replaceTomlValue(line, span, value) {
  const literal = span.quote === "'"
    ? `'${String(value).replace(/'/g, "")}'`
    : tomlString(value);
  return line.slice(0, span.valueStart) + literal + line.slice(span.valueEnd);
}

// codex 修复计划：只有「已声明且官网可判定」的字段才进入 changes；
// 未声明字段绝不新增（与 opencode/pi 的保守原则一致）。
export function planCodexFixes(catalog, text) {
  const models = asModelList(catalog);
  const scan = scanCodexToml(text);
  const parsed = parseCodexToml(text);
  const input = typeof parsed.model === "string" && parsed.model ? parsed.model : null;
  const match = input ? matchModel(models, input) : { entry: null, kind: "none", matchedId: null, suggestion: null };

  const entry = {
    input: input || "(未设置 model)",
    provider: parsed.model_provider,
    kind: match.entry ? match.kind : "none",
    matchedId: match.matchedId,
    suggestion: match.entry ? null : match.suggestion,
    duplicate: false,
    ref: null,
    changes: [],
    skipped: [],
  };

  if (match.entry) {
    const e = match.entry;
    const effortSpan = scan.top.get("model_reasoning_effort");
    if (effortSpan) {
      const official = valOrNone(e, ["reasoning", "effort_values"]);
      if (!Array.isArray(official) || !official.length) {
        entry.skipped.push({ field: "efforts", reason: "官网未文档化" });
      } else if (!official.includes(effortSpan.value)) {
        const def = valOrNone(e, ["reasoning", "default_effort"]);
        if (typeof def === "string" && official.includes(def)) {
          entry.changes.push({ field: "efforts", lineIndex: effortSpan.lineIndex, span: effortSpan, from: effortSpan.value, to: def });
        } else {
          entry.skipped.push({ field: "efforts", reason: "官网未文档化 default_effort，无法确定目标档位" });
        }
      }
    }

    const providerName = typeof parsed.model_provider === "string" && parsed.model_provider ? parsed.model_provider : null;
    const wireSpan = providerName ? scan.providerKeys.get(`${providerName}\u0000wire_api`) : null;
    if (wireSpan) {
      const options = codexWireOptions(e);
      if (!options.length) {
        entry.skipped.push({ field: "wire_api", reason: "官网 api_protocol 无法映射到 codex（仅 responses / chat）" });
      } else if (!options.includes(wireSpan.value)) {
        entry.changes.push({ field: "wire_api", lineIndex: wireSpan.lineIndex, span: wireSpan, from: wireSpan.value, to: options[0] });
      }
    }
  }

  const entries = !entry.matchedId || entry.changes.length || entry.skipped.length ? [entry] : [];
  const summary = { total: 1, fixable_models: 0, change_items: 0, skipped_items: 0, unmatched: 0 };
  if (!entry.matchedId) summary.unmatched = 1;
  if (entry.changes.length) summary.fixable_models = 1;
  summary.change_items = entry.changes.length;
  summary.skipped_items = entry.skipped.length;
  return { format: "codex", entries, summary };
}

// 应用 codex 修复计划：按行区间重写目标值，其余字节（含行尾符 / 注释 / 缩进）不动。
export function applyCodexFixes(text, plan) {
  const src = String(text == null ? "" : text);
  const parts = src.split(/(\r\n|\n|\r)/);
  const changes = [];
  for (const entry of (plan && plan.entries) || []) {
    for (const change of entry.changes || []) {
      if (isNum(change.lineIndex) && isDict(change.span)) changes.push(change);
    }
  }
  changes.sort((a, b) => b.lineIndex - a.lineIndex);
  for (const change of changes) {
    const idx = change.lineIndex * 2;
    const line = parts[idx];
    if (typeof line !== "string") continue;
    parts[idx] = replaceTomlValue(line, change.span, change.to);
  }
  return parts.join("");
}

// codex config.toml：窄行扫描（零依赖），只取 model / model_provider / model_reasoning_effort / wire_api / base_url。
export function parseCodexToml(text) {
  const result = { model: null, model_provider: null, model_reasoning_effort: null, providers: {} };
  let section = null;
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]/.exec(stripped);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(stripped);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim().replace(/\s+#.*$/, "").trim();
    const quoted = /^"(.*)"$/.exec(value) || /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1];
    if (section === null) {
      if (key === "model" || key === "model_provider" || key === "model_reasoning_effort") result[key] = value;
      continue;
    }
    const providerMatch = /^model_providers\.(.+)$/.exec(section);
    if (!providerMatch) continue;
    const providerName = providerMatch[1].replace(/^"(.*)"$/, "$1");
    if (!isDict(result.providers[providerName])) result.providers[providerName] = {};
    if (key === "wire_api" || key === "base_url" || key === "name") {
      result.providers[providerName][key] = value;
    }
  }
  return result;
}

const CODEX_WIRE_PROTOCOLS = {
  responses: { protocol: "responses", inferred: false },
  chat: { protocol: "chat_completions", inferred: false },
};

function extractCodexProviders(config) {
  const parsed = isDict(config) ? config : parseCodexToml(config);
  const names = Object.keys(parsed.providers || {});
  const active = parsed.model_provider;
  const ordered = names.slice().sort((a, b) => {
    if (a === active) return -1;
    if (b === active) return 1;
    return cmpStr(a, b);
  });
  const out = [];
  for (const name of ordered) {
    const provider = parsed.providers[name] || {};
    const wire = typeof provider.wire_api === "string" ? provider.wire_api : null;
    const normalized = wire && CODEX_WIRE_PROTOCOLS[wire]
      ? { ...CODEX_WIRE_PROTOCOLS[wire] }
      : { protocol: wire, inferred: false };
    const models = [];
    // codex 是单模型工具：顶层 model 属于当前激活的 provider
    if (name === active && typeof parsed.model === "string" && parsed.model) {
      models.push({ id: parsed.model, ...normalized, raw: wire });
    }
    out.push({ provider: name, raw: wire, ...normalized, models, baseUrl: provider.base_url ?? null });
  }
  return out;
}

// --- 原生协议匹配 ----------------------------------------------------------

// 配置协议 vs 官网 api_protocol。返回 {status, native}：
//   match    ✓ 匹配（含 pipe 连接的"任一皆可"）
//   mismatch ⚠ 原生 X（需翻译）
//   unknown  ? 原生 X（协议不确定）——配置协议本身是推断值
//   unmapped ? 未收录
//   indeterminate ? 原生 X（无法判定）——catalog 值为 null/native/gemini
function nativeProtocolCheck(models, modelId, protocol, inferred) {
  const match = matchModel(models, modelId);
  if (!match.entry) return { status: "unmapped", matchedId: null, native: null, suggestion: match.suggestion };
  const entry = match.entry;
  const nativeRaw = entry.api_protocol;
  const native = nativeRaw === undefined ? null : nativeRaw;

  // catalog 无 api_protocol / 值为 null：无法判定
  if (native === null || native === undefined) {
    return { status: "indeterminate", matchedId: match.matchedId, native: null };
  }

  // pipe 连接的多个值 = "任一皆可"；native / gemini 是特殊值，不能做肯定判断
  const supported = String(native).split("|").map((x) => x.trim()).filter(Boolean);
  if (supported.includes(protocol)) {
    return { status: "match", matchedId: match.matchedId, native };
  }
  // native / gemini 等非明确协议：配置值对不上时只提示，不报警
  if (supported.includes("native") || supported.includes("gemini")) {
    return { status: "indeterminate", matchedId: match.matchedId, native };
  }
  // 配置协议本身不可识别（未知 npm / 未映射的 api 值）：不做肯定判断
  if (!protocolKnown(protocol)) {
    return { status: "indeterminate", matchedId: match.matchedId, native };
  }
  // 配置协议本身是推断值：不确定 vs 明确不匹配
  if (inferred) {
    return { status: "unknown", matchedId: match.matchedId, native };
  }
  return { status: "mismatch", matchedId: match.matchedId, native };
}

// 汇总一个来源文件/工具的全部 provider 行。
export function protocolsReport(catalog, sources) {
  const models = Array.isArray(catalog)
    ? catalog
    : isDict(catalog) && Array.isArray(catalog.models)
      ? catalog.models
      : [];

  const providers = [];
  const files = [];

  for (const source of sources || []) {
    const { tool, config, file, shape } = source;
    // shape 决定提取策略（同一工具可能有多种文件结构）；缺省按 tool 推断。
    const strategy = shape || tool;
    let extracted = [];
    if (strategy === "pi") extracted = extractPiProviders(config);
    else if (strategy === "pi-store") extracted = extractPiStoreProviders(config);
    else if (strategy === "opencode") extracted = extractOpencodeProviders(config);
    else if (strategy === "claude-code") extracted = extractClaudeProviders(config);
    else if (strategy === "codex") extracted = extractCodexProviders(config);
    if (file) files.push(file);

    for (const item of extracted) {
      const known = protocolKnown(item.protocol);
      const modelRows = item.models.map((model) => {
        const check = nativeProtocolCheck(models, model.id, model.protocol, model.inferred);
        return {
          id: model.id,
          matchedId: check.matchedId,
          native: check.native,
          status: check.status,
          suggestion: check.suggestion ?? null,
          protocol: model.protocol,
        };
      });
      providers.push({
        tool,
        provider: item.provider,
        protocol: item.protocol,
        protocol_raw: item.raw,
        inferred: item.inferred === true,
        protocol_known: known,
        file: file ?? null,
        models: modelRows,
      });
    }
  }

  // 排序：先工具，再 provider
  providers.sort((a, b) => cmpStr(a.tool, b.tool) || cmpStr(a.provider, b.provider));

  const summary = {
    providers: providers.length,
    models: providers.reduce((sum, p) => sum + p.models.length, 0),
    mismatched: providers.filter((p) => p.models.some((m) => m.status === "mismatch")).length,
    unmapped: providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === "unmapped").length, 0),
  };
  return { files, providers, summary };
}

// --- 渲染 ------------------------------------------------------------------

// 与模型原生协议的对照文本（格式对齐任务示例）：
//   match         ✓ 匹配
//   mismatch      ⚠ 原生 chat_completions（需翻译）
//   unknown       ? 原生 chat_completions（协议不确定）
//   indeterminate ? 原生 gemini（无法判定）
//   unmapped      ? 未收录
function protocolStatusText(model) {
  const native = model.native;
  const nativeText = native === null || native === undefined ? "—" : String(native);
  switch (model.status) {
    case "match":
      return "✓ 匹配";
    case "mismatch":
      return `⚠ 原生 ${nativeText}（需翻译）`;
    case "unknown":
      return `? 原生 ${nativeText}（协议不确定）`;
    case "indeterminate":
      return `? 原生 ${nativeText}（无法判定）`;
    case "unmapped":
      return model.suggestion ? `? 未收录（最接近 ${model.suggestion}）` : "? 未收录";
    default:
      return "?";
  }
}

export function renderProtocols(report) {
  const headers = ["工具", "provider", "协议", "模型", "与模型原生协议"];
  const rows = [];
  for (const provider of report.providers) {
    if (!provider.models.length) {
      const protocolText = protocolLabel(provider.protocol, provider.inferred, provider.protocol_known);
      rows.push([provider.tool, provider.provider, protocolText, "—", "—"]);
      continue;
    }
    for (const model of provider.models) {
      // 行内协议优先用模型级值（models-store.json 的协议写在每条模型上）
      const protocol = model.protocol ?? provider.protocol;
      const inferred = model.protocol !== undefined && model.protocol !== null
        ? provider.inferred && model.protocol === provider.protocol
        : provider.inferred;
      const protocolText = protocolLabel(protocol, inferred, protocolKnown(protocol));
      rows.push([
        provider.tool,
        provider.provider,
        protocolText,
        model.id,
        protocolStatusText(model),
      ]);
    }
  }

  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))));

  const divider = "─".repeat(widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1));
  const lines = ["协议总览", "═".repeat(40)];
  lines.push(headers.map((h, i) => pad(h, widths[i])).join("  "));
  lines.push(divider);
  for (const row of rows) lines.push(row.map((v, i) => pad(v, widths[i])).join("  "));
  lines.push(divider);
  lines.push(`共 ${report.summary.providers} 个 provider · ${report.summary.models} 个模型条目`);
  if (report.summary.mismatched > 0) {
    lines.push(`${report.summary.mismatched} 个 provider 的协议与模型原生协议不一致（中转需翻译，参数可能被丢弃）`);
  } else {
    lines.push("未发现协议与模型原生协议不一致的 provider");
  }
  lines.push("提示：协议不匹配 ≠ 不能用；但 thinking/temperature 等参数可能在翻译中静默失效。");
  return lines.join("\n");
}
