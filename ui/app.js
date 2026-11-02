/* apifix ui — 单页应用，零依赖，ES module，离线可用。
 * 数据：fetch('../catalog.json')；共享逻辑：../lib/core.mjs（import 失败则降级，页面不崩）。
 * 降级实现：./fallback.mjs（行为对齐 core 的内置实现，见不变量 2；展示层全量 import）。
 * 所有动态文本经 textContent / createElement 写入，不使用 innerHTML。
 */

import {
  FALLBACK_NOTE, MISS_TEXT, FULL_OMITTED, valOrNull, opencodeCost, mapPiApi,
} from './fallback.mjs';

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
const KIND_BADGE = {
  exact: { tag: '[OK]', cn: '精确', cls: 'badge-current' },
  alias: { tag: '[A]', cn: '别名', cls: 'badge-accent' },
  legacy: { tag: '[L]', cn: '旧版 id', cls: 'badge-legacy' },
  normalized: { tag: '[~]', cn: '归一化', cls: 'badge-accent' },
  fuzzy: { tag: '[?]', cn: '未收录', cls: 'badge-unreleased' },
  none: { tag: '[?]', cn: '未收录', cls: 'badge-unreleased' },
};
const EXAMPLES = ['deepseek-v4.1-flash', 'claude-opus-5', 'glm-5-3-flash',
  'qwen3.5-plus-2026-04-20', 'muse-spark-1.2-contributor-free'];

const kindOf = (kind) => KIND_BADGE[kind] || KIND_BADGE.none;
const kindLabel = (kind) => { const meta = kindOf(kind); return meta.tag + ' ' + meta.cn; };

