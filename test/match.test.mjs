// matchModel 表驱动测试 —— 精确 / 别名 / legacy / 归一化 / 模糊 / 未命中
// 断言结构与 lib/core.mjs 实际返回一致（kind / matchedId / suggestion / score / entry / note）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { matchModel, normalizeId } from "../lib/core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(readFileSync(path.join(ROOT, "catalog.json"), "utf8"));

// 断言辅助：命中结果必须自洽（entry 与 matchedId 指向同一条目）
function assertHit(res, expectKind, expectId) {
  assert.equal(res.kind, expectKind, `kind 期望 ${expectKind}，实际 ${res.kind}`);
  assert.equal(res.matchedId, expectId, `matchedId 期望 ${expectId}`);
  assert.ok(res.entry, "命中时 entry 应非空");
  assert.equal(res.entry.id, expectId, "entry.id 应等于 matchedId");
  assert.equal(res.suggestion, null, "命中时 suggestion 应为 null");
}

test("精确 id 命中：kind=exact，entry 指向原条目", () => {
  const r = matchModel(catalog, "deepseek-v4-pro");
  assertHit(r, "exact", "deepseek-v4-pro");
  assert.equal(r.score, 0);
  assert.deepEqual(r.ops, []);
});

test("大小写归一化：大写输入命中同一 id", () => {
  const r = matchModel(catalog, "DEEPSEEK-V4-PRO");
  assert.equal(r.matchedId, "deepseek-v4-pro");
  assert.ok(r.kind === "exact" || r.kind === "normalized", `kind 实际为 ${r.kind}`);
  assert.ok(r.entry);
});

test("分隔符归一化：- / . / _ 等价", () => {
  const r = matchModel(catalog, "deepseek_v4_pro");
  assert.equal(r.matchedId, "deepseek-v4-pro");
  assert.ok(r.kind === "normalized" || r.kind === "legacy");
  assert.ok(Array.isArray(r.ops) && r.ops.length > 0, "归一化命中应有 ops 说明");
  assert.ok(r.ops.some((op) => op.includes("分隔符")), "ops 应提及分隔符处理");
});

test("前后空格被 trim 后命中", () => {
  const r = matchModel(catalog, "  deepseek-v4-pro  ");
  assertHit(r, "exact", "deepseek-v4-pro");
});

test("点分隔符：deepseek.v4.pro 命中（分隔符等价）", () => {
  const r = matchModel(catalog, "deepseek.v4.pro");
  assert.equal(r.matchedId, "deepseek-v4-pro");
  assert.ok(r.kind === "normalized" || r.kind === "legacy");
});

test("别名命中：jamba-1.5-mini -> jamba-1.5-large，kind=alias", () => {
  const r = matchModel(catalog, "jamba-1.5-mini");
  assertHit(r, "alias", "jamba-1.5-large");
  assert.ok(typeof r.note === "string" && r.note.includes("别名"), `note 应说明别名解析，实际：${r.note}`);
});

test("带厂商前缀的别名命中：dashscope/qwen3.5-plus", () => {
  const r = matchModel(catalog, "dashscope/qwen3.5-plus");
  assertHit(r, "alias", "qwen3.5-plus");
});

test("legacy_ids 命中：yi-medium -> yi-large，kind=legacy", () => {
  const r = matchModel(catalog, "yi-medium");
  assertHit(r, "legacy", "yi-large");
  assert.ok(typeof r.note === "string" && r.note.includes("旧版"), `note 应说明旧 id，实际：${r.note}`);
});

test("legacy 命中带中转语义：deepseek-v4.1-flash（deepseek-flash 的 legacy id）", () => {
  const r = matchModel(catalog, "deepseek-v4.1-flash");
  assertHit(r, "legacy", "deepseek-flash");
});

test("模糊命中（相似度 >= 0.75 返回建议，不自动纠错）", () => {
  const r = matchModel(catalog, "deepseek-v4-pro-x");
  assert.equal(r.kind, "fuzzy");
  assert.equal(r.matchedId, null, "模糊命中不设 matchedId");
  assert.equal(r.entry, null);
  assert.equal(r.suggestion, "deepseek-v4-pro");
  assert.ok(r.score >= 0.75, `score 应 >= 0.75，实际 ${r.score}`);
});

test("模糊未命中：kind=none、无建议、score=0", () => {
  const r = matchModel(catalog, "zzzzqqqq-xxxxxxxx");
  assert.equal(r.kind, "none");
  assert.equal(r.matchedId, null);
  assert.equal(r.suggestion, null);
  assert.equal(r.score, 0);
});

test("不存在的随机 id：kind=none", () => {
  const r = matchModel(catalog, "totally-made-up-model-20260920");
  assert.equal(r.kind, "none");
  assert.equal(r.matchedId, null);
  assert.equal(r.entry, null);
});

