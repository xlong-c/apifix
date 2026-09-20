/* apifix ui fallback — UI 降级实现（纯函数模块，浏览器 / Node 通用）。
 *
 * 本模块从 ui/app.js 迁出：当 ../lib/core.mjs 加载失败（或调用抛错）时，
 * app.js 用这里的匹配 / emit 逻辑生成结果，页面不崩。
 *
 * 硬约束（AGENTS.md 不变量 2）：
 *   - 行为必须与 lib/core.mjs 逐字节一致，对拍基线为
 *     catalog 模型数 × 2 emitter（opencode/pi）× 2 模式（精简/-f）= 1308 组零差异；
 *     自动化对拍见 tools/parity-check.mjs。
 *   - 本文件 **不使用任何 Node API**（无 fs/path/process/import 内置模块），
 *     浏览器可直接 import（apifix.mjs 的本地静态服务对 .mjs 返回 text/javascript）。
 *   - core 是唯一正典：改 core 的 emit / 匹配逻辑时，必须同步改这里。
 */

/* ------------------------------------------------------------------ 常量 */

// 中转/发布渠道后缀。顺序敏感：长后缀优先（与 core SUFFIX_PATTERNS 一致）。
const SUFFIX_PATTERNS = [
  ['-vision-exp', /-vision-exp$/i], ['-experimental', /-experimental$/i],
  ['-expires-on-*', /-expires-on-[0-9a-z]+$/i], ['-ga-*', /-ga-[0-9a-z]+$/i],
  ['-contributor', /-contributor$/i], ['-preview', /-preview$/i], ['-free', /-free$/i],
  ['-latest', /-latest$/i], ['-build', /-build$/i], ['-exp', /-exp$/i],
  ['-YYYYMMDD', /-(19|20)\d{6}$/], ['-vN', /-v\d+$/i],
];
const VENDOR_PREFIXES = new Set(['openai', 'anthropic', 'meta', 'google', 'x-ai', 'xai', 'deepseek',
  'moonshotai', 'moonshot', 'z-ai', 'zhipu', 'qwen', 'dashscope', 'minimax', 'minimaxai',
  'volcengine', 'volcengine-plan', 'doubao', 'tencent', 'alibaba', 'ark']);
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const MISS_TEXT = '未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）';
export const FALLBACK_NOTE = '未加载 ../lib/core.mjs，以下内容由页面内置逻辑生成，可能与 CLI 输出存在差异。';

/* 完整模式：catalog 里没有官方数据的字段一律不输出，只在提示里列出（与 CLI stderr 一致）。
 * UI 展示层（app.js 的 fullOmittedCaption）也读这张表，故一并导出。 */
export const FULL_OMITTED = {
  opencode: ['cost', 'release_date', 'interleaved', 'experimental', 'options', 'headers'],
  pi: ['provider', 'baseUrl', 'compat', 'cost'],
};
const OPENCODE_STATUS = { current: 'active', legacy: 'deprecated', retired: 'deprecated', unreleased: 'beta' };

/* pi 的 api_protocol → api 名映射。注意：core 只认单键（无整串特判键），
 * 多段 pipe 值由 mapPiApi 取首元素后查这张表。 */
const PI_API_MAP = {
  anthropic_messages: 'anthropic-messages',
  responses: 'openai-responses',
  chat_completions: 'openai-completions',
};

/* api_protocol 可能是 N 路 pipe 值（如 chat_completions|responses|anthropic_messages，
 * 表示“任一皆可”）。emit 时取**首个**元素映射（first-listed-wins，与 lib/core.mjs
 * 的 mapPiApi 逐行一致，core 是正典）：
 *   responses|chat_completions -> openai-responses
 *   chat_completions|responses|anthropic_messages -> openai-completions
 * 非字符串 / 空串 → undefined；首项不可映射（native/gemini 等）→ undefined，
 * 由调用方按“无法映射”处理（省略 api 字段）。注意大小写敏感、不归一化。 */
export function mapPiApi(protocol) {
  if (typeof protocol !== 'string' || !protocol) return undefined;
  const first = protocol.split('|')[0].trim();
  return PI_API_MAP[first];
}

/* ------------------------------------------------------------ 匹配（降级） */

const sepKey = (text) => String(text || '').trim().toLowerCase().replace(/[-._]/g, '-');