const state = {
  catalog: null, models: [], rows: [], filtered: [], q: '', vendor: null, lifecycle: 'all',
  verifiedOnly: false, activeIndex: 0, selectedId: null, detailKey: null, match: null,
  matchVisible: false, emitTab: 'opencode', emitFull: false, batch: [], coreError: null,
  fallbackError: null,
  config: {
    platform: 'opencode',
    baseURL: '',
    apiKey: '',
    providerName: '',
    protocol: 'openai',
    showKey: false,
    models: [],
    viewMode: 'snippet',
    keepKey: true,
    sniffing: false,
    sniffResult: null,
    sniffFilter: '',
    sniffSelected: new Set(),
    local: null,
    localLoading: false,
    localError: null,
    injecting: false,
    injectingInto: null,
    deleting: false,
    pendingDelete: null,
    editing: false,
    activeLocalProvider: {},
    filePreviewOpen: false,
  },
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

/* core 优先（正典），加载失败或调用抛错时降级到 ./fallback.mjs（语义与接线见下方函数）。
 * 展示层辅助（valOrNull / opencodeCost / mapPiApi / FULL_OMITTED 等）core 不导出，
 * 一律取自顶部对 fallback.mjs 的静态 import。 */
let core = null;
try {
  core = await import('../lib/core.mjs');
} catch (err) {
  core = null;
  state.coreError = err;
}
const hasCore = Boolean(core && typeof core.matchModel === 'function');

/* ------------------------------------------------------------ 降级接线 */

/* fallback 命名空间：几乎总是可用（与 app.js 同目录、纯函数模块，且已被顶部
 * 静态 import 拉起）；这里动态 import 仅为拿到统一入口，失败时置 null，
 * 由 runMatch / renderSnippetSection 的调用处兜住，页面不崩。 */
let fallback = null;
try {
  fallback = await import('./fallback.mjs');
} catch (err) {
  fallback = null;
  state.fallbackError = err;
}

const matchFallback = (models, input) => (fallback ? fallback.matchFallback(models, input) : null);
const emitOpencodeFallback = (entry, keyId, name, full) =>
  (fallback ? fallback.emitOpencodeFallback(entry, keyId, name, full) : null);
const emitPiFallback = (entry, keyId, name, full) =>
  (fallback ? fallback.emitPiFallback(entry, keyId, name, full) : null);
const emitExtraFallback = (entry, target, keyId, name, full) =>
  (fallback ? fallback.emitExtraFallback(entry, target, keyId, name, full) : null);

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

/* 构建列表行：core 可用时直接用 core.listRows()（正典），否则退回本地 toRow。
 * core 行字段是 {id, vendor, family, lifecycle, verified, context_window,
 * max_output_tokens, reasoning}，这里补上 UI 需要的 entry 引用与 keys（与
 * toRow 同规则），保证两条路径产出的行字段形态一致。 */
function buildRows(catalog) {
  const models = catalog.models || [];
  if (typeof core?.listRows !== 'function') {
    return models.map(toRow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  try {
    return core.listRows(catalog).map((row) => {
      const entry = (row && row.id !== undefined && row.id !== null)
        ? models.find((m) => m.id === row.id) : null;
      const keys = [];
      for (const alias of entry?.aliases || []) if (typeof alias === 'string') keys.push(alias);
      for (const legacy of entry?.legacy_ids || []) if (legacy && legacy.id) keys.push(legacy.id);
    return { ...row, entry, keys,
      vendor: row.vendor || '',
      family: row.family || '',
      verified: row.verified === true,
      context: entry ? entry.context_window : row.context_window,
      output: entry ? entry.max_output_tokens : row.max_output_tokens };
    });
  } catch (err) {
    noteCoreError(err);
    return models.map(toRow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
 * opencode 在能给出 cost 时去掉 'cost'；pi 无 cost 字段，故始终保留。
 * api 用与 core 语义一致的 mapPiApi（取首段 pipe 值）判断能否映射，映射不到时提示追加 'api'。 */
function fullOmittedCaption(target, entry) {
  // codex / claude-env 的完整模式是「配置文件级」片段：提示占位符与形态
  if (target === 'codex') return '完整模式含占位符（base_url / env_key），替换后再使用。';
  if (target === 'claude-env') {
    return '完整模式输出 ~/.claude/settings.json 的 env 块（值均为字符串），BASE_URL / AUTH_TOKEN 为占位符。';
  }
  const omitted = (FULL_OMITTED[target] || []).slice();
  if (target === 'opencode' && opencodeCost(entry)) {
    const idx = omitted.indexOf('cost');
    if (idx >= 0) omitted.splice(idx, 1);
  }
  if (target === 'pi') {
    const protocol = valOrNull(entry || {}, 'api_protocol');
    const api = mapPiApi(protocol);
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
  const defs = [['opencode', 'opencode'], ['pi', 'pi'], ['codex', 'codex'], ['claude-env', 'claude']];
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
  const viaCore = (fn, fallbackEmit, invoke) => {
    if (!hasCore || typeof core[fn] !== 'function') { issue = FALLBACK_NOTE; return fallbackEmit(); }
    try {
      const out = invoke ? invoke(core[fn]) : core[fn](model, { name, keyId, id: keyId, full });
      return String(out || '');
    } catch (err) {
      noteCoreError(err);
      issue = '调用 lib/core.mjs 生成片段失败，以下为内置降级输出：' + err.message;
      return fallbackEmit();
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
  } else if (state.emitTab === 'codex' || state.emitTab === 'claude-env') {
    const target = state.emitTab;
    text = viaCore('emitExtra',
      () => emitExtraFallback(model, target, keyId, name, full),
      (fn) => fn(model, target, { name, keyId: keyId, full }));
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
  const addCfg = el('button', 'btn detail-add-cfg', '加入配置');
  addCfg.type = 'button';
  addCfg.title = '把该模型加入 API 配置页的已选列表';
  addCfg.addEventListener('click', () => addModelToConfig(keyId));
  add(idRow, el('div', 'detail-id', canonical), idCopy, addCfg);
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
      if (!$('cfg-inject-overlay').hidden) {
        closeInjectDialog();
        return;
      }
      if (!$('cfg-delete-overlay').hidden) {
        closeDeleteDialog();
        return;
      }
      if (!$('cfg-edit-overlay').hidden) {
        closeEditDialog();
        return;
      }
      if (!$('detail-pane').classList.contains('is-open') && !$('rail').classList.contains('is-open')) return;
      closeOverlays();
      return;
    }
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement) return; // 搜索框自行处理方向键 / Enter
    if ($('view-batch').hidden === false || $('view-config').hidden === false) return; // 批量或配置视图不驱动列表选择
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
  const isConfig = view === 'config';
  const isLookup = view === 'lookup';
  closeInjectDialog();
  closeDeleteDialog();
  closeEditDialog();
  $('view-lookup').hidden = !isLookup;
  $('view-batch').hidden = !isBatch;
  $('view-config').hidden = !isConfig;
  for (const tab of $('tabs').querySelectorAll('.tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  closeOverlays();
  if (isBatch) $('batch-input').focus();
  else if (isConfig) {
    renderConfigView();
    loadLocalConfig();
    $('cfg-base-url').focus();
  } else {
    $('search').focus();
  }
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

/* ------------------------------------------------------------ API 配置生成与嗅探 */

const PLATFORM_DEFS = {
  opencode: {
    name: 'OpenCode',
    file: 'opencode.json',
    path: '~/.config/opencode/opencode.json',
    protocols: [
      { value: 'openai', label: 'OpenAI 兼容 (@ai-sdk/openai-compatible)', hint: '适用于绝大多数 OpenAI 兼容中转与官方服务' },
      { value: 'openai-native', label: 'OpenAI 原生 (@ai-sdk/openai)', hint: '适用于 OpenAI 官方端点，支持 Responses API' },
      { value: 'anthropic', label: 'Anthropic 原生 (@ai-sdk/anthropic)', hint: '适用于 Anthropic 官方及原生端点' },
      { value: 'gemini', label: 'Google Gemini (@ai-sdk/google)', hint: '适用于 Google Gemini 官方端点' },
    ],
    defaultProtocol: 'openai',
    tips: '生成的 provider 块可直接放入 ~/.config/opencode/opencode.json 的 provider 节点下。',
  },
  pi: {
    name: 'Pi',
    file: 'models.json',
    path: '~/.pi/agent/models.json',
    protocols: [
      { value: 'openai-completions', label: 'openai-completions (Chat Completions)', hint: '最常见的 OpenAI 兼容对话接口' },
      { value: 'openai-responses', label: 'openai-responses (Responses API)', hint: 'OpenAI 最新的 Responses API' },
      { value: 'anthropic-messages', label: 'anthropic-messages (Messages API)', hint: 'Anthropic 格式消息接口' },
    ],
    defaultProtocol: 'openai-completions',
    tips: '生成的 providers 块可直接放入 ~/.pi/agent/models.json 的 providers 节点下。',
  },
  codex: {
    name: 'Codex',
    file: 'config.toml',
    path: '~/.codex/config.toml',
    protocols: [
      { value: 'chat', label: 'wire_api = "chat" (Chat Completions)', hint: 'OpenAI Chat Completions 协议' },
      { value: 'responses', label: 'wire_api = "responses" (Responses API)', hint: 'OpenAI Responses 协议' },
    ],
    defaultProtocol: 'chat',
    tips: '生成的内容可放入 ~/.codex/config.toml 中。首个选中的模型将自动作为激活 model。',
  },
  claude: {
    name: 'Claude Code',
    file: 'settings.json',
    path: '~/.claude/settings.json',
    protocols: [
      { value: 'anthropic_messages', label: 'Anthropic Messages 格式', hint: 'Claude Code 默认的消息接口' },
    ],
    defaultProtocol: 'anthropic_messages',
    tips: '生成的内容可放入 ~/.claude/settings.json 的 env 节点中，或直接在 Shell 中 export 环境变量。',
  },
};

function tomlEscapeStr(val) {
  return JSON.stringify(String(val === null || val === undefined ? '' : val));
}

function tomlFormatKey(key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return tomlEscapeStr(key);
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function deriveNameFromUrl(urlString) {
  if (!urlString) return '';
  try {
    const parsed = new URL(urlString);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '';
    const parts = host.split('.');
    if (parts[0] === 'api' || parts[0] === 'v1') {
      if (parts.length > 1) return parts[1].replace(/[^a-z0-9-]/g, '');
    }
    return parts[0].replace(/[^a-z0-9-]/g, '');
  } catch {
    return '';
  }
}

function getOpencodeSpec(rawId) {
  const match = runMatch(rawId);
  if (match && match.entry) {
    try {
      const jsonStr = hasCore && typeof core.emitOpencode === 'function'
        ? core.emitOpencode(match.entry, { name: rawId, keyId: rawId, full: false })
        : emitOpencodeFallback(match.entry, rawId, rawId, false);
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed[rawId]) return parsed[rawId];
    } catch (_e) { /* 降级 */ }
  }
  return { name: rawId };
}

function getPiSpec(rawId) {
  const match = runMatch(rawId);
  if (match && match.entry) {
    try {
      const jsonStr = hasCore && typeof core.emitPi === 'function'
        ? core.emitPi(match.entry, { name: rawId, id: rawId, full: false })
        : emitPiFallback(match.entry, rawId, rawId, false);
      const parsed = JSON.parse(jsonStr);
      if (parsed) return parsed;
    } catch (_e) { /* 降级 */ }
  }
  return {
    id: rawId,
    name: rawId,
    reasoning: false,
    input: ['text'],
    contextWindow: null,
    maxTokens: null,
  };
}

function getCodexEffort(rawId) {
  const match = runMatch(rawId);
  if (match && match.entry) {
    const reasoning = match.entry.reasoning || {};
    if (reasoning.default_effort) return reasoning.default_effort;
    if (Array.isArray(reasoning.effort_values) && reasoning.effort_values.length) {
      return reasoning.effort_values[0];
    }
  }
  return null;
}

function getClaudeSpecs(rawId) {
  const match = runMatch(rawId);
  if (match && match.entry) {
    const reasoning = match.entry.reasoning || {};
    let effort = reasoning.default_effort;
    if (!effort && Array.isArray(reasoning.effort_values) && reasoning.effort_values.length) {
      effort = reasoning.effort_values[0];
    }
    let budget = null;
    if (reasoning.thinking_budget && typeof reasoning.thinking_budget === 'object') {
      budget = reasoning.thinking_budget.min || null;
    }
    return { effort, budget };
  }
  return { effort: null, budget: null };
}

async function sniffModels(baseURL, apiKey) {
  const cleanBase = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!cleanBase) throw new Error('请输入 API 地址 (Base URL)');
  if (!/^https?:\/\//i.test(cleanBase)) throw new Error('API 地址必须以 http:// 或 https:// 开头');

  // 1. 优先尝试向本地 UI 服务的 /api/models 接口请求
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: cleanBase, apiKey: apiKey ? apiKey.trim() : '' }),
    });
    if (res.status !== 404 && res.status !== 405) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.models)) {
        return data.models;
      }
      throw new Error(data && data.error ? data.error : ('嗅探失败 (HTTP ' + res.status + ')'));
    }
  } catch (err) {
    if (err && err.message && !err.message.includes('404') && !err.message.includes('405') && !err.message.includes('Failed to fetch')) {
      throw err;
    }
  }

  // 2. 静态页面降级：由浏览器直接 fetch（多路径尝试）
  const hdrs = {};
  if (apiKey && apiKey.trim()) hdrs.Authorization = 'Bearer ' + apiKey.trim();
  // 候选 URL：原始 + /v1 回退（或去掉 /v1 回退）
  const candidates = [cleanBase + '/models'];
  if (/\/v\d+$/i.test(cleanBase)) {
    candidates.push(cleanBase.replace(/\/v\d+$/i, '') + '/models');
  } else {
    candidates.push(cleanBase + '/v1/models');
  }
  let lastErr = null;
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { headers: hdrs, signal: controller.signal });
      if (!res.ok) {
        if ([404, 403, 405].includes(res.status) && candidates.indexOf(url) < candidates.length - 1) {
          lastErr = new Error('供应商返回 HTTP ' + res.status + ' (' + (res.statusText || '请求失败') + ')');
          continue;
        }
        throw new Error('供应商返回 HTTP ' + res.status + ' (' + (res.statusText || '请求失败') + ')');
      }
      const data = await res.json();
      const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : null);
      if (!list) throw new Error('返回数据非 OpenAI 兼容格式（缺少 data 列表）');
      const ids = list
        .map((item) => (item && typeof item === 'object' && typeof item.id === 'string' ? item.id : (typeof item === 'string' ? item : null)))
        .filter(Boolean);
      if (!ids.length) throw new Error('供应商返回的模型列表为空');
      return ids;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('嗅探超时（8 秒无响应），请检查网络或地址');
      }
      if (err && err.name === 'TypeError' && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
        throw new Error('浏览器跨域受限 (CORS)。请使用本地服务 npm start 启动 apifix 即可畅通嗅探！');
      }
      lastErr = err;
      // 非重试类错误（CORS/超时/网络）直接抛出
      if (err && (err.name === 'AbortError' || err.name === 'TypeError')) throw err;
      // HTTP 非 404 类错误也直接抛出
      if (candidates.indexOf(url) >= candidates.length - 1) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('嗅探失败');
}

