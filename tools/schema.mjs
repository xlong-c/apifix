// schema.mjs — catalog 条目 schema 词表（validate 与 merge 共用的单一事实源）
//
// 背景（评审 P1-5）：此前 tools/validate-catalog.mjs 与 tools/merge-catalog.mjs
// 对同一 schema 各写了一套词表（REQUIRED_TOP / LIFECYCLE / confidence 枚举 /
// tiers 边界字段名），字段新增要同步改多处。本模块只收编「两边定义一致」的
// 常量；如果发现同名义常量在两边取值/顺序不一致，不得静默统一，须人工裁决。
//
// 现状对照（收编依据）：
//   REQUIRED_TOP   —— 两边逐键逐序完全一致（21 键）。
//   LIFECYCLES     —— 两边均为 Set(["current","legacy","retired","unreleased"])。
//   confidence     —— validate 侧是 CONFIDENCES 集合，merge 侧是 CONF_RANK 排名表；
//                     词表一致（high/medium/low），rank 只在 merge 有（选批 tiebreak 用）。
//                     此处以 CONF_RANK 为源，CONFIDENCES 由其键派生，天然不会漂移。
//   REQUIRED_REASONING / REQUIRED_SAMPLING / REQUIRED_TOOLS / REQUIRED_CACHING
//                     —— 仅 validate 有具名常量；merge 的 normalizeEntry 按同名字段
//                     逐字段收窄，语义一致但未命名。供 validate 使用，merge 备查。
//   tiers 边界字段 —— 两边各自内联实现「max_input / min_input_tokens / condition
//                     恰有其一」（见 tierBoundaries 注释指向的两处实现）。
//
// 注意：api_protocol 在两边都没有枚举词表（merge 原样透传、validate 只查键存在），
// 故本模块不收编 api_protocol 词表。

// catalog 条目必需的顶层键（顺序即 canonical 顺序；merge 漏字段时直接抛错）
export const REQUIRED_TOP = [
  "id", "vendor", "family", "api_protocol", "verified", "lifecycle", "lifecycle_note",
  "context_window", "max_output_tokens", "reasoning", "sampling", "tools",
  "structured_output", "vision", "pdf", "caching", "aliases", "legacy_ids",
  "gotchas", "sources", "confidence",
];

// 子对象必需键（validate 逐键检查；merge 按同名字段收窄）
export const REQUIRED_REASONING = ["supported", "effort_values", "default_effort", "summary_values",
  "can_disable", "thinking_budget"];
export const REQUIRED_SAMPLING = ["temperature", "top_p", "top_k"];
export const REQUIRED_TOOLS = ["function_calling", "parallel", "strict", "choice_modes"];
export const REQUIRED_CACHING = ["mode", "min_tokens", "ttl_options"];

// lifecycle 枚举。LIFECYCLE_VALUES 是 canonical 顺序（新增值时两处 Set 派生自动跟随），
// LIFECYCLES 集合供 `LIFECYCLES.has()` 判成员（validate / merge 用法一致）。
export const LIFECYCLE_VALUES = ["current", "legacy", "retired", "unreleased"];
export const LIFECYCLES = new Set(LIFECYCLE_VALUES);

// confidence 排名（merge 选批 tiebreak：非空字段同分时 rank 高者胜）。
// validate 侧的合法值集合 CONFIDENCES 由同一张表派生，保证词表只有一份。
export const CONF_RANK = { high: 3, medium: 2, low: 1 };
export const CONFIDENCES = new Set(Object.keys(CONF_RANK));

// cost.tiers 档位边界的三种写法字段名（三种边界写法必须一起改，见 AGENTS.md 已知陷阱）：
//   max_input        —— 不超过这么多 input tokens（数值，上限口径）
//   min_input_tokens —— 从这么多 input tokens 起（数值，下限口径）
//   condition        —— 人类可读的区间描述（非空字符串）
// 「恰有其一」的两处实现：
//   * tools/validate-catalog.mjs checkCost() —— 违反则报 error；
//   * tools/merge-catalog.mjs normalizeCost() —— 宽容处理，保留作者写的一侧，
//     全缺时以 max_input: null 占位交由 validate 兜底。
export const TIER_BOUNDARY_FIELDS = ["max_input", "min_input_tokens", "condition"];

// 判别一个 tier 采用了哪些边界写法（null 与 undefined 一律视为「未采用」，
// 与 validate / merge 两处内联实现的既有语义逐字一致）。
export function tierBoundaries(tier) {
  return {
    hasMax: tier.max_input !== null && tier.max_input !== undefined,
    hasMin: tier.min_input_tokens !== null && tier.min_input_tokens !== undefined,
    hasCond: tier.condition !== null && tier.condition !== undefined,
  };
}
