// audit（codex TOML / claude settings.json）测试 —— 子进程跑 CLI，
// 夹具全部放在 os.tmpdir()，凭证只用假值（sk-TEST-*），绝不读写真实用户配置。
// 覆盖：auto 识别（后缀/内容/JSON env）、差异与 exit code、TOML 不回显原文、
//       claude 的 AUTH_TOKEN 永不出现在任何输出里。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");
const FAKE_TOKEN = "sk-TEST-CLAUDE-not-a-real-key";

const CODEX_TOML = [
  "# 测试夹具（无真实凭证）",
  'model = "qwen3.8-max-0902"',
  'model_provider = "relay"',
  'model_reasoning_effort = "ultra"',
  "",
  "[model_providers.relay]",
  'name = "relay"',
  'base_url = "https://example.invalid/v1"',
  'wire_api = "responses"',
  "",
].join("\n");

const CLAUDE_JSON = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
    ANTHROPIC_MODEL: "qwen3.8-max",
    CLAUDE_CODE_EFFORT_LEVEL: "ultra",
    MAX_THINKING_TOKENS: "999999",
  },
}, null, 2) + "\n";

function runAudit(file, args = []) {
  return spawnSync(process.execPath, [CLI, "audit", file, ...args], { encoding: "utf8", cwd: ROOT });
}

function makeDir() {
  return mkdtempSync(path.join(tmpdir(), "apifix-audit-"));
}

test("audit：codex .toml 自动识别（后缀）→ 差异 + exit 1", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "config.toml");
    writeFileSync(file, CODEX_TOML, "utf8");
    const r = runAudit(file);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /识别为 codex 配置/);
    assert.match(r.stdout, /推理档位/);
    assert.match(r.stdout, /wire_api/);
    assert.match(r.stdout, /qwen3.8-max-0902/);
    assert.ok(!r.stdout.includes("base_url ="), "不得把 TOML 行当模型 id 回显");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit：claude settings.json 自动识别（内容）→ 差异 + exit 1，AUTH_TOKEN 不回显", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, CLAUDE_JSON, "utf8");
    const r = runAudit(file);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /识别为 claude 配置/);
    assert.match(r.stdout, /思考预算/);
    assert.match(r.stdout, /超出官方上限/);
    assert.ok(!r.stdout.includes(FAKE_TOKEN), "输出不得包含假 token");
    assert.ok(!r.stdout.includes("ANTHROPIC_AUTH_TOKEN"), "输出不得出现凭证键名");
    assert.ok(!r.stderr.includes(FAKE_TOKEN), "stderr 也不得包含假 token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit：--format codex（无后缀）/ --format claude-env（别名）/ --json 机身可解析且已脱敏", () => {
  const dir = makeDir();
  try {
    const tomlFile = path.join(dir, "noext");
    writeFileSync(tomlFile, CODEX_TOML, "utf8");
    const r1 = runAudit(tomlFile, ["--format", "codex"]);
    assert.equal(r1.status, 1, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /识别为 codex 配置/);

    const claudeFile = path.join(dir, "claude.txt");
    writeFileSync(claudeFile, CLAUDE_JSON, "utf8");
    const r2 = runAudit(claudeFile, ["--format", "claude-env", "--json"]);
    assert.equal(r2.status, 1, r2.stdout + r2.stderr);
    const payload = JSON.parse(r2.stdout);
    assert.equal(payload.format, "claude");
    assert.ok(!JSON.stringify(payload).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(payload).includes("ANTHROPIC_AUTH_TOKEN"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit：破损 TOML / 缺少 model 的 TOML → exit 2 且不回显原文", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "broken.toml");
    writeFileSync(file, "[model_providers.relay\nbase_url = \"https://example.invalid\"\n", "utf8");
    const r = runAudit(file, ["--format", "codex"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /未从配置中提取到任何模型条目/);
    assert.ok(!r.stderr.includes("https://example.invalid"), "错误信息不得回显原文");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit：stdin（-）也可识别 TOML", () => {
  const r = spawnSync(process.execPath, [CLI, "audit", "-"], {
    encoding: "utf8", cwd: ROOT, input: CODEX_TOML,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /识别为 codex 配置/);
});

test("audit：配置识别只认 id/别名 —— 归一化写法报未收录 + 归一化建议（不套用官网规格）", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "strict.json");
    writeFileSync(file, JSON.stringify({
      provider: {
        relay: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://relay.example/v1", apiKey: "sk-TEST-x" },
          models: {
            "glm-5.3-flash": { name: "glm-5.3-flash" },
            "glm-5.3-flash-free": { name: "glm-5.3-flash-free" },
          },
        },
      },
    }, null, 2), "utf8");
    const r = runAudit(file);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[OK\] glm-5\.3-flash/);
    assert.match(r.stdout, /\[?\] glm-5\.3-flash-free → 未收录/);
    assert.match(r.stdout, /最接近: glm-5\.3-flash（归一化写法，未自动采用官网规格）/);
    assert.ok(!r.stdout.includes("sk-TEST"), "输出不得包含假 key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