function generateConfigCode() {
  const p = state.config.platform;
  const baseURL = state.config.baseURL.trim() || 'https://api.openai.com/v1';
  const apiKey = state.config.apiKey.trim();
  const keyVal = (state.config.keepKey && apiKey) ? apiKey : 'YOUR_API_KEY';
  const pName = state.config.providerName.trim() || deriveNameFromUrl(baseURL) || 'my-provider';
  const models = state.config.models.length ? state.config.models : ['gpt-4o'];
  const full = state.config.viewMode === 'full';

  if (p === 'opencode') {
    const npmMap = {
      openai: '@ai-sdk/openai-compatible',
      'openai-native': '@ai-sdk/openai',
      anthropic: '@ai-sdk/anthropic',
      gemini: '@ai-sdk/google',
    };
    const npmPkg = npmMap[state.config.protocol] || '@ai-sdk/openai-compatible';
    const modelsDict = {};
    for (const id of models) {
      modelsDict[id] = getOpencodeSpec(id);
    }
    const block = {
      npm: npmPkg,
      options: { baseURL, apiKey: keyVal },
      models: modelsDict,
    };
    if (full) {
      return JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: { [pName]: block },
      }, null, 2);
    }
    return JSON.stringify({
      provider: { [pName]: block },
    }, null, 2);
  }

  if (p === 'pi') {
    const modelsArr = models.map((id) => getPiSpec(id));
    const block = {
      baseURL,
      apiKey: keyVal,
      api: state.config.protocol || 'openai-completions',
      models: modelsArr,
    };
    return JSON.stringify({
      providers: { [pName]: block },
    }, null, 2);
  }

  if (p === 'codex') {
    const mainModel = models[0] || 'gpt-4o';
    const effort = getCodexEffort(mainModel);
    const lines = [];
    lines.push('model = ' + tomlEscapeStr(mainModel));
    lines.push('model_provider = ' + tomlEscapeStr(pName));
    if (effort) {
      lines.push('model_reasoning_effort = ' + tomlEscapeStr(effort));
    } else {
      lines.push('# model_reasoning_effort = "medium"  # 该模型未文档化推理档位');
    }
    if (models.length > 1) {
      lines.push('');
      lines.push('# 备选模型列表（将上方 model 替换为下列之一即可）：');
      for (const alt of models.slice(1)) {
        lines.push('# model = ' + tomlEscapeStr(alt));
      }
    }
    lines.push('');
    lines.push('[model_providers.' + tomlFormatKey(pName) + ']');
    lines.push('name = ' + tomlEscapeStr(pName));
    lines.push('base_url = ' + tomlEscapeStr(baseURL));
    lines.push('wire_api = ' + tomlEscapeStr(state.config.protocol || 'chat'));
    lines.push('experimental_bearer_token = ' + tomlEscapeStr(keyVal));
    lines.push('# env_key = "YOUR_API_KEY_ENV"  # 也可通过环境变量指定 Key');
    return lines.join('\n');
  }

  if (p === 'claude') {
    const mainModel = models[0] || 'claude-3-7-sonnet-20250219';
    const { effort, budget } = getClaudeSpecs(mainModel);
    const env = {
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_AUTH_TOKEN: keyVal,
      ANTHROPIC_MODEL: mainModel,
    };
    if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    if (budget) env.MAX_THINKING_TOKENS = String(budget);
    return JSON.stringify({ env }, null, 2);
  }

  return '// 未知平台';
}

function renderConfigView() {
  const p = state.config.platform;
  const def = PLATFORM_DEFS[p] || PLATFORM_DEFS.opencode;

  // 平台 tabs
  const tabs = document.querySelectorAll('#platform-bar .platform-tab');
  for (const tab of tabs) {
    const active = tab.dataset.platform === p;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  // 协议下拉列表
  const protoSelect = $('cfg-protocol');
  const currentProto = state.config.protocol || def.defaultProtocol;
  protoSelect.textContent = '';
  for (const item of def.protocols) {
    const opt = el('option', null, item.label);
    opt.value = item.value;
    if (item.value === currentProto) opt.selected = true;
    protoSelect.appendChild(opt);
  }
  const curItem = def.protocols.find((x) => x.value === currentProto) || def.protocols[0];
  $('cfg-protocol-hint').textContent = curItem ? curItem.hint : '';

  // 目标文件徽章
  $('cfg-output-target').textContent = def.file;

  // 模式切换 seg 按钮
  const modeBtns = document.querySelectorAll('#cfg-view-mode-seg .seg-btn');
  for (const btn of modeBtns) {
    const active = btn.dataset.mode === state.config.viewMode;
    btn.classList.toggle('is-active', active);
  }

  // 小贴士
  const tipsBox = $('cfg-tips');
  tipsBox.textContent = '';
  add(tipsBox,
    document.createTextNode('配置文件路径：'),
    el('code', null, def.path),
    document.createTextNode(' · ' + def.tips));

  renderSelectedChips();
  renderConfigOutput();
  renderConfigReport();
  renderLocalConfig();
}

function addModelToConfig(id) {
  const modelId = String(id || '').trim();
  if (!modelId) return;
  if (!state.config.models.includes(modelId)) state.config.models.push(modelId);
  switchView('config');
  toast('已加入 API 配置：' + modelId);
}

function localStatusClass(kind) {
  if (kind === 'ok') return 'local-status is-ok';
  if (kind === 'warn') return 'local-status is-warn';
  if (kind === 'error') return 'local-status is-error';
  return 'local-status';
}

function formatAuditValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length ? value.map((x) => String(x)).join(',') : '(空)';
  if (typeof value === 'number' && isFinite(value)) return value.toLocaleString('en-US');
  return String(value);
}

