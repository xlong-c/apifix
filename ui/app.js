/* apifix ui — 单页应用，零依赖，ES module，离线可用。
 * 数据：fetch('../catalog.json')；共享逻辑：../lib/core.mjs（import 失败则降级，页面不崩）。
 * 所有动态文本经 textContent / createElement 写入，不使用 innerHTML。
 */

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ 常量 */

const LIFECYCLE = {
  current: { cn: '当前在架', cls: 'badge-current' },
  legacy: { cn: '旧版（仍可调用）', cls: 'badge-legacy' },
  retired: { cn: '已退役', cls: 'badge-retired' },
  unreleased: { cn: '尚未发布', cls: 'badge-unreleased' },
};
const LIFECYCLE_ORDER = ['current', 'legacy', 'retired', 'unreleased'];
const CONFIDENCE = { high: '高', medium: '中', low: '低' };
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const VENDOR_PREFIXES = new Set(['openai', 'anthropic', 'meta', 'google', 'x-ai', 'xai', 'deepseek',
  'moonshotai', 'moonshot', 'z-ai', 'zhipu', 'qwen', 'dashscope', 'minimax', 'minimaxai',
  'volcengine', 'volcengine-plan', 'doubao', 'tencent', 'alibaba', 'ark']);
const SUFFIX_PATTERNS = [
  ['-vision-exp', /-vision-exp$/i], ['-experimental', /-experimental$/i],
  ['-expires-on-*', /-expires-on-[0-9a-z]+$/i], ['-ga-*', /-ga-[0-9a-z]+$/i],
  ['-contributor', /-contributor$/i], ['-preview', /-preview$/i], ['-free', /-free$/i],
  ['-latest', /-latest$/i], ['-build', /-build$/i], ['-exp', /-exp$/i],
  ['-YYYYMMDD', /-(19|20)\d{6}$/], ['-vN', /-v\d+$/i],
];
const KIND_BADGE = {
  exact: { tag: '[OK]', cn: '精确', cls: 'badge-current' },
  alias: { tag: '[A]', cn: '别名', cls: 'badge-accent' },
  legacy: { tag: '[L]', cn: '旧版 id', cls: 'badge-legacy' },
  normalized: { tag: '[~]', cn: '归一化', cls: 'badge-accent' },
  fuzzy: { tag: '[?]', cn: '未收录', cls: 'badge-unreleased' },
  none: { tag: '[?]', cn: '未收录', cls: 'badge-unreleased' },
};
const MISS_TEXT = '未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）';
const FALLBACK_NOTE = '未加载 ../lib/core.mjs，以下内容由页面内置逻辑生成，可能与 CLI 输出存在差异。';

/* 完整模式：catalog 里没有官方数据的字段一律不输出，只在提示里列出（与 CLI stderr 一致）。 */
const FULL_OMITTED = {
  opencode: ['cost', 'release_date', 'interleaved', 'experimental', 'options', 'headers'],
  pi: ['provider', 'baseUrl', 'compat', 'cost'],
};
const OPENCODE_STATUS = { current: 'active', legacy: 'deprecated', retired: 'deprecated', unreleased: 'beta' };
const PI_API_MAP = {
  anthropic_messages: 'anthropic-messages',
  responses: 'openai-responses',
  chat_completions: 'openai-completions',
  'responses|chat_completions': 'openai-responses',
};
const EXAMPLES = ['deepseek-v4.1-flash', 'claude-opus-5', 'glm-5-3-flash',
  'qwen3.5-plus-2026-04-20', 'muse-spark-1.2-contributor-free'];

const kindOf = (kind) => KIND_BADGE[kind] || KIND_BADGE.none;
const kindLabel = (kind) => { const meta = kindOf(kind); return meta.tag + ' ' + meta.cn; };

const state = {
  catalog: null, models: [], rows: [], filtered: [], q: '', vendor: null, lifecycle: 'all',
  verifiedOnly: false, activeIndex: 0, selectedId: null, detailKey: null, match: null,
  matchVisible: false, emitTab: 'opencode', emitFull: false, batch: [], coreError: null,
};

