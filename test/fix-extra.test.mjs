// fix（codex TOML / claude settings.json）round-trip 测试 —— 子进程跑 CLI，
// 夹具全部放在 os.tmpdir()，凭证只用假值（sk-TEST-*）。
// 覆盖：(a) --dry-run 不写；(b) 只改计划字段、其余字节不动；(c) 备份生成；
//       (d) 幂等；(e) claude 的 AUTH_TOKEN 原样保留、值保持字符串。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");
const FAKE_TOKEN = "sk-TEST-CLAUDE-not-a-real-key";

const CODEX_TOML = [
  "# 夹具：两处错误（effort=ultra、wire_api=responses），其余内容必须原样保留",
  'model = "qwen3.8-max-0902"',
  'model_provider = "relay"',
  'model_reasoning_effort = "ultra"   # 行尾注释也要保留',
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

function runFix(file, args = []) {
  return spawnSync(process.execPath, [CLI, "fix", file, ...args], { encoding: "utf8", cwd: ROOT });
}

test("fix codex：--dry-run 不写；--yes 只改目标值（其余字节逐字节保留）+ 备份 + 幂等", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-"));
  try {
    const file = path.join(dir, "config.toml");
    writeFileSync(file, CODEX_TOML, "utf8");

    const dry = runFix(file, ["--dry-run"]);
    assert.equal(dry.status, 1, dry.stdout + dry.stderr);
    assert.equal(readFileSync(file, "utf8"), CODEX_TOML, "--dry-run 不得写入");

    const applied = runFix(file, ["--yes"]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const fixed = readFileSync(file, "utf8");
    const expected = CODEX_TOML
      .replace('model_reasoning_effort = "ultra"   # 行尾注释也要保留', 'model_reasoning_effort = "xhigh"   # 行尾注释也要保留')
      .replace('wire_api = "responses"', 'wire_api = "chat"');
    assert.equal(fixed, expected, "只允许计划内的两处值变化");

    // 备份已生成（夹具目录里应有 .bak- 文件）
    assert.ok(readdirSync(dir).some((name) => name.includes(".bak-")), "应生成备份");

    // 幂等：再次 fix 应无改动（exit 0）
    const again = runFix(file, ["--yes", "--no-backup"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(readFileSync(file, "utf8"), fixed, "复验不得再改");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix codex：CRLF 行尾保留", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-"));
  try {
    const file = path.join(dir, "crlf.toml");
    const crlf = CODEX_TOML.split("\n").join("\r\n");
    writeFileSync(file, crlf, "utf8");
    const r = runFix(file, ["--yes", "--no-backup"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const fixed = readFileSync(file, "utf8");
    assert.ok(fixed.includes("\r\n"), "应保留 CRLF");
    assert.equal(fixed.replace(/\r\n/g, "").includes("\n"), false, "不得混入裸 LF");
    assert.ok(fixed.includes('wire_api = "chat"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix claude：AUTH_TOKEN 原样保留、值保持字符串、仅目标键变化、幂等", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-"));
  try {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, CLAUDE_JSON, "utf8");

    const r = runFix(file, ["--yes", "--no-backup"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, FAKE_TOKEN, "凭证必须原样保留");
    assert.equal(parsed.env.CLAUDE_CODE_EFFORT_LEVEL, "xhigh");
    assert.equal(parsed.env.MAX_THINKING_TOKENS, "32768");
    assert.equal(typeof parsed.env.MAX_THINKING_TOKENS, "string", "env 值必须保持字符串");
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, "https://example.invalid");

    const again = runFix(file, ["--yes", "--no-backup"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).env.CLAUDE_CODE_EFFORT_LEVEL, "xhigh", "幂等");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix：未收录模型只提示、不误改（codex）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-"));
  try {
    const file = path.join(dir, "unknown.toml");
    const text = ['model = "my-custom-model"', 'model_reasoning_effort = "ultra"', ""].join("\n");
    writeFileSync(file, text, "utf8");
    // 无任何可修项 → 与 opencode/pi 语义一致：exit 0（只报告未收录），文件不动
    const r = runFix(file, ["--dry-run"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /未收录/);
    assert.equal(readFileSync(file, "utf8"), text, "未收录不得写入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