function hideLocalPanels() {
  $('cfg-local-summary').hidden = true;
  $('cfg-local-provider-bar').hidden = true;
  $('cfg-local-providers').hidden = true;
  $('cfg-local-preview-wrap').hidden = true;
}

function applyLocalResult(data) {
  if (data && data.local) {
    state.config.local = data.local;
    state.config.localError = null;
    renderLocalConfig();
    return true;
  }
  return false;
}

function renderLocalConfig() {
  const pathEl = $('cfg-local-path');
  const status = $('cfg-local-status');
  const summaryEl = $('cfg-local-summary');
  const providersEl = $('cfg-local-providers');
  const previewWrap = $('cfg-local-preview-wrap');
  const preview = $('cfg-local-preview');
  const def = PLATFORM_DEFS[state.config.platform] || PLATFORM_DEFS.opencode;
  pathEl.textContent = (state.config.local && state.config.local.file) || def.path;

  if (state.config.localLoading) {
    status.className = localStatusClass();
    status.textContent = '正在读取本机配置…';
    hideLocalPanels();
    return;
  }
  if (state.config.localError) {
    status.className = localStatusClass('error');
    status.textContent = state.config.localError;
    hideLocalPanels();
    return;
  }
  const local = state.config.local;
  if (!local) {
    status.className = localStatusClass('warn');
    status.textContent = '尚未读取本机配置。请用 npm start（= node apifix.mjs --ui）启动本地服务后再刷新。';
    hideLocalPanels();
    return;
  }
  if (!local.exists) {
    status.className = localStatusClass('warn');
    status.textContent = '本机尚无该配置文件（' + local.file + '）。写入时会新建。';
    hideLocalPanels();
    return;
  }

  const s = local.summary || {};
  const diffs = s.with_diffs || 0;
  const unmatched = s.unmatched || 0;
  const blocks = Array.isArray(local.providerBlocks) ? local.providerBlocks : [];
  const emptyCount = blocks.filter((b) => b.empty).length;
  if (diffs || unmatched || emptyCount) {
    status.className = localStatusClass('warn');
    status.textContent = '已读取 ' + local.file + '：' + blocks.length + ' 家供应商，'
      + (s.total || 0) + ' 个模型'
      + (emptyCount ? '，' + emptyCount + ' 家模型列表为空' : '')
      + (diffs ? '，' + diffs + ' 条与官网有差异' : '')
      + (unmatched ? '，' + unmatched + ' 条未收录' : '') + '。';
  } else {
    status.className = localStatusClass('ok');
    status.textContent = '已读取 ' + local.file + '：' + blocks.length + ' 家供应商，'
      + (s.total || 0) + ' 个模型，与官网规格一致。';
  }

  summaryEl.hidden = false;
  summaryEl.textContent = '';
  const pills = [
    ['供应商', blocks.length],
    ['模型', s.total || 0],
    ['一致', s.clean || 0],
    ['差异', diffs],
    ['未收录', unmatched],
  ];
  if (emptyCount) pills.push(['空供应商', emptyCount]);
  if (local.activeModel) pills.push(['当前模型', local.activeModel]);
  if (local.activeProvider) pills.push(['当前供应商', local.activeProvider]);
  for (const [label, value] of pills) {
    summaryEl.appendChild(badge(label + ' ' + value, 'badge-confidence-medium'));
  }

  const selected = pickActiveLocalProvider(blocks, local);
  const bar = $('cfg-local-provider-bar');
  bar.textContent = '';
  if (!blocks.length) {
    bar.hidden = true;
    providersEl.hidden = true;
    providersEl.textContent = '';
  } else {
    bar.hidden = false;
    for (const block of blocks) {
      const tab = el('button', 'platform-tab' + (block.name === selected ? ' is-active' : ''));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', block.name === selected ? 'true' : 'false');
      tab.appendChild(el('span', 'platform-name', block.name || '(unknown)'));
      const sub = [(block.modelCount || 0) + ' 个模型'];
      if (block.empty) sub.push('空');
      if (local.activeProvider && local.activeProvider === block.name) sub.push('当前');
      tab.appendChild(el('span', 'platform-sub', sub.join(' · ')));
      tab.addEventListener('click', () => selectLocalProvider(block.name, blocks));
      bar.appendChild(tab);
    }
    providersEl.hidden = false;
    providersEl.textContent = '';
    const current = blocks.find((b) => b.name === selected) || blocks[0];
    providersEl.appendChild(renderProviderBlock(current, local));
  }

  if (local.preview) {
    previewWrap.hidden = false;
    previewWrap.classList.toggle('is-open', state.config.filePreviewOpen);
    const toggle = $('cfg-local-preview-toggle');
    const caret = $('cfg-local-preview-caret');
    if (toggle) toggle.setAttribute('aria-expanded', state.config.filePreviewOpen ? 'true' : 'false');
    if (caret) caret.textContent = state.config.filePreviewOpen ? '▾' : '▸';
    preview.textContent = local.preview;
  } else {
    previewWrap.hidden = true;
    previewWrap.classList.remove('is-open');
    preview.textContent = '';
  }
}

function pickActiveLocalProvider(blocks, local) {
  const remembered = state.config.activeLocalProvider[state.config.platform];
  if (remembered && blocks.some((b) => b.name === remembered)) return remembered;
  if (local && local.activeProvider && blocks.some((b) => b.name === local.activeProvider)) {
    return local.activeProvider;
  }
  return blocks.length ? blocks[0].name : null;
}

function selectLocalProvider(name, blocks) {
  state.config.activeLocalProvider[state.config.platform] = name;
  const list = blocks || ((state.config.local && state.config.local.providerBlocks) || []);
  const block = list.find((b) => b.name === name);
  if (block) useProviderAsTarget(block, true);
  renderLocalConfig();
}

function renderProviderBlock(block, local) {
  const card = el('section', 'local-provider' + (block.empty ? ' is-empty' : '') + ' is-open');
  const head = el('div', 'local-provider-head');
  const title = el('div', 'local-provider-title');
  title.appendChild(el('div', 'local-provider-name', block.name || '(unknown)'));
  const metaBits = [];
  if (block.baseURL) metaBits.push(block.baseURL);
  if (block.protocol) metaBits.push(block.protocol);
  metaBits.push((block.modelCount || 0) + ' 个模型');
  if (block.empty) metaBits.push('模型列表为空');
  if (local.activeProvider && local.activeProvider === block.name) metaBits.push('当前激活');
  title.appendChild(el('div', 'local-provider-meta', metaBits.join(' · ')));
  head.appendChild(title);

  const actions = el('div', 'local-provider-actions');
  const canEdit = state.config.platform !== 'codex';
  if (canEdit) {
    const editBtn = el('button', 'btn btn-xs', '编辑片段');
    editBtn.type = 'button';
    editBtn.title = '按这家供应商编辑 JSON 片段，可直接改模型列表';
    editBtn.addEventListener('click', () => openEditProviderDialog(block));
    actions.appendChild(editBtn);
  }
  const useBtn = el('button', 'btn btn-xs', '用作写入目标');
  useBtn.type = 'button';
  useBtn.title = '把左侧表单切到这家供应商，便于继续添加模型';
  useBtn.addEventListener('click', () => useProviderAsTarget(block));
  actions.appendChild(useBtn);
  if (state.config.platform !== 'claude') {
    const delProv = el('button', 'btn btn-xs local-entry-del', '删除供应商');
    delProv.type = 'button';
    delProv.title = block.empty ? '删除这家空供应商' : '删除这家供应商及其全部模型';
    delProv.addEventListener('click', () => openDeleteProviderDialog(block));
    actions.appendChild(delProv);
  }
  head.appendChild(actions);
  card.appendChild(head);

  const body = el('div', 'local-provider-body');
  const models = Array.isArray(block.models) ? block.models : [];
  if (!models.length) {
    body.appendChild(el('p', 'local-empty-models', '这家供应商还没有模型。可在下方输入模型 id 添加到这家，或编辑 JSON 片段。'));
  } else {
    const list = el('div', 'local-entries local-entries-nested');
    for (const entry of models) {
      list.appendChild(renderLocalModelRow(entry, block));
    }
    body.appendChild(list);
  }
  body.appendChild(renderProviderAddRow(block));
  if (block.preview) {
    const frag = el('pre', 'code local-provider-preview', block.preview);
    frag.title = '这家供应商的脱敏 JSON 片段';
    body.appendChild(frag);
  }
  card.appendChild(body);
  return card;
}

