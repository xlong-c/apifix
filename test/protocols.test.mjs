// protocols（协议总览）测试 —— 子进程跑 CLI，夹具放在 os.tmpdir()，
// 凭证只用假值（sk-TEST-*），--no-defaults 只扫 --file 指定的文件。
// 重点：@ai-sdk/openai 按「OpenAI 家族（chat_completions / responses）」比对（本次修复）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");
const FAKE_KEY = "sk-TEST-not-a-real-key";

function runProtocols(file) {
  return spawnSync(process.execPath, [CLI, "protocols", "--file", file, "--no-defaults", "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

function writeConfig(dir, provider) {
  const file = path.join(dir, "oc.json");
  writeFileSync(file, JSON.stringify({ provider: { step: provider } }, null, 2), "utf8");
  return file;
}

function modelStatus(stdout) {
  const payload = JSON.parse(stdout);
  assert.equal(payload.providers.length, 1);
  assert.equal(payload.providers[0].models.length, 1);
  return { provider: payload.providers[0], model: payload.providers[0].models[0] };
}

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-protocols-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("protocols：@ai-sdk/openai（普通 /v1 baseURL）按 OpenAI 家族判定 → 匹配", () => {
  withDir((dir) => {
    const file = writeConfig(dir, {
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://api.stepfun.com/v1", apiKey: FAKE_KEY },
      models: { "step-5-preview": { name: "step-5-preview" } },
    });
    const r = runProtocols(file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { provider, model } = modelStatus(r.stdout);
    assert.equal(provider.protocol, "openai");
    assert.equal(provider.inferred, true);
    assert.equal(model.matchedId, "step-5-preview");
    assert.equal(model.status, "match", `实际 ${model.status}（原生 ${model.native}）`);
    assert.ok(!r.stdout.includes(FAKE_KEY), "输出不得包含假 key");
  });
});

test("protocols：@ai-sdk/openai + /responses baseURL + 仅支持 chat_completions 的模型 → 协议不确定（推断值不武断报警）", () => {
  withDir((dir) => {
    const file = writeConfig(dir, {
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://relay.example/responses" },
      models: { "glm-5.3-flash": { name: "glm-5.3-flash" } },
    });
    const r = runProtocols(file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { provider, model } = modelStatus(r.stdout);
    assert.equal(provider.protocol, "responses");
    assert.equal(provider.inferred, true);
    // 推断值（来自 baseURL 路径）与官方不一致时只提示"不确定"，不报"需翻译"
    assert.equal(model.status, "unknown", `实际 ${model.status}（原生 ${model.native}）`);
  });
});

test("protocols：@ai-sdk/anthropic 精确判定（不回归）+ 凭证不回显", () => {
  withDir((dir) => {
    const file = writeConfig(dir, {
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://relay.example", apiKey: FAKE_KEY },
      models: { "claude-3-5-sonnet-20240620": { name: "claude-3-5-sonnet-20240620" } },
    });
    const r = runProtocols(file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { provider, model } = modelStatus(r.stdout);
    assert.equal(provider.protocol, "anthropic_messages");
    assert.equal(provider.inferred, false);
    assert.equal(model.status, "match");
    assert.ok(!r.stdout.includes(FAKE_KEY));
  });
});

test("protocols：未收录的模型 id → unmapped（不抛错）", () => {
  withDir((dir) => {
    const file = writeConfig(dir, {
      npm: "@ai-sdk/openai",
      models: { "totally-unknown-model-xyz": { name: "x" } },
    });
    const r = runProtocols(file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { model } = modelStatus(r.stdout);
    assert.equal(model.status, "unmapped");
  });
});