/* ------------------------------------------------------------ DOM 小工具 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
const span = (className, text) => el('span', className, text);

function add(parent, ...children) {
  for (const child of children) if (child) parent.appendChild(child);
  return parent;
}

const ICON_PATHS = {
  copy: ['M6.2 6.2h5.4a1.2 1.2 0 0 1 1.2 1.2v5.4a1.2 1.2 0 0 1-1.2 1.2H6.2A1.2 1.2 0 0 1 5 12.8V7.4a1.2 1.2 0 0 1 1.2-1.2z',
    'M9.8 6V4.4a1.2 1.2 0 0 0-1.2-1.2H4.4a1.2 1.2 0 0 0-1.2 1.2v4.2a1.2 1.2 0 0 0 1.2 1.2H6'],
  check: ['M3.5 8.4l3 3 6-7'],
  arrow: ['M3.5 8h9', 'M9.2 4.7 12.5 8l-3.3 3.3'],
  external: ['M6.8 3.6h5.6v5.6', 'M12.4 3.6 7.2 8.8',
    'M11.2 9.4v2.6a1.4 1.4 0 0 1-1.4 1.4H4.6a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4H7'],
};

function svgIcon(name, size = 13) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = { viewBox: '0 0 16 16', width: String(size), height: String(size), fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function badge(text, cls, title) {
  const node = el('span', ('badge ' + (cls || '')).trim(), text);
  if (title) node.title = title;
  return node;
}

function lifecycleBadge(lifecycle) {
  const meta = LIFECYCLE[lifecycle];
  return meta ? badge(lifecycle, meta.cls, meta.cn) : badge(lifecycle || 'unknown', '', '未标注生命周期');
}

function confidenceBadge(confidence) {
  return CONFIDENCE[confidence]
    ? badge('置信度 ' + CONFIDENCE[confidence], 'badge-confidence-' + confidence, '条目置信度：' + confidence)
    : null;
}

const fmtNum = (value) => (typeof value === 'number' && isFinite(value) ? value.toLocaleString('en-US') : null);

function fmtTokens(value) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  if (value >= 1e6) {
    const m = value / 1e6;
    return (m >= 10 ? String(Math.round(m)) : m.toFixed(1)) + 'M';
  }
  return value >= 1e3 ? Math.round(value / 1e3) + 'k' : String(value);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('is-on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-on'), 1600);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_err) { /* 走 execCommand 兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_err) {
    return false;
  }
}

function copyButton(getText, label = '复制') {
  const btn = el('button', 'copy-btn');
  btn.type = 'button';
  const labelNode = span('btn-label', label);
  add(btn, svgIcon('copy'), labelNode);
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const text = getText();
    if (text === null || text === undefined) return;
    if (!await copyText(String(text))) { toast('复制失败：浏览器拒绝了剪贴板访问'); return; }
    btn.classList.add('is-done');
    labelNode.textContent = '已复制';
    btn.replaceChild(svgIcon('check'), btn.querySelector('svg'));
    setTimeout(() => {
      btn.classList.remove('is-done');
      labelNode.textContent = label;
      btn.replaceChild(svgIcon('copy'), btn.querySelector('svg'));
    }, 1400);
  });
  return btn;
}

const emptyState = (title, hint) =>
  add(el('div', 'empty'), el('p', 'empty-title', title), el('p', 'empty-hint', hint));

/* --------------------------------------------------------- 共享逻辑加载 */

let core = null;
try {
  core = await import('../lib/core.mjs');
} catch (err) {
  core = null;
  state.coreError = err;
}
const hasCore = Boolean(core && typeof core.matchModel === 'function');

/* ------------------------------------------------------------- 降级实现 */
/* 与 lib/core.mjs（及 CLI apifix.mjs）行为对齐；仅在模块缺失或调用抛错时使用。 */

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