function renderLocalModelRow(entry, block) {
  const row = el('div', 'local-entry');
  const miss = !entry.matchedId;
  const diffItems = (entry.diffs || []).filter((d) => d.status !== 'match');
  if (miss) row.classList.add('is-miss');
  else if (diffItems.length) row.classList.add('is-diff');
  const idCol = el('div');
  idCol.appendChild(el('div', 'local-entry-id', entry.input));
  const kind = miss ? '未收录' : (entry.clean ? '一致' : '有差异');
  const kindCol = badge(kind, miss ? 'badge-unreleased' : (entry.clean ? 'badge-verified' : 'badge-legacy'));
  const diffCol = el('div', 'local-entry-diff');
  if (miss) {
    diffCol.textContent = entry.suggestion ? ('最接近: ' + entry.suggestion) : 'catalog 未收录';
  } else if (!diffItems.length) {
    diffCol.textContent = entry.matchedId && entry.matchedId !== entry.input
      ? ('→ ' + entry.matchedId)
      : '与官网一致';
  } else {
    diffCol.textContent = diffItems.map((d) => {
      const field = d.field || '';
      return field + ' ' + formatAuditValue(d.config) + ' → ' + formatAuditValue(d.official);
    }).join('；');
  }
  const actions = el('div', 'local-entry-actions');
  if (state.config.platform === 'codex') {
    const disabled = el('button', 'btn btn-xs btn-ghost local-entry-del', '删除');
    disabled.type = 'button';
    disabled.disabled = true;
    disabled.title = 'Codex 只有当前激活模型，请先写入另一个模型作为激活项';
    actions.appendChild(disabled);
  } else {
    const refreshBtn = el('button', 'btn btn-xs', '更新规格');
    refreshBtn.type = 'button';
    refreshBtn.title = '用官网规格覆盖这家供应商里的该模型';
    refreshBtn.addEventListener('click', () => injectModelsIntoProvider(block, [entry.input], refreshBtn));
    actions.appendChild(refreshBtn);
    const delBtn = el('button', 'btn btn-xs local-entry-del', '删除');
    delBtn.type = 'button';
    delBtn.title = '从这家供应商中删除该模型';
    delBtn.addEventListener('click', () => openDeleteDialog(entry.input, entry.provider || block.name));
    actions.appendChild(delBtn);
  }
  add(row, idCol, kindCol, diffCol, actions);
  return row;
}

function parseModelIdList(raw) {
  return String(raw || '').split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
}

