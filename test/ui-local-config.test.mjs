// UI 本机配置查阅 / 注入接口（/api/local-config）端到端测试。
// 用 APIFIX_HOME 指向临时目录，绝不读写真实用户配置；凭证只用 sk-TEST-* 假值。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");

async function startUi(t, home) {
  const uiPort = 18911;
  const uiProc = spawn(process.execPath, [CLI, "--ui", "--port", String(uiPort), "--no-open"], {
    cwd: ROOT,
    env: { ...process.env, APIFIX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => uiProc.kill("SIGTERM"));

  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UI server start timeout")), 5000);
    uiProc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].replace(/\/+$/, ""));
      }
    });
    uiProc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    uiProc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI server exited prematurely with code ${code}`));
    });
  });
  return baseUrl;
}

test("UI /api/local-config：查阅脱敏 + 注入官网规格 + 备份", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "apifix-ui-local-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const ocDir = path.join(home, ".config", "opencode");
  mkdirSync(ocDir, { recursive: true });
  const ocFile = path.join(ocDir, "opencode.json");
  writeFileSync(ocFile, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      r4: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.invalid/v1", apiKey: "sk-TEST-LOCAL-SECRET" },
        models: {
          "deepseek-v4-pro": {
            name: "deepseek-v4-pro",
            limit: { context: 999999, output: 393216 },
          },
        },
      },
      step5: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://step5.example.invalid/v1", apiKey: "sk-TEST-EMPTY-PROV" },
        models: {},
      },
    },
  }, null, 2) + "\n", "utf8");

  const baseUrl = await startUi(t, home);

  const missing = await fetch(`${baseUrl}/api/local-config?platform=pi`);
  assert.equal(missing.status, 200);
  const missingData = await missing.json();
  assert.equal(missingData.ok, true);
  assert.equal(missingData.exists, false);
  assert.match(missingData.file, /models\.json$/);

  const badPlat = await fetch(`${baseUrl}/api/local-config?platform=foo`);
  assert.equal(badPlat.status, 400);

  const getRes = await fetch(`${baseUrl}/api/local-config?platform=opencode`);
  assert.equal(getRes.status, 200);
  const got = await getRes.json();
  assert.equal(got.ok, true);
  assert.equal(got.exists, true);
  assert.equal(got.platform, "opencode");
  assert.ok(got.preview.includes("[REDACTED]"), "预览必须脱敏");
  assert.equal(got.preview.includes("sk-TEST-LOCAL-SECRET"), false, "预览不得含明文 key");
  assert.ok(got.entries.some((e) => e.input === "deepseek-v4-pro"));
  assert.ok(got.summary.with_diffs >= 1, "夹具 context 与官网有差异");
  assert.deepEqual(got.providers.sort(), ["r4", "step5"]);
  const step5 = (got.providerBlocks || []).find((b) => b.name === "step5");
  assert.ok(step5, "空供应商仍应出现在分组里");
  assert.equal(step5.empty, true);
  assert.equal(step5.modelCount, 0);
  assert.ok(step5.preview.includes("[REDACTED]"));
  assert.equal(JSON.stringify(got).includes("sk-TEST-EMPTY-PROV"), false);

  const delEmptyProv = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete-provider", platform: "opencode", provider: "step5" }),
  });
  assert.equal(delEmptyProv.status, 200, `删除空供应商应 200，实际 ${delEmptyProv.status} ${await delEmptyProv.clone().text()}`);
  const delEmptyBody = await delEmptyProv.json();
  assert.equal(delEmptyBody.ok, true);
  assert.equal(delEmptyBody.deletedProvider, "step5");
  const afterEmptyDel = JSON.parse(readFileSync(ocFile, "utf8"));
  assert.equal(afterEmptyDel.provider.step5, undefined);
  assert.equal(afterEmptyDel.provider.r4.options.apiKey, "sk-TEST-LOCAL-SECRET");

  const noModels = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "opencode", models: [] }),
  });
  assert.equal(noModels.status, 400);

  const injectRes = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "opencode",
      providerName: "r4",
      models: ["gpt-6-astra", "deepseek-v4-pro"],
      noBackup: false,
    }),
  });
  assert.equal(injectRes.status, 200, `注入应 200，实际 ${injectRes.status} ${await injectRes.clone().text()}`);
  const injected = await injectRes.json();
  assert.equal(injected.ok, true);
  assert.equal(injected.created, false);
  assert.ok(injected.added.includes("gpt-6-astra"));
  assert.ok(injected.updated.includes("deepseek-v4-pro"));
  assert.ok(injected.backup, "应生成备份");
  assert.ok(injected.local && injected.local.preview.includes("[REDACTED]"));
  assert.equal(JSON.stringify(injected).includes("sk-TEST-LOCAL-SECRET"), false, "响应不得含明文 key");

  const after = JSON.parse(readFileSync(ocFile, "utf8"));
  assert.equal(after.provider.r4.options.apiKey, "sk-TEST-LOCAL-SECRET", "不得改写已有凭证");
  assert.equal(after.provider.r4.options.baseURL, "https://example.invalid/v1");
  assert.equal(after.provider.r4.models["gpt-6-astra"].limit.context, 1050000);
  assert.equal(after.provider.r4.models["deepseek-v4-pro"].limit.context, 1048576);
  assert.ok(readdirSync(ocDir).some((n) => n.startsWith("opencode.json.bak-")), "写入应留备份");

  const createPi = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "pi",
      providerName: "relay",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-TEST-PI",
      protocol: "openai-completions",
      models: ["gpt-6-astra"],
      noBackup: true,
    }),
  });
  assert.equal(createPi.status, 200);
  const piData = await createPi.json();
  assert.equal(piData.ok, true);
  assert.equal(piData.created, true);
  const piFile = path.join(home, ".pi", "agent", "models.json");
  assert.ok(existsSync(piFile));
  const piCfg = JSON.parse(readFileSync(piFile, "utf8"));
  assert.equal(piCfg.providers.relay.apiKey, "sk-TEST-PI");
  assert.equal(piCfg.providers.relay.models[0].id, "gpt-6-astra");
  assert.equal(piCfg.providers.relay.models[0].contextWindow, 1050000);
  const piGet = await fetch(`${baseUrl}/api/local-config?platform=pi`);
  const piView = await piGet.json();
  assert.equal(piView.preview.includes("sk-TEST-PI"), false);

  const createCodex = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "codex",
      providerName: "relay",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-TEST-CODEX",
      protocol: "chat",
      models: ["gpt-6-astra"],
      noBackup: true,
    }),
  });
  assert.equal(createCodex.status, 200);
  const codexFile = path.join(home, ".codex", "config.toml");
  const toml = readFileSync(codexFile, "utf8");
  assert.match(toml, /model = "gpt-6-astra"/);
  assert.match(toml, /experimental_bearer_token = "sk-TEST-CODEX"/);
  const codexGet = await fetch(`${baseUrl}/api/local-config?platform=codex`);
  const codexView = await codexGet.json();
  assert.equal(codexView.ok, true);
  assert.equal(codexView.preview.includes("sk-TEST-CODEX"), false);
  assert.match(codexView.preview, /\[REDACTED\]/);

  const createClaude = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "claude",
      baseURL: "https://example.invalid",
      apiKey: "sk-TEST-CLAUDE",
      models: ["claude-opus-4-6"],
      noBackup: true,
    }),
  });
  assert.equal(createClaude.status, 200, `claude 注入应 200，实际 ${createClaude.status} ${await createClaude.clone().text()}`);
  const claudeFile = path.join(home, ".claude", "settings.json");
  const claudeCfg = JSON.parse(readFileSync(claudeFile, "utf8"));
  assert.equal(claudeCfg.env.ANTHROPIC_AUTH_TOKEN, "sk-TEST-CLAUDE");
  assert.equal(claudeCfg.env.ANTHROPIC_MODEL, "claude-opus-4-6");
  const claudeGet = await fetch(`${baseUrl}/api/local-config?platform=claude`);
  const claudeView = await claudeGet.json();
  assert.equal(claudeView.preview.includes("sk-TEST-CLAUDE"), false);
  assert.match(claudeView.preview, /\[REDACTED\]/);

  const delMissing = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", platform: "opencode", model: "no-such-model", provider: "r4" }),
  });
  assert.equal(delMissing.status, 404);

  const delCodex = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", platform: "codex", model: "gpt-6-astra" }),
  });
  assert.equal(delCodex.status, 400);
  const delCodexBody = await delCodex.json();
  assert.match(delCodexBody.error, /Codex/);

  const delOc = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", platform: "opencode", model: "gpt-6-astra", provider: "r4" }),
  });
  assert.equal(delOc.status, 200, `删除应 200，实际 ${delOc.status} ${await delOc.clone().text()}`);
  const delOcBody = await delOc.json();
  assert.equal(delOcBody.ok, true);
  assert.equal(delOcBody.deleted, "gpt-6-astra");
  assert.equal(delOcBody.provider, "r4");
  assert.ok(delOcBody.backup);
  assert.equal(JSON.stringify(delOcBody).includes("sk-TEST-LOCAL-SECRET"), false);
  const afterDel = JSON.parse(readFileSync(ocFile, "utf8"));
  assert.equal(afterDel.provider.r4.options.apiKey, "sk-TEST-LOCAL-SECRET", "删除不得改写凭证");
  assert.equal(afterDel.provider.r4.models["gpt-6-astra"], undefined);
  assert.ok(afterDel.provider.r4.models["deepseek-v4-pro"], "未点名的模型应保留");

  const addPiSecond = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "pi",
      providerName: "relay",
      models: ["deepseek-v4-pro"],
      noBackup: true,
    }),
  });
  assert.equal(addPiSecond.status, 200);
  const delPi = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", platform: "pi", model: "gpt-6-astra", provider: "relay" }),
  });
  assert.equal(delPi.status, 200);
  const piAfter = JSON.parse(readFileSync(piFile, "utf8"));
  assert.equal(piAfter.providers.relay.apiKey, "sk-TEST-PI");
  assert.deepEqual(piAfter.providers.relay.models.map((m) => m.id), ["deepseek-v4-pro"]);

  const delClaude = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "delete",
      platform: "claude",
      model: "claude-opus-4-6",
      provider: "ANTHROPIC_MODEL",
    }),
  });
  assert.equal(delClaude.status, 200);
  const claudeAfter = JSON.parse(readFileSync(claudeFile, "utf8"));
  assert.equal(claudeAfter.env.ANTHROPIC_AUTH_TOKEN, "sk-TEST-CLAUDE");
  assert.equal(claudeAfter.env.ANTHROPIC_MODEL, undefined);
  assert.equal(claudeAfter.env.ANTHROPIC_BASE_URL, "https://example.invalid");

  const latest = await fetch(`${baseUrl}/api/local-config?platform=opencode`);
  const latestView = await latest.json();
  const r4 = (latestView.providerBlocks || []).find((b) => b.name === "r4");
  assert.ok(r4);
  const frag = JSON.parse(r4.preview);
  assert.equal(frag.options.apiKey, "[REDACTED]");
  frag.models["gpt-6-astra"] = { name: "gpt-6-astra" };
  const saveFrag = await fetch(`${baseUrl}/api/local-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update-provider",
      platform: "opencode",
      provider: "r4",
      fragment: JSON.stringify(frag, null, 2),
    }),
  });
  assert.equal(saveFrag.status, 200, `保存片段应 200，实际 ${saveFrag.status} ${await saveFrag.clone().text()}`);
  const saved = JSON.parse(readFileSync(ocFile, "utf8"));
  assert.equal(saved.provider.r4.options.apiKey, "sk-TEST-LOCAL-SECRET", "编辑片段不得用 [REDACTED] 覆盖真实 key");
  assert.equal(saved.provider.r4.models["gpt-6-astra"].name, "gpt-6-astra");
});
