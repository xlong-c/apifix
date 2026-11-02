// fix --fill：补齐模式测试（只声明 name 的条目一次性补齐为 catalog 官网规格）。
// 夹具一律用 sk-TEST 假 key；零依赖，node --test 运行。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planConfigFixes, applyConfigFixes, renderFixPlan, emitOpencode } from "../lib/core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CATALOG = JSON.parse(readFileSync(path.join(ROOT, "catalog.json"), "utf8"));

// 键排序序列化（与 emitOpencode 的 sortedObject 口径一致），用于「逐字节一致」断言。
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedJson(value[key]);
    return out;
  }
  return value;
}

test("fill: 空 name 被补齐为模型 id；非空 name 保留", () => {
  const config = {
    provider: {
      r4: {
        options: { apiKey: "sk-TEST" },
        models: {
          "glm-5.3-flash": { name: "" },
          "qwen3.8-max": { name: "自定义展示名" },
        },
      },
    },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode", { fill: true });

  const empty = plan.entries.find((e) => e.input === "glm-5.3-flash");
  const nameChange = empty.changes.find((c) => c.field === "name");
  assert.ok(nameChange, "空 name 应生成补齐项");
  assert.equal(nameChange.from, "");
  assert.equal(nameChange.to, "glm-5.3-flash");
  assert.equal(nameChange.missing, true);

  const custom = plan.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(!custom.changes.some((c) => c.field === "name"), "非空 name 不得改动");

  const next = applyConfigFixes(config, plan);
  assert.equal(next.provider.r4.models["glm-5.3-flash"].name, "glm-5.3-flash");
  assert.equal(next.provider.r4.models["qwen3.8-max"].name, "自定义展示名");
});

test("fill: 未声明 name 的条目不动（不新增字段）", () => {
  const config = {
    provider: { r4: { options: { apiKey: "sk-TEST" }, models: { "qwen3.8-max": { temperature: true } } } },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode", { fill: true });
  const entry = plan.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(!entry.changes.some((c) => c.field === "name"));
  const next = applyConfigFixes(config, plan);
  assert.ok(!("name" in next.provider.r4.models["qwen3.8-max"]));
});

test("未开 --fill：空 name 不被补齐（渲染逐字节不变）", () => {
  const config = {
    provider: { r4: { options: { apiKey: "sk-TEST" }, models: { "glm-5.3-flash": { name: "" } } } },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode");
  const entry = plan.entries.find((e) => e.input === "glm-5.3-flash");
  assert.ok(!entry, "无 fill 时空 name 条目不进入计划");
  assert.equal(plan.summary.change_items, 0);
  const text = renderFixPlan(plan, "test.json");
  assert.ok(text.includes("全部与官网一致 ✓"));
  assert.ok(!text.includes("展示名"));
});

test("fill: 应用后条目与 emitOpencode 输出逐字节一致（含 name）", () => {
  const id = "glm-5.3-flash";
  const config = {
    provider: {
      r4: {
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.example.com/v1", apiKey: "sk-TEST" },
        models: { [id]: { name: "" } },
      },
    },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode", { fill: true });
  const next = applyConfigFixes(config, plan);
  const applied = next.provider.r4.models[id];

  const catalogEntry = CATALOG.models.find((m) => m.id === id);
  assert.ok(catalogEntry, "catalog 应存在该模型");
  const emitted = JSON.parse(emitOpencode(catalogEntry, { name: id, keyId: id }))[id];

  assert.equal(
    JSON.stringify(sortedJson(applied)),
    JSON.stringify(sortedJson(emitted)),
    "补齐产物应与 emit opencode 的条目逐字节一致",
  );
});

test("fill: 只声明 name 的 opencode 条目，计划含全部规格字段，应用后与官网规格一致", () => {
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      r4: {
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.example.com/v1", apiKey: "sk-TEST" },
        models: { "qwen3.8-max": { name: "Qwen 3.8 Max" } },
      },
    },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode", { fill: true });
  assert.equal(plan.fill, true);
  const entry = plan.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(entry, "应有匹配条目");
  const fields = new Set(entry.changes.map((c) => c.field));
  for (const f of ["context", "output", "reasoning", "temperature", "tool_call", "attachment"]) {
    assert.ok(fields.has(f), `应包含字段 ${f}`);
  }
  for (const change of entry.changes) {
    assert.equal(change.missing, true);
    assert.equal(change.from, null);
  }
  // 官网已文档化的数值：不得臆造（快照值取自 catalog.json 现条目）
  const context = entry.changes.find((c) => c.field === "context");
  assert.equal(context.to, 1000000);

  const next = applyConfigFixes(config, plan);
  const applied = next.provider.r4.models["qwen3.8-max"];
  // 凭证原样保留
  assert.equal(next.provider.r4.options.apiKey, "sk-TEST");
  // limit / 布尔字段与官网规格一致
  assert.equal(applied.limit.context, 1000000);
  assert.equal(applied.limit.output, 131072);
  assert.equal(applied.reasoning, true);
  assert.equal(applied.tool_call, true);
  assert.equal(applied.attachment, true);
  // variants：官网 effort_values 非空 → 补齐 variants
  assert.ok(applied.variants && typeof applied.variants === "object");

  // 渲染：缺失标记显示为「（缺失）」，摘要不再显示「全部与官网一致 ✓」
  const text = renderFixPlan(plan, "test.json");
  assert.ok(text.includes("（缺失）"));
  assert.ok(!text.includes("全部与官网一致 ✓"));

  // fill 幂等：二次运行 0 项
  const again = planConfigFixes(CATALOG, next, "opencode", { fill: true });
  const againEntry = again.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(!againEntry || againEntry.changes.length === 0, "fill 应幂等");
  assert.equal(again.summary.change_items, 0);
  const againText = renderFixPlan(again, "test.json");
  assert.ok(againText.includes("全部与官网一致 ✓"), "幂等后摘要恢复一致");
});

test("fill: 官网 null 字段不臆造，记 skipped（官网未文档化）", () => {
  const nullModel = CATALOG.models.find((m) => m.context_window === null);
  assert.ok(nullModel, "catalog 应存在官网未文档化 context_window 的模型");
  const config = {
    provider: {
      r4: {
        options: { apiKey: "sk-TEST" },
        models: { [nullModel.id]: { name: "占位" } },
      },
    },
  };
  const plan = planConfigFixes(CATALOG, config, "opencode", { fill: true });
  const entry = plan.entries.find((e) => e.input === nullModel.id);
  assert.ok(entry, "应有匹配条目");
  assert.ok(
    entry.skipped.some((s) => s.field === "context" && s.reason === "官网未文档化"),
    "context 应记 skipped",
  );
  assert.ok(
    !entry.changes.some((c) => c.field === "context"),
    "不得为 null 字段生成补齐项",
  );
});

test("未传 --fill：行为与现状完全一致（{name} 条目无 changes、渲染显示全部一致）", () => {
  const model = CATALOG.models.find((m) => m.context_window !== null);
  const config = {
    provider: {
      r4: {
        options: { apiKey: "sk-TEST" },
        models: { [model.id]: { name: "占位" } },
      },
    },
  };

  const plan = planConfigFixes(CATALOG, config, "opencode");
  assert.equal(plan.fill, false);
  const entry = plan.entries.find((e) => e.input === model.id);
  assert.ok(!entry, "无 fill 时 name-only 条目不进入计划");
  assert.equal(plan.summary.change_items, 0);

  const text = renderFixPlan(plan, "test.json");
  assert.ok(text.includes("全部与官网一致 ✓"));
  assert.ok(!text.includes("（缺失）"));
});

test("fill: claude 格式 plan 层不生成补齐项（CLI 层直接 exit 2）", () => {
  const config = { env: { ANTHROPIC_MODEL: "qwen3.8-max", ANTHROPIC_AUTH_TOKEN: "sk-TEST" } };
  const plan = planConfigFixes(CATALOG, config, "claude", { fill: true });
  const entry = plan.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(!entry || entry.changes.length === 0);
});

test("fill: pi 格式 name-only 条目补齐 thinkingLevelMap / input / 数值", () => {
  const config = {
    providers: {
      r4: {
        api: "https://api.example.com/v1",
        apiKey: "sk-TEST",
        models: [{ id: "qwen3.8-max", name: "Qwen" }],
      },
    },
  };
  const plan = planConfigFixes(CATALOG, config, "pi", { fill: true });
  const entry = plan.entries.find((e) => e.input === "qwen3.8-max");
  assert.ok(entry, "应有匹配条目");
  const fields = new Set(entry.changes.map((c) => c.field));
  for (const f of ["context", "output", "reasoning", "efforts", "input"]) {
    assert.ok(fields.has(f), `应包含字段 ${f}`);
  }
  const next = applyConfigFixes(config, plan);
  const applied = next.providers.r4.models[0];
  assert.equal(applied.contextWindow, 1000000);
  assert.equal(applied.maxTokens, 131072);
  assert.ok(applied.thinkingLevelMap && typeof applied.thinkingLevelMap === "object");
  assert.deepEqual(applied.input, ["text", "image"]);
});