function renderProviderAddRow(block) {
  const wrap = el('div', 'local-provider-add');
  const input = el('input', 'cfg-input local-provider-add-input');
  input.type = 'text';
  input.placeholder = '在这家供应商添加模型，例如：gpt-6-astra, deepseek-v4-pro';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const addBtn = el('button', 'btn btn-xs btn-primary', '添加到这家');
  addBtn.type = 'button';
  addBtn.title = '把这些模型写入当前供应商（已存在则用官网规格更新）';
  const submit = () => {
    const ids = parseModelIdList(input.value);
    if (!ids.length) {
      toast('请输入要添加到「' + block.name + '」的模型 id');
      return;
    }
    injectModelsIntoProvider(block, ids, addBtn).then((ok) => {
      if (ok) input.value = '';
    });
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  wrap.appendChild(input);
  wrap.appendChild(addBtn);
  return wrap;
}

async function injectModelsIntoProvider(block, modelIds, btn) {
  const ids = (modelIds || []).map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length || !block || !block.name) return false;
  if (state.config.injecting) {
    toast('正在写入，请稍候');
    return false;
  }
  state.config.injecting = true;
  state.config.injectingInto = block.name;
  if (btn) btn.disabled = true;
  try {
    const payload = {
      platform: state.config.platform,
      models: ids,
      providerName: state.config.platform === 'claude' ? '' : block.name,
      baseURL: '',
      apiKey: '',
    };
    const res = await fetch('/api/local-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch (_err) { data = null; }
    if (!data || data.ok === false) {
      toast((data && data.error) ? data.error : ('写入失败 (HTTP ' + res.status + ')'));
      return false;
    }
    state.config.activeLocalProvider[state.config.platform] = data.provider || block.name;
    if (!applyLocalResult(data)) await loadLocalConfig();
    const parts = ['已写入「' + (data.provider || block.name) + '」'];
    if (data.added && data.added.length) parts.push('新增 ' + data.added.join(', '));
    if (data.updated && data.updated.length) parts.push('更新 ' + data.updated.join(', '));
    if (data.unmatched && data.unmatched.length) parts.push(data.unmatched.length + ' 个未收录');
    if (data.backup) parts.push('已备份');
    toast(parts.join(' · '));
    return true;
  } catch (_err) {
    toast('无法连接本地 UI 服务，写入失败');
    return false;
  } finally {
    state.config.injecting = false;
    state.config.injectingInto = null;
    if (btn) btn.disabled = false;
  }
}

function useProviderAsTarget(block, silent) {
  if (!block || !block.name) return;
  const nameInput = $('cfg-provider-name');
  if (state.config.platform !== 'claude') {
    state.config.providerName = block.name;
    state.config.autoDerivedName = null;
    if (nameInput) nameInput.value = block.name;
  }
  if (block.baseURL) {
    state.config.baseURL = block.baseURL;
    $('cfg-base-url').value = block.baseURL;
  }
  if (!silent) toast('已切到供应商 ' + block.name + '，可在下方继续添加或写入模型');
}

async function loadLocalConfig() {
  const platform = state.config.platform;
  state.config.localLoading = true;
  state.config.localError = null;
  renderLocalConfig();
  try {
    const res = await fetch('/api/local-config?platform=' + encodeURIComponent(platform));
    if (res.status === 404 || res.status === 405) {
      state.config.local = null;
      state.config.localError = '当前页面不是本地 UI 服务。请用 npm start 启动后再查阅本机配置。';
      return;
    }
    const data = await res.json();
    if (!data || data.ok === false) {
      state.config.local = null;
      state.config.localError = (data && data.error) ? data.error : ('读取失败 (HTTP ' + res.status + ')');
      return;
    }
    if (platform !== state.config.platform) return;
    state.config.local = data;
    state.config.localError = null;
  } catch (_err) {
    state.config.local = null;
    state.config.localError = '无法连接本地 UI 服务。请用 npm start（= node apifix.mjs --ui）启动。';
  } finally {
    state.config.localLoading = false;
    renderLocalConfig();
  }
}

function closeInjectDialog() {
  $('cfg-inject-overlay').hidden = true;
}

function closeDeleteDialog() {
  state.config.pendingDelete = null;
  $('cfg-delete-overlay').hidden = true;
}

function closeEditDialog() {
  $('cfg-edit-overlay').hidden = true;
}

function fillDeletePlan(lines) {
  const plan = $('cfg-delete-plan');
  plan.textContent = '';
  for (const [label, value] of lines) {
    const p = el('p');
    p.appendChild(el('strong', null, label + '：'));
    p.appendChild(document.createTextNode(' '));
    p.appendChild(el('code', null, value));
    plan.appendChild(p);
  }
}

function openDeleteDialog(modelId, provider) {
  if (state.config.deleting) return;
  if (state.config.platform === 'codex') {
    toast('Codex 只有当前激活模型，请先写入另一个模型作为激活项');
    return;
  }
  const def = PLATFORM_DEFS[state.config.platform] || PLATFORM_DEFS.opencode;
  const file = (state.config.local && state.config.local.file) || def.path;
  state.config.pendingDelete = { kind: 'model', model: modelId, provider: provider || '' };
  $('cfg-delete-title').textContent = '从本机配置删除模型';
  $('cfg-delete-hint').textContent = '只删除该模型条目，供应商骨架与凭证保留。写入前会备份为 .bak-时间戳。';
  const lines = [
    ['目标文件', file],
    ['平台', def.name],
    ['模型', modelId],
  ];
  if (provider) lines.push([state.config.platform === 'claude' ? 'env 键' : '供应商', provider]);
  fillDeletePlan(lines);
  $('cfg-delete-overlay').hidden = false;
  $('cfg-delete-confirm').focus();
}

function openDeleteProviderDialog(block) {
  if (state.config.deleting) return;
  if (state.config.platform === 'claude') {
    toast('Claude Code 没有可删除的供应商节点');
    return;
  }
  const def = PLATFORM_DEFS[state.config.platform] || PLATFORM_DEFS.opencode;
  const file = (state.config.local && state.config.local.file) || def.path;
  state.config.pendingDelete = { kind: 'provider', provider: block.name };
  $('cfg-delete-title').textContent = '删除供应商';
  $('cfg-delete-hint').textContent = block.empty
    ? '这家供应商已经没有模型，将删除整个供应商节点。写入前会备份为 .bak-时间戳。'
    : '将删除这家供应商及其全部模型。写入前会备份为 .bak-时间戳。';
  fillDeletePlan([
    ['目标文件', file],
    ['平台', def.name],
    ['供应商', block.name],
    ['模型数', String(block.modelCount || 0)],
  ]);
  $('cfg-delete-overlay').hidden = false;
  $('cfg-delete-confirm').focus();
}

function openEditProviderDialog(block) {
  if (state.config.editing) return;
  state.config.activeLocalProvider[state.config.platform] = block.name;
  if (state.config.platform === 'codex') {
    toast('Codex 的 TOML 供应商段请用写入功能改当前模型');
    return;
  }
  $('cfg-edit-title').textContent = '编辑供应商「' + block.name + '」';
  $('cfg-edit-fragment').value = block.preview || '{\n}\n';
  $('cfg-edit-fragment').dataset.provider = block.name;
  $('cfg-edit-overlay').hidden = false;
  $('cfg-edit-fragment').focus();
}

async function confirmEditProvider() {
  if (state.config.editing) return;
  const provider = $('cfg-edit-fragment').dataset.provider;
  const fragment = $('cfg-edit-fragment').value;
  if (!provider) return;
  const btn = $('cfg-edit-confirm');
  state.config.editing = true;
  btn.disabled = true;
  try {
    const res = await fetch('/api/local-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update-provider',
        platform: state.config.platform,
        provider,
        fragment,
      }),
    });
    let data = null;
    try { data = await res.json(); } catch (_err) { data = null; }
    if (!data || data.ok === false) {
      toast((data && data.error) ? data.error : ('保存失败 (HTTP ' + res.status + ')'));
      return;
    }
    if (!applyLocalResult(data)) await loadLocalConfig();
    closeEditDialog();
    const parts = ['已保存供应商 ' + provider];
    if (data.backup) parts.push('备份 ' + data.backup);
    toast(parts.join(' · '));
  } catch (_err) {
    toast('无法连接本地 UI 服务，保存失败');
  } finally {
    state.config.editing = false;
    btn.disabled = false;
  }
}

async function confirmDelete() {
  if (state.config.deleting) return;
  const pending = state.config.pendingDelete;
  if (!pending) return;
  const btn = $('cfg-delete-confirm');
  state.config.deleting = true;
  btn.disabled = true;
  try {
    const payload = pending.kind === 'provider'
      ? { action: 'delete-provider', platform: state.config.platform, provider: pending.provider }
      : { action: 'delete', platform: state.config.platform, model: pending.model, provider: pending.provider };
    const res = await fetch('/api/local-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch (_err) { data = null; }
    if (!data || data.ok === false) {
      toast((data && data.error) ? data.error : (res.status === 404 || res.status === 405
        ? '当前不是本地 UI 服务，无法删除本机配置'
        : ('删除失败 (HTTP ' + res.status + ')')));
      return;
    }
    if (pending.kind === 'provider') {
      const current = state.config.activeLocalProvider[state.config.platform];
      if (current === pending.provider) delete state.config.activeLocalProvider[state.config.platform];
    }
    if (!applyLocalResult(data)) await loadLocalConfig();
    closeDeleteDialog();
    const parts = pending.kind === 'provider'
      ? ['已删除供应商 ' + data.deletedProvider]
      : ['已删除 ' + data.deleted];
    if (pending.kind !== 'provider' && data.provider) parts.push(data.provider);
    if (data.backup) parts.push('备份 ' + data.backup);
    toast(parts.join(' · '));
  } catch (_err) {
    toast('无法连接本地 UI 服务，删除失败');
  } finally {
    state.config.deleting = false;
    btn.disabled = false;
  }
}

function openInjectDialog() {
  const models = state.config.models;
  if (!models.length) {
    toast('请先添加要写入的模型');
    return;
  }
  const def = PLATFORM_DEFS[state.config.platform] || PLATFORM_DEFS.opencode;
  const pName = state.config.providerName.trim()
    || deriveNameFromUrl(state.config.baseURL.trim())
    || 'my-provider';
  const file = (state.config.local && state.config.local.file) || def.path;
  const exists = state.config.local && state.config.local.exists;
  const plan = $('cfg-inject-plan');
  plan.textContent = '';
  const lines = [
    ['目标文件', file + (exists ? '' : '（将新建）')],
    ['平台', def.name],
    ['供应商', pName],
    ['模型', models.join(', ')],
  ];
  if (state.config.baseURL.trim()) lines.push(['Base URL', state.config.baseURL.trim()]);
  if (state.config.apiKey.trim()) lines.push(['API Key', '已填写（不会出现在预览里）']);
  if (state.config.platform === 'codex' || state.config.platform === 'claude') {
    lines.push(['说明', '该客户端以首个已选模型作为当前激活模型']);
  }
  for (const [label, value] of lines) {
    const p = el('p');
    p.appendChild(el('strong', null, label + '：'));
    p.appendChild(document.createTextNode(' '));
    p.appendChild(el('code', null, value));
    plan.appendChild(p);
  }
  const defaultWrap = $('cfg-inject-default-wrap');
  defaultWrap.hidden = state.config.platform !== 'opencode';
  $('cfg-inject-default').checked = false;
  $('cfg-inject-overlay').hidden = false;
  $('cfg-inject-confirm').focus();
}

async function confirmInject() {
  if (state.config.injecting) return;
  const models = state.config.models.slice();
  if (!models.length) {
    toast('请先添加要写入的模型');
    return;
  }
  const btn = $('cfg-inject-confirm');
  state.config.injecting = true;
  btn.disabled = true;
  try {
    const res = await fetch('/api/local-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: state.config.platform,
        models,
        baseURL: state.config.baseURL.trim(),
        apiKey: state.config.apiKey.trim(),
        providerName: state.config.providerName.trim(),
        protocol: state.config.protocol,
        setDefault: $('cfg-inject-default').checked,
      }),
    });
    if (res.status === 404 || res.status === 405) {
      toast('当前不是本地 UI 服务，无法写入本机配置');
      return;
    }
    const data = await res.json();
    if (!data || data.ok === false) {
      toast((data && data.error) ? data.error : ('写入失败 (HTTP ' + res.status + ')'));
      return;
    }
    if (!applyLocalResult(data)) await loadLocalConfig();
    closeInjectDialog();
    const parts = [];
    if (data.created) parts.push('已新建 ' + data.file);
    else parts.push('已写入 ' + data.file);
    if (data.added && data.added.length) parts.push('新增 ' + data.added.length);
    if (data.updated && data.updated.length) parts.push('更新 ' + data.updated.length);
    if (data.unmatched && data.unmatched.length) parts.push(data.unmatched.length + ' 个未收录');
    if (data.backup) parts.push('备份 ' + data.backup);
    toast(parts.join(' · '));
  } catch (_err) {
    toast('无法连接本地 UI 服务，写入失败');
  } finally {
    state.config.injecting = false;
    btn.disabled = false;
  }
}

