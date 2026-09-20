// emit（codex / claude-env）契约测试：
//   - 精简输出：全量 327 条形状契约 + 若干精确快照（字节级）
//   - 完整模式（-f）：codex 的 provider 段 / wire_api 三态 / 引号键；claude 的 settings.json env 块
//   - 占位符纪律：只出现 YOUR_BASE_URL / YOUR_API_KEY，绝不出现真实凭证
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitExtra } from "../lib/core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
const byId = (id) => {
  const entry = catalog.models.find((m) => m.id === id);
  assert.ok(entry, `catalog 缺少 ${id}`);
  return entry;
};

test("精简输出：全量形状契约（codex 两行 / claude 三行）", () => {
  for (const entry of catalog.models) {
    const codexLines = emitExtra(entry, "codex", { name: entry.id, keyId: entry.id }).split("\n");
    assert.equal(codexLines.length, 2, `${entry.id}: codex 应为 2 行`);
    assert.equal(codexLines[0], `model = "${entry.id}"`);
    assert.match(
      codexLines[1],
      /^(model_reasoning_effort = "[A-Za-z0-9_-]+"|# model_reasoning_effort = 未知，需确认（该模型未文档化 reasoning effort 档位）)$/,
      `${entry.id}: codex 第二行形状异常`,
    );

    const claudeLines = emitExtra(entry, "claude-env", { name: entry.id, keyId: entry.id }).split("\n");
    assert.equal(claudeLines.length, 3, `${entry.id}: claude 应为 3 行`);
    assert.equal(claudeLines[0], `ANTHROPIC_MODEL=${entry.id}`);
    assert.match(
      claudeLines[1],
      /^(MAX_THINKING_TOKENS=\d+|# MAX_THINKING_TOKENS=未知，需确认（该模型未文档化 thinking budget）)$/,
      `${entry.id}: claude 第二行形状异常`,
    );
    assert.match(
      claudeLines[2],
      /^(CLAUDE_CODE_EFFORT_LEVEL=[A-Za-z0-9_-]+|# CLAUDE_CODE_EFFORT_LEVEL=(未知，需确认（该模型未文档化 effort 档位）|不适用（该模型不支持推理）))$/,
      `${entry.id}: claude 第三行形状异常`,
    );
  }
});

test("精简输出：精确快照（有 effort / 无 effort / 有 budget）", () => {
  assert.equal(
    emitExtra(byId("gpt-6-astra"), "codex", { keyId: "gpt-6-astra" }),
    'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"',
  );
  assert.equal(
    emitExtra(byId("jamba-1.5-large"), "codex", { keyId: "jamba-1.5-large" }),
    'model = "jamba-1.5-large"\n# model_reasoning_effort = 未知，需确认（该模型未文档化 reasoning effort 档位）',
  );
  assert.equal(
    emitExtra(byId("qwen3.8-max"), "claude-env", { keyId: "qwen3.8-max" }),
    "ANTHROPIC_MODEL=qwen3.8-max\nMAX_THINKING_TOKENS=1\nCLAUDE_CODE_EFFORT_LEVEL=xhigh",
  );
});

test("完整模式（codex）：provider 段 / 占位符 / 引号键 / wire_api 三态", () => {
  const text = emitExtra(byId("gpt-6-astra"), "codex", { name: "My Relay", keyId: "gpt-6-astra", full: true });
  assert.match(text, /^model = "gpt-6-astra"$/m);
  assert.match(text, /^model_provider = "gpt-6-astra"$/m);
  assert.match(text, /^\[model_providers\.gpt-6-astra\]$/m);
  assert.match(text, /^name = "My Relay"$/m);
  assert.match(text, /^base_url = "https:\/\/YOUR_BASE_URL\/v1"/m);
  assert.match(text, /^wire_api = "responses"$/m);

  // 含 . 的 id：TOML 表头必须用引号键
  const dotted = emitExtra(byId("jamba-1.5-large"), "codex", { keyId: "jamba-1.5-large", full: true });
  assert.match(dotted, /^\[model_providers\."jamba-1\.5-large"\]$/m);
  assert.match(dotted, /# wire_api 无法映射（api_protocol=native/);
  assert.ok(!dotted.includes("wire_api = "), "无法映射时不得输出 wire_api 键");

  const chat = emitExtra(byId("step-5-preview"), "codex", { keyId: "step-5-preview", full: true });
  assert.match(chat, /^wire_api = "chat"$/m);
});

test("完整模式（claude-env）：settings.json 形状 / 值全为字符串 / 缺失字段省略", () => {
  const parsed = JSON.parse(emitExtra(byId("qwen3.8-max"), "claude-env", { keyId: "qwen3.8-max", full: true }));
  assert.deepEqual(parsed, {
    env: {
      ANTHROPIC_BASE_URL: "https://YOUR_BASE_URL",
      ANTHROPIC_AUTH_TOKEN: "YOUR_API_KEY",
      ANTHROPIC_MODEL: "qwen3.8-max",
      MAX_THINKING_TOKENS: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
    },
  });
  for (const value of Object.values(parsed.env)) assert.equal(typeof value, "string");

  // 未文档化 budget → 整个键省略（不臆造数值）
  const noBudget = JSON.parse(emitExtra(byId("gpt-6-astra"), "claude-env", { keyId: "gpt-6-astra", full: true }));
  assert.equal("MAX_THINKING_TOKENS" in noBudget.env, false);
});

test("完整模式：note 走回调，不混入 stdout 字节", () => {
  const notes = [];
  const text = emitExtra(byId("gpt-6-astra"), "codex", { keyId: "gpt-6-astra", full: true, onNote: (line) => notes.push(line) });
  assert.ok(notes.length >= 1, "应通过 onNote 报告占位符提示");
  assert.ok(!text.includes("[i]"), "stdout 不得含 note 文本");
});

test("curl / sdk 目标仍可用（emitExtra 分发未回归）", () => {
  const curl = emitExtra(byId("gpt-6-astra"), "curl", { keyId: "gpt-6-astra" });
  const sdk = emitExtra(byId("gpt-6-astra"), "sdk", { keyId: "gpt-6-astra" });
  assert.ok(curl.includes("gpt-6-astra"));
  assert.ok(sdk.length > 0);
});