function matchFallback(models, input) {
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

const valOrNull = (entry, key) => (entry && entry[key] !== undefined ? entry[key] : null);

/* 与 core 一致的判定：NaN / Infinity / null 一律不算数字，数组不算对象。 */
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const isDict = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/* 从 entry.cost（一律 USD）构造 opencode 的 cost 字段；与 lib/core.mjs 的 opencodeCost 逐字对齐。
 * opencode schema 只接受数字，故 null 键一律省略；input/output 缺一即整体省略。 */
function opencodeCost(entry) {
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
function emitOpencodeFallback(entry, keyId, name, full) {
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

function emitPiFallback(entry, keyId, name, full) {
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
    // api 追加在末尾（core 不对 pi payload 排序），无法映射时省略。
    const protocol = valOrNull(entry || {}, 'api_protocol');
    const api = typeof protocol === 'string' ? PI_API_MAP[protocol] : undefined;
    if (api) payload.api = api;
  }
  return JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ 数据 */

async function loadCatalog() {
  const res = await fetch('../catalog.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  const data = await res.json();
  if (!data || !Array.isArray(data.models)) throw new Error('catalog.json 结构非法：缺少 models 数组');
  return data;
}

function toRow(entry) {
  const keys = [];
  for (const alias of entry.aliases || []) if (typeof alias === 'string') keys.push(alias);
  for (const legacy of entry.legacy_ids || []) if (legacy && legacy.id) keys.push(legacy.id);
  return { id: entry.id, vendor: entry.vendor || '', family: entry.family || '',
    lifecycle: entry.lifecycle || null, verified: entry.verified === true,
    confidence: entry.confidence || null, context: entry.context_window,
    output: entry.max_output_tokens, keys, entry };
}

function buildRows(catalog) {
  const local = (catalog.models || []).map(toRow)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!core || typeof core.listRows !== 'function') return local;
  try {
    const rows = core.listRows(catalog);
    if (!Array.isArray(rows) || !rows.length) return local;
    const byId = new Map(local.map((row) => [row.id, row]));
    const merged = [];
    for (const row of rows) {
      const base = row && row.id ? byId.get(row.id) : null;
      if (!base) continue;
      // 只吸收 core 提供的非空字段，避免 null 覆盖本地已规范化的默认值。
      const extra = {};
      for (const key of Object.keys(row)) {
        if (row[key] !== undefined && row[key] !== null) extra[key] = row[key];
      }
      merged.push({ ...base, ...extra, entry: base.entry });
    }
    return merged.length === local.length ? merged : local;
  } catch (err) {
    noteCoreError(err);
    return local;
  }
}

function runMatch(input) {
  if (!state.catalog || !input) return null;
  if (hasCore) {
    try {
      const res = core.matchModel(state.catalog, input);
      // core 的 note 只给第一条提示；notes 数组包含退役/未发布等附加警告，优先用它。
      if (res && Array.isArray(res.notes) && res.notes.length) {
        return { ...res, note: res.notes.join('\n') };
      }
      return res;
    } catch (err) {
      noteCoreError(err);
    }
  }
  return matchFallback(state.models, input);
}

/* 记录 core.mjs 的调用失败并刷新提示条，保证降级状态对用户可见。 */
function noteCoreError(err) {
  state.coreError = err;
  renderCoreNotice();
}

/* ------------------------------------------------------------ 渲染：rail */

function renderRail() {
  const chips = $('lifecycle-chips');
  const vendorList = $('vendor-list');
  chips.textContent = '';
  vendorList.textContent = '';

  const counts = { all: state.models.length };
  for (const lc of LIFECYCLE_ORDER) counts[lc] = 0;
  for (const model of state.models) if (counts[model.lifecycle] !== undefined) counts[model.lifecycle] += 1;

  for (const value of ['all'].concat(LIFECYCLE_ORDER)) {
    const chip = el('button', 'chip' + (state.lifecycle === value ? ' is-active' : ''));
    chip.type = 'button';
    chip.title = value === 'all' ? '显示全部生命周期' : LIFECYCLE[value].cn;
    add(chip, span(null, value === 'all' ? '全部' : value), span('chip-n', String(counts[value])));
    chip.addEventListener('click', () => {
      state.lifecycle = value;
      renderRail();
      renderList();
    });
    chips.appendChild(chip);
  }

  const vendorCounts = new Map();
  for (const model of state.models) {
    const vendor = model.vendor || 'unknown';
    vendorCounts.set(vendor, (vendorCounts.get(vendor) || 0) + 1);
  }
  const sorted = [...vendorCounts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  $('vendor-count').textContent = sorted.length + ' 个';
  for (const [vendor, count] of sorted) {
    const row = el('button', 'vendor-row' + (state.vendor === vendor ? ' is-active' : ''));
    row.type = 'button';
    add(row, span('vendor-name', vendor), span('vendor-n', String(count)));
    row.addEventListener('click', () => {
      state.vendor = state.vendor === vendor ? null : vendor;
      renderRail();
      renderList();
    });
    vendorList.appendChild(row);
  }
  $('verified-count').textContent = state.models.filter((m) => m.verified === true).length
    + ' / ' + state.models.length;
}

/* ------------------------------------------------------------ 渲染：列表 */

function filteredRows() {
  const needle = state.q.toLowerCase();
  const matchId = state.matchVisible && state.match ? state.match.matchedId : null;
  const rows = state.rows.filter((row) => {
    // 命中项永远保留：中转 id 的字面量通常不在任何 row 里，但它是主流程的结果。
    if (matchId && row.id === matchId) return true;
    if (state.vendor && row.vendor !== state.vendor) return false;
    if (state.lifecycle !== 'all' && row.lifecycle !== state.lifecycle) return false;
    if (state.verifiedOnly && !row.verified) return false;
    if (!needle) return true;
    return row.id.toLowerCase().includes(needle) || row.vendor.toLowerCase().includes(needle)
      || row.family.toLowerCase().includes(needle)
      || row.keys.some((key) => String(key).toLowerCase().includes(needle));
  });
  if (matchId) {
    const idx = rows.findIndex((row) => row.id === matchId);
    if (idx > 0) rows.unshift(rows.splice(idx, 1)[0]);
  }
  return rows;
}

function keyForRow(row) {
  const match = state.match;
  return (state.matchVisible && match && match.matchedId === row.id && match.input) ? match.input : row.id;
}

function renderList() {
  const listEl = $('list');
  listEl.textContent = '';
  if (!state.catalog) return;

  const rows = filteredRows();
  state.filtered = rows;
  $('result-count').textContent = '命中 ' + rows.length + ' / ' + state.rows.length + ' 条';
  if (!rows.length) {
    const hint = state.q
      ? '换个更短的片段，或清除厂商 / 生命周期筛选。'
      : '清除厂商 / 生命周期筛选，或调整搜索词。';
    listEl.appendChild(emptyState('无结果', hint));
    return;
  }
  if (state.activeIndex >= rows.length) state.activeIndex = 0;

  rows.forEach((row, index) => {
    const btn = el('button', 'row');
    btn.type = 'button';
    btn.dataset.index = String(index);
    if (index === state.activeIndex) btn.classList.add('is-active');
    if (row.id === state.selectedId) {
      btn.classList.add('is-selected');
      btn.setAttribute('aria-current', 'true');
    }
    btn.title = row.id + (row.verified ? '（已核验）' : '（未核验）');

    const badges = span('row-badges');
    add(badges, lifecycleBadge(row.lifecycle));
    if (!row.verified) add(badges, badge('未核验', 'badge-unverified', '该条目未与官网逐项核验'));

    const sub = span('row-sub');
    add(sub, span('row-vendor', row.vendor || '—'));
    if (row.family) add(sub, span('row-family', row.family));
    const spec = span('row-spec');
    add(spec, el('b', null, 'ctx '), span(null, fmtTokens(row.context) || '—'), span(null, ' / '),
      el('b', null, 'out '), span(null, fmtTokens(row.output) || '—'));
    spec.title = '上下文 ' + (fmtNum(row.context) || '未文档化') + ' tokens / 最大输出 '
      + (fmtNum(row.output) || '未文档化') + ' tokens';
    add(sub, spec);

    add(btn, span('row-id', row.id), badges, sub);
    btn.addEventListener('click', () => {
      state.activeIndex = index;
      openDetail(row.entry, keyForRow(row));
    });
    listEl.appendChild(btn);
  });
}

function renderMatchCard() {
  const slot = $('match-slot');
  slot.textContent = '';
  const match = state.match;
  if (!state.matchVisible || !match) return;

  const card = el('div', 'match-card' + (match.entry ? '' : ' is-miss'));
  const head = el('div', 'match-head');
  add(head, span('match-kicker', '匹配结果'), badge(kindLabel(match.kind), kindOf(match.kind).cls));
  if (match.entry && match.entry.lifecycle) add(head, lifecycleBadge(match.entry.lifecycle));
  if (match.entry && match.entry.verified !== true) add(head, badge('未核验', 'badge-unverified'));
  card.appendChild(head);

  const line = el('p', 'match-note');
  line.appendChild(span('match-input', match.input));
  if (match.matchedId) {
    line.appendChild(document.createTextNode(' → '));
    line.appendChild(span('match-canon', match.matchedId));
  }
  card.appendChild(line);

  if (match.note) card.appendChild(el('p', 'match-note is-pre', match.note));
  else if (match.entry) card.appendChild(el('p', 'match-note', '输入 id 与官网规范 id 一致。'));

  const actions = el('div', 'match-actions');
  if (match.entry) {
    const open = el('button', 'match-link');
    open.type = 'button';
    add(open, svgIcon('arrow'), span(null, ' 打开官网规格详情'));
    open.addEventListener('click', () => openDetail(match.entry, match.input));
    actions.appendChild(open);
  } else if (match.suggestion) {
    const tryBtn = el('button', 'match-link', '尝试最接近的 id：' + match.suggestion);
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', () => applySuggestion(match.suggestion));
    actions.appendChild(tryBtn);
  }
  if (actions.childNodes.length) card.appendChild(actions);
  slot.appendChild(card);
}

function applySuggestion(id) {
  const input = $('search');
  input.value = id;
  $('search-clear').hidden = false;
  updateSearch(id);
  input.focus();
}

/* ------------------------------------------------------------ 渲染：详情 */

const specSection = (title, warn) =>
  add(el('section', 'section'), el('h3', 'section-title' + (warn ? ' is-warn' : ''), title));

const UNKNOWN = '未知/not documented';

function specRow(grid, label, valueNode) {
  add(grid, el('dt', null, label), valueNode instanceof Node ? valueNode : el('dd', null, valueNode));
}

/* supported 三态：true/false/null 分别渲染为支持 / 不支持 / 未文档化。 */
function supportValue(supported, extras = []) {
  const dd = el('dd');
  if (supported === true) dd.textContent = '支持';
  else if (supported === false) dd.appendChild(span('unsupported', '不支持'));
  else dd.appendChild(span('muted', '未文档化'));
  for (const text of extras) if (text) dd.appendChild(span('spec-sub', text));
  return dd;
}

function tokenValue(value) {
  const dd = el('dd');
  if (typeof value !== 'number' || !isFinite(value)) return add(dd, span('muted', UNKNOWN));
  return add(dd, span('mono', fmtTokens(value)), span('spec-sub', fmtNum(value) + ' tokens'));
}

function flagValue(value) {
  const dd = el('dd');
  if (value === true) dd.textContent = '是';
  else if (value === false) dd.textContent = '否';
  else dd.appendChild(span('muted', UNKNOWN));
  return dd;
}

function samplingValue(cfg) {
  const conf = cfg || {};
  const bits = [];
  if (Array.isArray(conf.range) && conf.range.length === 2) bits.push('[' + conf.range[0] + ', ' + conf.range[1] + ']');
  for (const key of ['constraint', 'range_note']) if (conf[key]) bits.push(conf[key]);
  return supportValue(conf.supported, bits);
}

const chipRow = (className, values, isDefault) => {
  const box = el('div', className);
  for (const value of values) {
    const chip = span(className.replace('-chips', '-chip') + (isDefault(value) ? ' is-default' : ''), value);
    if (isDefault(value)) chip.title = '官网默认档位';
    box.appendChild(chip);
  }
  return box;
};

function reasoningValue(entry) {
  const dd = el('dd');
  const reasoning = entry.reasoning || {};
  const efforts = Array.isArray(reasoning.effort_values) ? reasoning.effort_values : [];
  if (reasoning.supported === true) {
    dd.appendChild(efforts.length
      ? chipRow('effort-chips', efforts, (value) => value === reasoning.default_effort)
      : span(null, '支持（档位未文档化）'));
  } else if (reasoning.supported === false) {
    dd.appendChild(span('unsupported', '不支持'));
  } else {
    dd.appendChild(span('muted', UNKNOWN));
  }
  if (reasoning.can_disable === true) dd.appendChild(span('spec-sub', '可通过参数关闭思考'));
  else if (reasoning.can_disable === false) dd.appendChild(span('spec-sub', '无法关闭思考'));
  const budget = reasoning.thinking_budget;
  if (budget && typeof budget === 'object') {
    const parts = [];
    if (budget.min !== null && budget.min !== undefined) parts.push('min=' + budget.min);
    if (budget.max !== null && budget.max !== undefined) parts.push('max=' + budget.max);
    if (budget.less_than_max_tokens === true) parts.push('< max_tokens');
    dd.appendChild(span('spec-sub', '思考预算：' + (parts.length ? parts.join('、') : '已文档化（无具体数值）')));
  }
  if (Array.isArray(reasoning.summary_values) && reasoning.summary_values.length) {
    dd.appendChild(span('spec-sub', '摘要模式：' + reasoning.summary_values.join(' / ')));
  }
  return dd;
}

function toolsValue(entry) {
  const tools = entry.tools || {};
  const subs = [];
  if (tools.parallel === true) subs.push('并行调用');
  if (tools.parallel === false) subs.push('不支持并行调用');
  if (tools.strict === true) subs.push('strict schema');
  if (tools.strict === false) subs.push('不支持 strict schema');
  const dd = supportValue(tools.function_calling, subs);
  if (Array.isArray(tools.choice_modes) && tools.choice_modes.length) {
    dd.appendChild(chipRow('choice-chips', tools.choice_modes.map(String), () => false));
  }
  return dd;
}

function cachingValue(entry) {
  const caching = entry.caching || {};
  const dd = el('dd');
  dd.appendChild(caching.mode ? span('mono', caching.mode) : span('muted', UNKNOWN));
  if (typeof caching.min_tokens === 'number') {
    dd.appendChild(span('spec-sub', '最小缓存 ' + fmtNum(caching.min_tokens) + ' tokens'));
  }
  if (Array.isArray(caching.ttl_options) && caching.ttl_options.length) {
    dd.appendChild(span('spec-sub', 'TTL：' + caching.ttl_options.join(' / ')));
  }
  return dd;
}

function renderSpecSection(model) {
  const sampling = model.sampling || {};
  const structured = model.structured_output || {};
  const grid = el('dl', 'spec');
  const rows = [
    ['上下文', tokenValue(model.context_window)],
    ['最大输出', tokenValue(model.max_output_tokens)],
    ['推理档位', reasoningValue(model)],
    ['temperature', samplingValue(sampling.temperature)],
    ['top_p', samplingValue(sampling.top_p)],
    ['top_k', samplingValue(sampling.top_k)],
    ['工具调用', toolsValue(model)],
    ['结构化输出', supportValue(structured.supported, [structured.mechanism])],
    ['缓存', cachingValue(model)],
    ['视觉', flagValue(model.vision)],
    ['PDF', flagValue(model.pdf)],
    ['协议', el('dd', 'mono', model.api_protocol || UNKNOWN)],
  ];
  for (const [label, value] of rows) specRow(grid, label, value);
  return add(specSection('规格'), grid);
}

function renderGotchasSection(model) {
  const gotchas = Array.isArray(model.gotchas) ? model.gotchas : [];
  const section = specSection('注意事项', gotchas.length > 0);
  if (!gotchas.length) return add(section, el('p', 'detail-empty', '暂无记录的注意事项。'));
  const list = el('div', 'gotchas');
  for (const gotcha of gotchas) add(list, add(el('div', 'gotcha'), span(null, String(gotcha))));
  return add(section, list);
}

function renderIdsSection(model) {
  const section = specSection('别名 / 旧版 ID');
  const aliases = Array.isArray(model.aliases) ? model.aliases : [];
  const legacies = (Array.isArray(model.legacy_ids) ? model.legacy_ids : [])
    .filter((legacy) => legacy && legacy.id);
  if (!aliases.length && !legacies.length) {
    return add(section, el('p', 'detail-empty', '无记录的别名或旧版 id。'));
  }
  const list = el('div', 'id-list');
  for (const alias of aliases) {
    add(list, add(el('div', 'id-item'), span('id-kind', '别名'), el('code', null, String(alias))));
  }
  for (const legacy of legacies) {
    add(list, add(el('div', 'id-item'), span('id-kind', '旧版'), el('code', null, String(legacy.id)),
      legacy.note ? span('id-note', String(legacy.note)) : null));
  }
  return add(section, list);
}

function renderSourcesSection(model) {
  const section = specSection('来源');
  const sources = Array.isArray(model.sources) ? model.sources : [];
  if (!sources.length) return add(section, el('p', 'detail-empty', '无来源记录。'));
  const list = el('div', 'src-list');
  for (const src of sources) {
    const url = String(src);
    let host = url;
    try { host = new URL(url).host; } catch (_err) { /* 保留原文 */ }
    const link = el('a', null, url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(svgIcon('external', 11));
    add(list, add(el('div', 'src-item'), span('src-host', host), link));
  }
  return add(section, list);
}

/* 完整模式下的省略字段提示（与 CLI stderr 的 note 对应）。动态去掉实际已输出的字段：
 * opencode 在能给出 cost 时去掉 'cost'；pi 无 cost 字段，故始终保留。api 无法映射时 pi 追加 'api'。 */
function fullOmittedCaption(target, entry) {
  const omitted = (FULL_OMITTED[target] || []).slice();
  if (target === 'opencode' && opencodeCost(entry)) {
    const idx = omitted.indexOf('cost');
    if (idx >= 0) omitted.splice(idx, 1);
  }
  if (target === 'pi') {
    const protocol = valOrNull(entry || {}, 'api_protocol');
    const api = typeof protocol === 'string' ? PI_API_MAP[protocol] : undefined;
    if (!api) omitted.push('api');
  }
  return omitted.length ? '未输出（catalog 无数据）：' + omitted.join(' · ') : '';
}

function renderSnippetSection(model, canonical, keyId) {
  const section = specSection('配置片段');
  const showCard = hasCore && typeof core.renderCard === 'function';
  if (state.emitTab === 'card' && !showCard) state.emitTab = 'opencode';

  // 卡片是 box 文本，没有精简/完整之分，因此只在 opencode / pi 下显示该开关。
  const showFullToggle = state.emitTab !== 'card';
  const bar = el('div', 'snippet-bar');
  const tabs = el('div', 'tabs-mini');
  const defs = [['opencode', 'opencode'], ['pi', 'pi']];
  if (showCard) defs.push(['card', '卡片']);
  for (const [value, label] of defs) {
    const tab = el('button', 'tab-mini' + (state.emitTab === value ? ' is-active' : ''), label);
    tab.type = 'button';
    tab.addEventListener('click', () => { state.emitTab = value; renderDetail(); });
    tabs.appendChild(tab);
  }
  bar.appendChild(tabs);

  if (showFullToggle) {
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', '输出详细程度');
    for (const [value, label] of [[false, '精简'], [true, '完整']]) {
      const active = state.emitFull === value;
      const btn = el('button', 'seg-btn' + (active ? ' is-active' : ''), label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.title = value
        ? '在片段中补上 catalog 可提供的字段（family / status / modalities 等）'
        : '只输出精简字段（与 CLI 默认一致）';
      btn.addEventListener('click', () => {
        if (state.emitFull === value) return;
        state.emitFull = value;
        renderDetail();
      });
      seg.appendChild(btn);
    }
    bar.appendChild(seg);
  }
  section.appendChild(bar);

  const full = showFullToggle && state.emitFull;
  const name = keyId;
  let issue = null;
  let text;
  const viaCore = (fn, fallback) => {
    if (!hasCore || typeof core[fn] !== 'function') { issue = FALLBACK_NOTE; return fallback(); }
    try {
      return String(core[fn](model, { name, keyId, id: keyId, full }) || '');
    } catch (err) {
      noteCoreError(err);
      issue = '调用 lib/core.mjs 生成片段失败，以下为内置降级输出：' + err.message;
      return fallback();
    }
  };
  if (state.emitTab === 'card') {
    try {
      text = String(core.renderCard(model) || '');
    } catch (err) {
      noteCoreError(err);
      text = '卡片渲染失败：' + err.message;
    }
  } else if (state.emitTab === 'pi') {
    text = viaCore('emitPi', () => emitPiFallback(model, keyId, name, full));
    if (model.vision === null || model.vision === undefined) {
      issue = (issue ? issue + '\n' : '') + 'vision 未文档化，pi input 仅含 text（需人工确认）。';
    }
  } else {
    text = viaCore('emitOpencode', () => emitOpencodeFallback(model, keyId, name, full));
  }

  const wrap = el('div', 'code-wrap');
  add(wrap, el('pre', 'code', text || '（空）'), copyButton(() => text, '复制'));
  section.appendChild(wrap);

  if (full) {
    const caption = fullOmittedCaption(state.emitTab, model);
    if (caption) section.appendChild(el('p', 'snippet-caption', caption));
  }

  const note = el('p', 'copy-note');
  if (keyId !== canonical) {
    add(note, document.createTextNode('key 沿用你输入的 id：'), span('mono', keyId),
      document.createTextNode('；数值取自官网条目 '), span('mono', canonical),
      document.createTextNode('，可直接替换中转配置里的同名条目。'));
  } else {
    add(note, document.createTextNode('key 使用官网规范 id：'), span('mono', canonical),
      document.createTextNode('。未文档化的值一律为 null / “未知，需确认”，不做猜测。'));
  }
  section.appendChild(note);
  if (issue) section.appendChild(el('p', 'snippet-issue is-pre', issue));
  return section;
}

function renderDetail() {
  const body = $('detail-body');
  body.textContent = '';
  const row = state.selectedId ? state.rows.find((item) => item.id === state.selectedId) : null;
  if (!row) {
    add(body, el('div', 'detail-empty'),
      el('p', null, '尚未选择模型'),
      el('p', null, '在左侧搜索中转 / 旧版 id（例如 deepseek-v4.1-flash），或从列表里选一行，这里会显示官网规格、注意事项与配置片段。'));
    return;
  }

  const model = row.entry;
  const canonical = model.id;
  const keyId = state.detailKey || canonical;

  const idRow = el('div', 'detail-id-row');
  const idCopy = copyButton(() => canonical, '复制');
  idCopy.setAttribute('aria-label', '复制规范 id');
  add(idRow, el('div', 'detail-id', canonical), idCopy);
  body.appendChild(idRow);
  add(body, el('p', 'detail-sub',
    [model.vendor || 'unknown', model.family || '?', model.api_protocol || '?'].join(' / ')));

  const badges = el('div', 'detail-badges');
  add(badges, lifecycleBadge(model.lifecycle), model.verified === true
    ? badge('已核验', 'badge-verified', '已与官方文档逐项核验')
    : badge('未核验', 'badge-unverified', '来源间接或待核验'));
  const conf = confidenceBadge(model.confidence);
  if (conf) badges.appendChild(conf);
  body.appendChild(badges);

  if (model.lifecycle_note) {
    const cls = model.lifecycle === 'retired' ? 'info-line is-danger'
      : (model.lifecycle === 'legacy' || model.lifecycle === 'unreleased') ? 'info-line is-warn'
        : 'info-line';
    add(body, el('p', cls, model.lifecycle_note));
  }

  add(body, renderSpecSection(model), renderGotchasSection(model), renderIdsSection(model),
    renderSnippetSection(model, canonical, keyId), renderSourcesSection(model));
}

/* ------------------------------------------------------------ 详情开关 */

const mqDetail = window.matchMedia('(max-width: 1100px)');
const mqRail = window.matchMedia('(max-width: 760px)');

function updateScrim() {
  const detailOpen = mqDetail.matches && $('detail-pane').classList.contains('is-open');
  const railOpen = mqRail.matches && $('rail').classList.contains('is-open');
  $('scrim').hidden = !(detailOpen || railOpen);
}

function openDetail(entry, keyId) {
  if (!entry) return;
  state.selectedId = entry.id;
  state.detailKey = keyId || entry.id;
  renderDetail();
  renderList();
  if (mqDetail.matches) $('detail-pane').classList.add('is-open');
  $('detail-body').scrollTop = 0;
  updateScrim();
}

function closeDetail() {
  $('detail-pane').classList.remove('is-open');
  updateScrim();
}

function closeRail() {
  $('rail').classList.remove('is-open');
  updateScrim();
}

function closeOverlays() {
  closeDetail();
  closeRail();
}

/* -------------------------------------------------------- 搜索 / 键盘 */

function updateMatch() {
  const q = state.q;
  if (!q) {
    state.match = null;
    state.matchVisible = false;
    renderMatchCard();
    return;
  }
  const match = runMatch(q);
  state.match = match;
  const exactSelf = match && match.kind === 'exact' && match.matchedId
    && match.matchedId.toLowerCase() === q.toLowerCase();
  state.matchVisible = Boolean(match) && !exactSelf;
  renderMatchCard();
}

function updateSearch(value) {
  state.q = String(value || '').trim();
  state.activeIndex = 0;
  updateMatch();
  renderList();
}

const debouncedSearch = debounce(updateSearch, 140);

function moveActive(delta) {
  const rows = state.filtered;
  if (!rows || !rows.length) return;
  const next = Math.max(0, Math.min(rows.length - 1, state.activeIndex + delta));
  if (next === state.activeIndex) return;
  const listEl = $('list');
  const prev = listEl.querySelector('.row.is-active');
  if (prev) prev.classList.remove('is-active');
  state.activeIndex = next;
  const node = listEl.querySelector('.row[data-index="' + next + '"]');
  if (!node) return;
  node.classList.add('is-active');
  node.scrollIntoView({ block: 'nearest' });
  if (document.activeElement !== $('search')) node.focus({ preventScroll: true });
}

function openActive() {
  const match = state.match;
  if (state.matchVisible && match) {
    if (match.entry) openDetail(match.entry, match.input);
    else if (match.suggestion) applySuggestion(match.suggestion);
    return;
  }
  const row = (state.filtered || [])[state.activeIndex];
  if (row) openDetail(row.entry, keyForRow(row));
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.key === 'Escape') {
      if (!$('detail-pane').classList.contains('is-open') && !$('rail').classList.contains('is-open')) return;
      closeOverlays();
      return;
    }
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement) return; // 搜索框自行处理方向键 / Enter
    if ($('view-batch').hidden === false) return; // 批量视图不驱动列表选择
    if (event.key === '/') {
      event.preventDefault();
      $('search').focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLAnchorElement)) {
      event.preventDefault();
      openActive();
    }
  });
}

/* ------------------------------------------------------------ 视图切换 */

function switchView(view) {
  const isBatch = view === 'batch';
  $('view-lookup').hidden = isBatch;
  $('view-batch').hidden = !isBatch;
  for (const tab of $('tabs').querySelectorAll('.tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  closeOverlays();
  if (isBatch) $('batch-input').focus();
  else $('search').focus();
}

/* ------------------------------------------------------------ 批量解析 */

function runBatch() {
  const box = $('batch-result');
  box.textContent = '';
  const lines = $('batch-input').value.split('\n')
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

  if (!state.catalog) {
    box.appendChild(emptyState('catalog.json 尚未加载', '请先解决上方的加载错误再解析。'));
    return;
  }
  if (!lines.length) {
    state.batch = [];
    $('batch-copy').disabled = true;
    $('batch-meta').textContent = '';
    box.appendChild(emptyState('没有输入', '每行粘贴一个模型 id，然后点击「解析」。'));
    return;
  }

  state.batch = lines.map((line) => ({ line, match: runMatch(line) }));
  const misses = state.batch.filter((item) => !item.match || !item.match.entry).length;

  const table = el('table', 'batch-table');
  const headRow = el('tr');
  for (const label of ['输入', '匹配', '规范 id', '生命周期', '备注']) headRow.appendChild(el('th', null, label));
  add(table, add(el('thead'), headRow));

  const tbody = el('tbody');
  for (const { line, match } of state.batch) {
    const tr = el('tr');
    if (!match || !match.entry) tr.classList.add('is-miss');
    tr.appendChild(el('td', 'cell-input', line));
    add(tr, add(el('td'), badge(kindLabel(match && match.kind), kindOf(match && match.kind).cls)));

    const idCell = el('td', 'cell-id');
    if (match && match.entry) {
      const btn = el('button', null, match.matchedId);
      btn.type = 'button';
      btn.title = '在单条查询中打开';
      btn.addEventListener('click', () => {
        switchView('lookup');
        const input = $('search');
        input.value = line;
        $('search-clear').hidden = false;
        updateSearch(line);
        openDetail(match.entry, line);
      });
      idCell.appendChild(btn);
    } else {
      idCell.appendChild(span('muted', '未收录'));
    }
    tr.appendChild(idCell);

    const lcCell = el('td');
    lcCell.appendChild(match && match.entry ? lifecycleBadge(match.entry.lifecycle) : span('muted', '—'));
    tr.appendChild(lcCell);

    const noteCell = el('td', 'cell-note');
    if (match && match.entry) {
      noteCell.textContent = match.note || (match.kind === 'exact' ? '与官网规范 id 一致' : '');
    } else {
      noteCell.appendChild(span(null, MISS_TEXT));
      if (match && match.suggestion) noteCell.appendChild(span('muted', ' 最接近: ' + match.suggestion));
    }
    tr.appendChild(noteCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  box.appendChild(add(el('div', 'batch-table-wrap'), table));
  $('batch-meta').textContent = '解析 ' + lines.length + ' 行 · 未收录 ' + misses + ' 行';
  $('batch-copy').disabled = false;
}

function batchCopyText() {
  const out = ['输入\t匹配\t规范 id\t生命周期\t备注'];
  for (const { line, match } of state.batch) {
    const kind = kindLabel(match && match.kind);
    if (match && match.entry) {
      out.push([line, kind, match.matchedId, match.entry.lifecycle || '',
        (match.note || '').replace(/\n/g, ' ')].join('\t'));
    } else {
      const tail = match && match.suggestion ? '未收录（最接近: ' + match.suggestion + '）' : '未收录';
      out.push([line, kind, tail, '', ''].join('\t'));
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------ 错误 / 元信息 */

function renderLoadError(error) {
  const listEl = $('list');
  listEl.textContent = '';
  listEl.appendChild(add(el('div', 'error-box'),
    el('p', 'error-title', 'catalog.json 加载失败'),
    el('p', 'error-detail', error && error.message ? error.message : String(error)),
    el('p', 'empty-hint', '请用 npm start（= node apifix.mjs --ui）启动，或从项目根目录起一个静态服务后访问 /ui/，并确认 ../catalog.json 可访问。')));
  $('result-count').textContent = '加载失败';
  $('catalog-meta').textContent = 'catalog.json 不可用';
  renderDetail();
}

function renderCoreNotice() {
  if (!state.coreError) return;
  const notice = $('core-notice');
  notice.hidden = false;
  notice.textContent = hasCore
    ? 'lib/core.mjs 部分调用失败，相关结果已回退到内置实现。'
    : '未加载 ../lib/core.mjs：匹配与配置片段使用内置降级逻辑，结果可能与 CLI 有细微差异；浏览与筛选不受影响。';
}

function renderMeta() {
  if (!state.catalog) return;
  const vendors = new Set(state.models.map((model) => model.vendor));
  $('catalog-meta').textContent = state.models.length + ' 条 · ' + vendors.size + ' 个厂商 · 更新 '
    + (state.catalog.updated_at || '未知');
}

function renderAll() {
  renderRail();
  renderList();
  renderDetail();
  renderMeta();
}

/* ------------------------------------------------------------ 初始化 */

function bindEvents() {
  const search = $('search');
  search.addEventListener('input', () => {
    $('search-clear').hidden = !search.value;
    debouncedSearch(search.value);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openActive();
    }
  });
  $('search-clear').addEventListener('click', () => {
    search.value = '';
    $('search-clear').hidden = true;
    updateSearch('');
    search.focus();
  });

  $('verified-only').addEventListener('change', (event) => {
    state.verifiedOnly = event.target.checked;
    state.activeIndex = 0;
    renderList();
  });
  $('rail-open').addEventListener('click', () => {
    $('rail').classList.add('is-open');
    updateScrim();
  });
  $('rail-close').addEventListener('click', closeRail);
  $('detail-close').addEventListener('click', closeDetail);
  $('scrim').addEventListener('click', closeOverlays);

  for (const tab of $('tabs').querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  $('batch-run').addEventListener('click', runBatch);
  $('batch-example').addEventListener('click', () => {
    $('batch-input').value = EXAMPLES.join('\n');
    $('batch-input').focus();
  });
  $('batch-clear').addEventListener('click', () => {
    $('batch-input').value = '';
    state.batch = [];
    $('batch-result').textContent = '';
    $('batch-meta').textContent = '';
    $('batch-copy').disabled = true;
    $('batch-input').focus();
  });
  $('batch-copy').addEventListener('click', async () => {
    const ok = await copyText(batchCopyText());
    toast(ok ? '已复制全部结果（制表符分隔）' : '复制失败：浏览器拒绝了剪贴板访问');
  });

  mqDetail.addEventListener('change', (event) => {
    if (!event.matches) closeDetail();
    updateScrim();
  });
  mqRail.addEventListener('change', (event) => {
    if (!event.matches) closeRail();
    updateScrim();
  });
}

async function init() {
  bindEvents();
  bindKeyboard();
  renderCoreNotice();

  const listEl = $('list');
  const skeleton = el('div', 'skeleton');
  for (let i = 0; i < 7; i += 1) skeleton.appendChild(el('div', 'sk-row'));
  listEl.appendChild(skeleton);

  try {
    state.catalog = await loadCatalog();
    state.models = state.catalog.models;
    state.rows = buildRows(state.catalog);
    listEl.textContent = '';
    renderAll();
    renderCoreNotice();
  } catch (err) {
    renderLoadError(err);
  }
}

init();