function renderSelectedChips() {
  const box = $('cfg-selected-chips');
  box.textContent = '';
  const models = state.config.models;
  $('cfg-selected-count').textContent = String(models.length);

  if (!models.length) {
    box.appendChild(el('span', 'cfg-empty-chips', '尚未添加模型，请先使用上方嗅探或手动输入添加'));
    return;
  }

  const p = state.config.platform;
  models.forEach((id, idx) => {
    const match = runMatch(id);
    const chip = el('div', 'cfg-chip');
    if (match && match.entry && match.entry.verified) chip.classList.add('is-verified');

    if (idx === 0 && (p === 'codex' || p === 'claude')) {
      chip.appendChild(span('cfg-chip-primary', '主模型'));
    }

    chip.appendChild(span('cfg-chip-id', id));

    if (match && match.entry) {
      const v = match.entry.vendor || '';
      if (v) chip.appendChild(span('mono muted', '[' + v + ']'));
    } else {
      chip.appendChild(span('muted', '[未收录]'));
    }

    const delBtn = el('button', 'cfg-chip-del', '×');
    delBtn.type = 'button';
    delBtn.title = '移除模型';
    delBtn.addEventListener('click', () => {
      state.config.models.splice(idx, 1);
      renderSelectedChips();
      renderConfigOutput();
      renderConfigReport();
    });
    chip.appendChild(delBtn);
    box.appendChild(chip);
  });
}

function renderConfigOutput() {
  const codeEl = $('cfg-code-output');
  codeEl.textContent = generateConfigCode();
}

function renderConfigReport() {
  const reportBox = $('cfg-report');
  reportBox.textContent = '';
  const models = state.config.models;
  if (!models.length) {
    add(reportBox,
      el('div', 'cfg-report-title', '模型收录与官网参数分析'),
      el('p', 'muted', '暂无选定模型。添加模型后将在此自动核验官网规格。'));
    return;
  }

  let matchedCount = 0;
  let unrecordedCount = 0;
  const matchedDetails = [];

  for (const id of models) {
    const match = runMatch(id);
    if (match && match.entry) {
      matchedCount += 1;
      const e = match.entry;
      matchedDetails.push({
        id,
        matchedId: match.matchedId,
        vendor: e.vendor,
        context: fmtTokens(e.context_window) || '未知',
        output: fmtTokens(e.max_output_tokens) || '未知',
        reasoning: e.reasoning && e.reasoning.supported ? '支持推理' : '常规模型',
      });
    } else {
      unrecordedCount += 1;
    }
  }

  const title = el('div', 'cfg-report-title',
    '模型分析：已选 ' + models.length + ' 个 · 官网收录 ' + matchedCount + ' 个 · 未收录 ' + unrecordedCount + ' 个');
  const ul = el('ul', 'cfg-report-list');

  if (matchedCount > 0) {
    const li1 = el('li', null, '已收录的 ' + matchedCount + ' 个模型将自动带出官网核验的 context / output 上限与推理配置。');
    ul.appendChild(li1);
  }
  if (unrecordedCount > 0) {
    const li2 = el('li', null, '有 ' + unrecordedCount + ' 个模型 catalog 尚未收录，已保留基础配置，可随时通过 apifix 命令行查看。');
    ul.appendChild(li2);
  }

  add(reportBox, title, ul);
}

function renderSniffBox() {
  const box = $('cfg-sniff-box');
  const status = $('cfg-sniff-status');
  const listEl = $('cfg-sniff-list');
  listEl.textContent = '';

  const res = state.config.sniffResult;
  if (!res) {
    box.hidden = true;
    status.hidden = true;
    return;
  }

  if (!res.ok) {
    box.hidden = true;
    status.hidden = false;
    status.className = 'sniff-status is-error';
    status.textContent = '嗅探失败：' + res.error;
    return;
  }

  status.hidden = false;
  status.className = 'sniff-status is-success';
  status.textContent = '嗅探成功：来自 ' + state.config.baseURL + ' 的 /models 接口，共发现 ' + res.models.length + ' 个模型。';

  box.hidden = false;
  const needle = state.config.sniffFilter.toLowerCase().trim();
  const filtered = res.models.filter((id) => !needle || id.toLowerCase().includes(needle));

  let verifiedCount = 0;
  for (const id of res.models) {
    const m = runMatch(id);
    if (m && m.entry) verifiedCount += 1;
  }
  $('cfg-sniff-count').textContent = '检测到 ' + res.models.length + ' 个模型 · ' + verifiedCount + ' 个官网收录';

  if (!filtered.length) {
    listEl.appendChild(el('div', 'detail-empty', '无匹配模型，请调整过滤词。'));
    return;
  }

  filtered.forEach((id) => {
    const match = runMatch(id);
    const item = el('label', 'sniff-item');

    const left = el('div', 'sniff-item-left');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = state.config.sniffSelected.has(id);
    chk.addEventListener('change', () => {
      if (chk.checked) state.config.sniffSelected.add(id);
      else state.config.sniffSelected.delete(id);
    });
    add(left, chk, span('sniff-id', id));

    const right = el('div', 'sniff-meta');
    if (match && match.entry) {
      right.appendChild(badge('官网规格', 'badge-verified'));
      const spec = fmtTokens(match.entry.context_window);
      if (spec) right.appendChild(span('sniff-spec', 'ctx ' + spec));
    } else {
      right.appendChild(badge('未收录', 'badge-unverified'));
    }

    add(item, left, right);
    listEl.appendChild(item);
  });
}