test("空输入：kind=none、无 suggestion", () => {
  for (const input of ["", "   ", null, undefined]) {
    const r = matchModel(catalog, input);
    assert.equal(r.kind, "none");
    assert.equal(r.matchedId, null);
    assert.equal(r.suggestion, null);
  }
});

test("返回结构固定字段齐全（无论命中与否）", () => {
  for (const input of ["deepseek-v4-pro", "zzzz-not-exist-zzz"]) {
    const r = matchModel(catalog, input);
    for (const key of ["input", "kind", "matchedId", "note", "entry", "suggestion", "score", "ops", "notes"]) {
      assert.ok(key in r, `结果应含字段 ${key}`);
    }
    assert.ok(Array.isArray(r.ops));
    assert.ok(Array.isArray(r.notes));
  }
});

test("normalizeId 返回 normalized 与 stages", () => {
  const r = normalizeId("OpenAI/GPT-5.6_SOL");
  assert.ok(typeof r.normalized === "string" && r.normalized.length > 0);
  assert.ok(Array.isArray(r.notes));
  assert.ok(Array.isArray(r.stages) && r.stages.length > 0);
  for (const stage of r.stages) {
    assert.ok(typeof stage.candidate === "string");
    assert.ok(Array.isArray(stage.ops));
  }
});

// ---- 厂商前缀（VENDOR_PREFIXES + 目录 vendor 自动并入）与短缩写建议 ----

test("厂商前缀：vendor/<id> 全量归一化命中（新增厂商无需改白名单）", () => {
  for (const entry of catalog.models) {
    const input = `${entry.vendor}/${entry.id}`;
    const r = matchModel(catalog, input);
    assert.equal(r.matchedId, entry.id, `${input} 应命中 ${entry.id}`);
    // 前缀写法若已登记为 alias，会在 alias 阶段先命中（更高优先级），同样是正确结果
    assert.ok(
      r.kind === "normalized" || r.kind === "alias",
      `${input} 应为归一化/别名命中，实际 ${r.kind}`,
    );
    if (r.kind === "normalized") {
      assert.ok(r.ops.some((op) => op.includes("去除厂商前缀")), `${input} 的 ops 应说明去除厂商前缀`);
    }
  }
});

test("厂商前缀：stepfun/step-5-preview（回归用例）", () => {
  const r = matchModel(catalog, "stepfun/step-5-preview");
  assertHit(r, "normalized", "step-5-preview");
});

test("短缩写：step5 → 前缀匹配建议（仅建议，不自动纠错）", () => {
  const r = matchModel(catalog, "step5");
  assert.equal(r.entry, null);
  assert.equal(r.kind, "none");
  assert.equal(r.suggestion, "step-5-preview");
  assert.equal(r.suggestionKind, "prefix");
});

test("前缀建议的边界：过短输入 / 无候选都不给建议", () => {
  assert.equal(matchModel(catalog, "st").suggestion, null, "2 字符不给前缀建议");
  assert.equal(matchModel(catalog, "zzz-not-a-model").suggestion, null, "无前缀候选不给建议");
});

// ---- 严格模式（配置识别：audit / fix / protocols 用）----

test("严格模式：id / 别名仍然命中", () => {
  assertHit(matchModel(catalog, "glm-5.3-flash", { strict: true }), "exact", "glm-5.3-flash");
  const alias = matchModel(catalog, "zhipu/glm-5.3-flash", { strict: true });
  assert.equal(alias.matchedId, "glm-5.3-flash");
  assert.equal(alias.kind, "alias");
});

test("严格模式：归一化写法不自动命中，只给「最接近」建议", () => {
  const r = matchModel(catalog, "glm-5.3-flash-free", { strict: true });
  assert.equal(r.entry, null, "严格模式不得自动命中");
  assert.equal(r.kind, "none");
  assert.equal(r.suggestion, "glm-5.3-flash");
  assert.equal(r.suggestionKind, "normalized");
  assert.ok(r.ops.some((op) => op.includes("relay 后缀")), "ops 应说明去掉了 relay 后缀");

  const vendor = matchModel(catalog, "stepfun/step-5-preview", { strict: true });
  assert.equal(vendor.entry, null);
  assert.equal(vendor.suggestion, "step-5-preview");
  assert.equal(vendor.suggestionKind, "normalized");
});

test("默认（宽松）模式不受影响：CLI 直接查询仍解析中转写法", () => {
  assertHit(matchModel(catalog, "zhipu/glm-5.3-flash"), "alias", "glm-5.3-flash");
  const r = matchModel(catalog, "glm-5.3-flash-free");
  assert.equal(r.matchedId, "glm-5.3-flash");
  assert.equal(r.kind, "normalized");
});