function normalizeFallback(input) {
  let cand = String(input || '').trim();
  const stages = [{ candidate: cand, notes: [] }];
  const notes = [];
  const push = () => stages.push({ candidate: cand, notes: notes.slice() });

  if (cand.includes('/')) {
    const idx = cand.indexOf('/');
    const prefix = cand.slice(0, idx).toLowerCase();
    if (VENDOR_PREFIXES.has(prefix) && cand.slice(idx + 1)) {
      cand = cand.slice(idx + 1);
      notes.push('去除厂商前缀 ' + prefix + '/');
      push();
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [label, pattern] of SUFFIX_PATTERNS) {
      if (!pattern.test(cand)) continue;
      cand = cand.replace(pattern, '');
      notes.push('去除 relay 后缀 ' + label);
      push();
      changed = true;
      break;
    }
  }
  if (sepKey(cand) !== cand.trim().toLowerCase()) {
    notes.push('分隔符归一化 (-/./_ 等价)');
    push();
  }
  return { normalized: cand, notes, stages };
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function noteForFallback(input, canonical, kind, ops, entry) {
  const parts = [];
  if (kind === 'legacy') {
    parts.push(input + ' 是旧版/退役 id，对应 ' + canonical + '；中转仍在沿用，值按官网当前规格输出');
  } else if (kind === 'alias') {
    parts.push(input + ' -> ' + canonical + '（别名解析）');
  } else if (kind === 'normalized') {
    parts.push(input + ' -> 官网规范 id ' + canonical + '（值采用官方规格，'
      + ((ops && ops.length) ? ops.join('；') : '归一化解析') + '）');
  }
  const note = entry && entry.lifecycle_note;
  if (entry && entry.lifecycle === 'retired') {
    parts.push(canonical + ' 官方已退役；第三方可能仍提供，参数为退役前规格' + (note ? '（' + note + '）' : ''));
  } else if (entry && entry.lifecycle === 'unreleased') {
    parts.push(canonical + ' 官方尚未发布' + (note ? '（' + note + '）' : ''));
  }
  return parts.join('\n') || null;
}

export function matchFallback(models, input) {
  const raw = String(input || '').trim();
  const out = { input: raw, kind: 'none', matchedId: null, note: null, entry: null, suggestion: null };
  if (!raw) return out;

  const prio = { exact: 0, alias: 1, legacy: 2 };
  const keys = [];
  for (const entry of models) {
    keys.push({ text: entry.id, entry, kind: 'exact' });
    for (const alias of entry.aliases || []) keys.push({ text: alias, entry, kind: 'alias' });
    for (const legacy of entry.legacy_ids || []) {
      if (legacy && legacy.id) keys.push({ text: legacy.id, entry, kind: 'legacy' });
    }
  }
  const sepMap = new Map();
  for (const key of keys) {
    const sk = sepKey(key.text);
    const cur = sepMap.get(sk);
    if (!cur || prio[key.kind] < prio[cur.kind]) sepMap.set(sk, { entry: key.entry, kind: key.kind });
  }
  const lookup = (cand) => {
    const low = cand.toLowerCase();
    let best = null;
    for (const key of keys) {
      if (key.text.toLowerCase() !== low) continue;
      if (!best || prio[key.kind] < prio[best.kind]) best = key;
      if (best.kind === 'exact') break;
    }
    return best;
  };
  const done = (entry, kind, ops) => {
    out.entry = entry;
    out.matchedId = entry.id;
    out.kind = kind;
    out.note = noteForFallback(raw, entry.id, kind, ops, entry);
    return out;
  };
  const fromSep = (sep, ops) => done(sep.entry, sep.kind === 'legacy' ? 'legacy' : 'normalized', ops);
  const sepOps = (candidate, sep) => (candidate.trim().toLowerCase() === String(sep.entry.id).toLowerCase()
    ? [] : ['分隔符等价匹配 (-/./_ 视为相同)']);

  const exact = lookup(raw);
  if (exact) return done(exact.entry, exact.kind, []);

  const norm = normalizeFallback(raw);
  for (const stage of norm.stages) {
    if (!stage.notes.length) continue;
    const hit = lookup(stage.candidate);
    if (hit) return done(hit.entry, hit.kind === 'legacy' ? 'legacy' : 'normalized', stage.notes);
    const sep = sepMap.get(sepKey(stage.candidate));
    if (sep) return fromSep(sep, stage.notes.concat(sepOps(stage.candidate, sep)));
  }
  const sepRaw = sepMap.get(sepKey(raw));
  if (sepRaw) return fromSep(sepRaw, sepOps(raw, sepRaw));

  const probe = sepKey(raw);
  let best = null;
  for (const key of keys) {
    const target = sepKey(key.text);
    if (!target) continue;
    const score = 1 - levenshtein(probe, target) / Math.max(probe.length, target.length);
    if (score >= 0.75 && (!best || score > best.score)) best = { text: key.text, score };
  }
  if (best) {
    out.kind = 'fuzzy';
    out.suggestion = best.text;
    out.note = MISS_TEXT + ' 最接近: ' + best.text + '（score=' + best.score.toFixed(2) + '）';
  } else {
    out.note = MISS_TEXT;
  }
  return out;
}

/* ---------------------------------------------------- emit：opencode（降级） */

/* 顶层单键取值（缺失 → null）。UI 展示层（app.js 的 fullOmittedCaption）也用它，故导出。 */
export const valOrNull = (entry, key) => (entry && entry[key] !== undefined ? entry[key] : null);

/* 与 core 一致的判定：NaN / Infinity / null 一律不算数字，数组不算对象。 */
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const isDict = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/* 从 entry.cost（一律 USD）构造 opencode 的 cost 字段；与 lib/core.mjs 的 opencodeCost 逐字对齐。
 * opencode schema 只接受数字，故 null 键一律省略；input/output 缺一即整体省略。
 * UI 展示层（app.js 的 fullOmittedCaption）用它判断 cost 是否实际输出，故导出。 */
export function opencodeCost(entry) {
  const cost = isDict(entry) && Object.prototype.hasOwnProperty.call(entry, 'cost')
    ? entry.cost : undefined;
  if (!isDict(cost)) return null;
  if (!isNum(cost.input) || !isNum(cost.output)) return null;

  const out = { input: cost.input, output: cost.output };
  for (const key of ['cache_read', 'cache_write']) {
    if (isNum(cost[key])) out[key] = cost[key];
  }

  const over = cost.context_over_200k;
  if (isDict(over) && isNum(over.input) && isNum(over.output)) {
    const sub = { input: over.input, output: over.output };
    for (const key of ['cache_read', 'cache_write']) {
      if (isNum(over[key])) sub[key] = over[key];
    }
    out.context_over_200k = sub;
  }
  return out;
}

/* 顶层键排序：opencode payload 与 CLI（sort_keys）一致，完整模式新增字段后仍需有序。 */
function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/* 完整模式追加的字段（与 lib/core.mjs 逐字对齐）：family → status → modalities → cost。 */
function opencodeExtras(entry) {
  const model = entry || {};
  const extras = {};
  const family = valOrNull(model, 'family');
  if (typeof family === 'string' && family) extras.family = family;
  const status = OPENCODE_STATUS[valOrNull(model, 'lifecycle')];
  if (status) extras.status = status;
  const modalities = { input: ['text'] };
  if (model.vision === true) modalities.input.push('image');
  if (model.pdf === true) modalities.input.push('pdf');
  modalities.output = ['text'];
  extras.modalities = modalities;
  // cost 仅在 catalog 给出数字 input/output 时输出，否则整个键省略。
  const cost = opencodeCost(model);
  if (cost) extras.cost = cost;
  return extras;
}

/* 键顺序与 CLI（sort_keys）一致：精简模式的 payload 字面量本身即按字母序书写。 */
export function emitOpencodeFallback(entry, keyId, name, full) {
  const reasoning = entry.reasoning || {};
  const sampling = entry.sampling || {};
  const tools = entry.tools || {};
  const payload = {
    attachment: valOrNull(entry, 'vision'),
    limit: { context: valOrNull(entry, 'context_window'), output: valOrNull(entry, 'max_output_tokens') },
    name,
    reasoning: reasoning.supported === undefined ? null : reasoning.supported,
    temperature: (sampling.temperature || {}).supported === undefined ? null : sampling.temperature.supported,
    tool_call: tools.function_calling === undefined ? null : tools.function_calling,
  };
  const efforts = Array.isArray(reasoning.effort_values) ? reasoning.effort_values.slice().sort() : [];
  if (efforts.length) {
    payload.variants = {};
    for (const effort of efforts) payload.variants[effort] = { reasoningEffort: effort };
  }
  if (full) Object.assign(payload, opencodeExtras(entry));
  return JSON.stringify({ [keyId]: sortedObject(payload) }, null, 2);
}

/* --------------------------------------------------------- emit：pi（降级） */

export function emitPiFallback(entry, keyId, name, full) {
  const reasoning = entry.reasoning || {};
  const supported = reasoning.supported === undefined ? null : reasoning.supported;
  const efforts = Array.isArray(reasoning.effort_values) ? reasoning.effort_values : [];
  const thinkingLevelMap = {};
  // "off" 是 pi 的关闭思考档位：官方用 none 表示关闭时映射为 'none'，否则 null（与 lib/core.mjs 保持一致）。
  for (const level of PI_LEVELS) {
    if (!supported) thinkingLevelMap[level] = null;
    else if (level === 'off') thinkingLevelMap[level] = efforts.includes('none') ? 'none' : null;
    else thinkingLevelMap[level] = efforts.includes(level) ? level : null;
  }
  const payload = { id: keyId, name, reasoning: supported,
    input: entry.vision === true ? ['text', 'image'] : ['text'],
    contextWindow: valOrNull(entry, 'context_window'),
    maxTokens: valOrNull(entry, 'max_output_tokens'), thinkingLevelMap };
  if (full) {
    // api 追加在末尾（core 不对 pi payload 排序）；用 mapPiApi 取首段 pipe 值映射
    // （与 lib/core.mjs 的 mapPiApi 逐行一致），无法映射时省略。
    const protocol = valOrNull(entry || {}, 'api_protocol');
    const api = mapPiApi(protocol);
    if (api) payload.api = api;
  }
  return JSON.stringify(payload, null, 2);
}