async function handleSniff() {
  const url = state.config.baseURL.trim();
  if (!url) {
    toast('请先输入 API 地址 (Base URL)');
    $('cfg-base-url').focus();
    return;
  }

  state.config.sniffing = true;
  const btn = $('cfg-btn-sniff');
  btn.classList.add('is-loading');
  $('cfg-sniff-label').textContent = '嗅探中…';
  const status = $('cfg-sniff-status');
  status.hidden = false;
  status.className = 'sniff-status is-loading';
  status.textContent = '正在连接 ' + url.replace(/\/+$/, '') + '/models 嗅探可用模型列表…';

  try {
    const ids = await sniffModels(url, state.config.apiKey);
    state.config.sniffResult = { ok: true, models: ids };
    state.config.sniffSelected = new Set(ids);
    renderSniffBox();
    toast('嗅探完成，检测到 ' + ids.length + ' 个模型');
  } catch (err) {
    state.config.sniffResult = { ok: false, error: err.message || String(err) };
    renderSniffBox();
  } finally {
    state.config.sniffing = false;
    btn.classList.remove('is-loading');
    $('cfg-sniff-label').textContent = '嗅探可用模型';
  }
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
  renderConfigView();
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

  // ---- API 配置视图事件 ----
  for (const tab of document.querySelectorAll('#platform-bar .platform-tab')) {
    tab.addEventListener('click', () => {
      const platform = tab.dataset.platform;
      if (platform === state.config.platform) return;
      state.config.platform = platform;
      const def = PLATFORM_DEFS[platform] || PLATFORM_DEFS.opencode;
      state.config.protocol = def.defaultProtocol;
      state.config.local = null;
      state.config.localError = null;
      renderConfigView();
      loadLocalConfig();
    });
  }

  const baseUrlInput = $('cfg-base-url');
  baseUrlInput.addEventListener('input', () => {
    state.config.baseURL = baseUrlInput.value;
    if (!state.config.providerName || state.config.autoDerivedName === state.config.providerName) {
      const derived = deriveNameFromUrl(baseUrlInput.value);
      if (derived) {
        state.config.providerName = derived;
        state.config.autoDerivedName = derived;
        $('cfg-provider-name').value = derived;
        $('cfg-provider-hint').textContent = '已根据 Base URL 自动建议名称';
      }
    }
    renderConfigOutput();
  });

  const apiKeyInput = $('cfg-api-key');
  apiKeyInput.addEventListener('input', () => {
    state.config.apiKey = apiKeyInput.value;
    renderConfigOutput();
  });

  const keyToggle = $('cfg-key-toggle');
  keyToggle.addEventListener('click', () => {
    state.config.showKey = !state.config.showKey;
    apiKeyInput.type = state.config.showKey ? 'text' : 'password';
    keyToggle.title = state.config.showKey ? '隐藏明文' : '显示明文';
  });

  const providerInput = $('cfg-provider-name');
  providerInput.addEventListener('input', () => {
    state.config.providerName = providerInput.value;
    state.config.autoDerivedName = null;
    renderConfigOutput();
  });

  const protocolSelect = $('cfg-protocol');
  protocolSelect.addEventListener('change', () => {
    state.config.protocol = protocolSelect.value;
    const def = PLATFORM_DEFS[state.config.platform];
    const curItem = def && def.protocols.find((x) => x.value === state.config.protocol);
    $('cfg-protocol-hint').textContent = curItem ? curItem.hint : '';
    renderConfigOutput();
  });

  for (const btn of document.querySelectorAll('#cfg-view-mode-seg .seg-btn')) {
    btn.addEventListener('click', () => {
      state.config.viewMode = btn.dataset.mode;
      renderConfigView();
    });
  }

  const maskKeyChk = $('cfg-mask-key');
  maskKeyChk.addEventListener('change', () => {
    state.config.keepKey = maskKeyChk.checked;
    renderConfigOutput();
  });

  $('cfg-btn-sniff').addEventListener('click', handleSniff);

  const sniffFilter = $('cfg-sniff-filter');
  sniffFilter.addEventListener('input', () => {
    state.config.sniffFilter = sniffFilter.value;
    renderSniffBox();
  });

  $('cfg-sniff-select-all').addEventListener('click', () => {
    const res = state.config.sniffResult;
    if (!res || !res.models) return;
    const needle = state.config.sniffFilter.toLowerCase().trim();
    for (const id of res.models) {
      if (!needle || id.toLowerCase().includes(needle)) state.config.sniffSelected.add(id);
    }
    renderSniffBox();
  });

  $('cfg-sniff-deselect-all').addEventListener('click', () => {
    state.config.sniffSelected.clear();
    renderSniffBox();
  });

  $('cfg-sniff-add-selected').addEventListener('click', () => {
    const toAdd = [...state.config.sniffSelected];
    if (!toAdd.length) {
      toast('请先勾选需要添加的模型');
      return;
    }
    let added = 0;
    for (const id of toAdd) {
      if (!state.config.models.includes(id)) {
        state.config.models.push(id);
        added += 1;
      }
    }
    renderSelectedChips();
    renderConfigOutput();
    renderConfigReport();
    toast('已添加 ' + added + ' 个模型至配置');
  });

  function handleManualAdd() {
    const input = $('cfg-manual-input');
    const raw = input.value.trim();
    if (!raw) return;
    const parts = raw.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
    let added = 0;
    for (const id of parts) {
      if (!state.config.models.includes(id)) {
        state.config.models.push(id);
        added += 1;
      }
    }
    input.value = '';
    renderSelectedChips();
    renderConfigOutput();
    renderConfigReport();
    toast('已添加 ' + added + ' 个模型');
  }

  $('cfg-manual-add-btn').addEventListener('click', handleManualAdd);
  $('cfg-manual-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleManualAdd();
    }
  });

  $('cfg-selected-clear').addEventListener('click', () => {
    if (!state.config.models.length) return;
    state.config.models = [];
    renderSelectedChips();
    renderConfigOutput();
    renderConfigReport();
    toast('已清空已选模型');
  });

  $('cfg-copy-btn').addEventListener('click', async () => {
    const code = generateConfigCode();
    const ok = await copyText(code);
    toast(ok ? '已复制配置内容' : '复制失败：请手动选择复制');
  });

  $('cfg-download-btn').addEventListener('click', () => {
    const def = PLATFORM_DEFS[state.config.platform] || PLATFORM_DEFS.opencode;
    downloadTextFile(def.file, generateConfigCode());
    toast('已开始下载 ' + def.file);
  });

  $('cfg-local-refresh').addEventListener('click', () => { loadLocalConfig(); });
  $('cfg-local-preview-toggle').addEventListener('click', () => {
    state.config.filePreviewOpen = !state.config.filePreviewOpen;
    renderLocalConfig();
  });
  $('cfg-local-copy').addEventListener('click', async () => {
    const text = state.config.local && state.config.local.preview;
    if (!text) { toast('暂无可复制的预览'); return; }
    const ok = await copyText(text);
    toast(ok ? '已复制脱敏预览' : '复制失败：请手动选择复制');
  });
  $('cfg-inject-btn').addEventListener('click', openInjectDialog);
  $('cfg-inject-cancel').addEventListener('click', closeInjectDialog);
  $('cfg-inject-confirm').addEventListener('click', confirmInject);
  $('cfg-inject-overlay').addEventListener('click', (event) => {
    if (event.target === $('cfg-inject-overlay')) closeInjectDialog();
  });
  $('cfg-delete-cancel').addEventListener('click', closeDeleteDialog);
  $('cfg-delete-confirm').addEventListener('click', confirmDelete);
  $('cfg-delete-overlay').addEventListener('click', (event) => {
    if (event.target === $('cfg-delete-overlay')) closeDeleteDialog();
  });
  $('cfg-edit-cancel').addEventListener('click', closeEditDialog);
  $('cfg-edit-confirm').addEventListener('click', confirmEditProvider);
  $('cfg-edit-overlay').addEventListener('click', (event) => {
    if (event.target === $('cfg-edit-overlay')) closeEditDialog();
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
