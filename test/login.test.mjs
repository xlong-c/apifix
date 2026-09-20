// login 子命令测试 —— 三层覆盖：
//   (1) deriveProviderName 表驱动（纯函数）
//   (2) buildOpencodeProvider 三协议形状（纯函数，断言 provider 块无 apiKey 键）
//   (3) 非交互端到端（spawn CLI，--file 指向 os.tmpdir() 临时文件，绝不读写真实用户配置）
// 凭证纪律：夹具只用 sk-TEST-* 假 key；断言 key 只落 options.apiKey。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveProviderName, OPENCODE_NPM_DEFAULTS, buildOpencodeProvider } from "../lib/core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");

// ---------------------------------------------------------------------------
// (1) deriveProviderName：www. 前缀 / 多级域 / 裸 IP / 空串 / 非法输入
// ---------------------------------------------------------------------------
test("deriveProviderName：表驱动", () => {
  const cases = [
    // [输入, 期望]
    ["api.r4.codes", "api"],         // 取主机名第一段
    ["r4.codes", "r4"],              // 二级域
    ["www.mcgrox.top", "mcgrox"],    // www. 前缀剥掉
    ["www.example.com", "example"],  // www. + 多级
    ["deep.api.example.co.uk", "deep"], // 多级仍取第一段
    ["WWW.MidSpace.AI", "midspace"], // 大小写归一
    ["192.168.1.1", null],           // 裸 IPv4：不臆造名字
    ["10.0.0.8", null],
    ["", null],                      // 空串
    ["   ", null],                   // 纯空白
    [null, null],                    // 非字符串
    [undefined, null],
    ["localhost", "localhost"],      // 无点主机名：第一段即全名
    ["api-x.r4.codes", "api-x"],     // 保留连字符
    ["中文.example.com", null],      // 非法字符清洗后为空 → null
  ];
  for (const [input, expected] of cases) {
    assert.equal(deriveProviderName(input), expected, `deriveProviderName(${JSON.stringify(input)})`);
  }
});

// ---------------------------------------------------------------------------
// (2) buildOpencodeProvider：三协议 npm 映射 + 形状 + 无 apiKey
// ---------------------------------------------------------------------------
test("buildOpencodeProvider：三协议 npm 映射与键序", () => {
  assert.deepEqual(OPENCODE_NPM_DEFAULTS, {
    openai: "@ai-sdk/openai-compatible",
    anthropic: "@ai-sdk/anthropic",
    gemini: "@ai-sdk/google",
  });
  for (const protocol of ["openai", "anthropic", "gemini"]) {
    const block = buildOpencodeProvider({
      name: "prov",
      baseURL: "https://example.invalid/v1",
      protocol,
      modelEntries: { "m-1": { name: "m-1" } },
    });
    assert.equal(block.npm, OPENCODE_NPM_DEFAULTS[protocol], `${protocol} 的 npm 包`);
    assert.deepEqual(Object.keys(block), ["npm", "options", "models"], `${protocol} 顶层键序`);
    assert.deepEqual(block.options, { baseURL: "https://example.invalid/v1" }, `${protocol} options 只有 baseURL`);
    assert.deepEqual(block.models["m-1"], { name: "m-1" });
  }
  // 显式 npm 覆盖（openai 兼容中转复用真实配置里的实际包名）
  const custom = buildOpencodeProvider({
    name: "prov",
    baseURL: "https://example.invalid/v1",
    npm: "@ai-sdk/openai",
    protocol: "openai",
    modelEntries: {},
  });
  assert.equal(custom.npm, "@ai-sdk/openai");
});

test("buildOpencodeProvider：provider 块绝不含 apiKey 键（凭证不进纯函数层）", () => {
  const block = buildOpencodeProvider({
    name: "prov",
    baseURL: "https://example.invalid/v1",
    protocol: "openai",
    modelEntries: { "m-1": { name: "m-1", limit: { context: 1 } } },
  });
  const flat = JSON.stringify(block);
  assert.ok(!flat.includes("apiKey"), "provider 块任何位置不得出现 apiKey");
  assert.ok(!Object.prototype.hasOwnProperty.call(block.options, "apiKey"), "options 上不得有 apiKey 键");
  // modelEntries 键按字母序排
  const sorted = buildOpencodeProvider({
    name: "prov",
    baseURL: "https://example.invalid/v1",
    protocol: "openai",
    modelEntries: { "b-model": { name: "b" }, "a-model": { name: "a" } },
  });
  assert.deepEqual(Object.keys(sorted.models), ["a-model", "b-model"], "models 键应按字母序");
});

test("buildOpencodeProvider：非法入参抛错", () => {
  assert.throws(() => buildOpencodeProvider({ name: "", baseURL: "https://x", protocol: "openai", modelEntries: {} }));
  assert.throws(() => buildOpencodeProvider({ name: "p", baseURL: "", protocol: "openai", modelEntries: {} }));
  assert.throws(() => buildOpencodeProvider({ name: "p", baseURL: "https://x", protocol: "sse", modelEntries: {} }));
});

// ---------------------------------------------------------------------------
// (3) 非交互端到端（spawn CLI；--file 指向临时目录，绝不碰真实配置）
// ---------------------------------------------------------------------------
function runLogin(args) {
  return spawnSync(process.execPath, [CLI, "login", ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

// 标准非交互参数（假 key + 临时文件 + --no-fetch + --yes + --no-backup）
function loginArgs(file, extra = []) {
  return [
    "opencode", "testprov",
    "--file", file,
    "--base-url", "https://example.invalid/v1",
    "--api-key", "sk-TEST-LOGIN",
    "--model", "gpt-6-astra",
    "--no-fetch", "--yes", "--no-backup",
    ...extra,
  ];
}

test("login 非交互端到端：写入形状 / 官网规格 / key 只落 options.apiKey", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  const run = runLogin(loginArgs(file));
  assert.equal(run.status, 0, `exit 0，实际 ${run.status}；stderr=${run.stderr}`);

  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.$schema, "https://opencode.ai/config.json", "新建文件带 $schema");
  const block = config.provider.testprov;
  assert.ok(block, "provider 块存在");
  assert.equal(block.npm, "@ai-sdk/openai-compatible", "openai 协议默认 npm");
  assert.equal(block.options.baseURL, "https://example.invalid/v1");
  assert.equal(block.options.apiKey, "sk-TEST-LOGIN", "key 只写 options.apiKey");

  // 官网规格（catalog 中 gpt-6-astra 条目，与 `node apifix.mjs gpt-6-astra` 最小 emit 同形状）
  const spec = block.models["gpt-6-astra"];
  assert.ok(spec, "gpt-6-astra 规格条目存在");
  assert.equal(spec.limit.context, 1050000);
  assert.equal(spec.limit.output, 128000);
  assert.equal(spec.temperature, false);
  assert.equal(spec.tool_call, true);
  assert.equal(spec.reasoning, true);
  assert.equal(spec.attachment, true);
});

test("login 非交互：同名 provider 无 --force → exit 2；--force → 覆盖成功 exit 0", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  const first = runLogin(loginArgs(file));
  assert.equal(first.status, 0);
  const before = JSON.parse(readFileSync(file, "utf8"));

  // 重复运行：非交互无 --force → exit 2，原文件不动
  const again = runLogin(loginArgs(file));
  assert.equal(again.status, 2, `同名覆盖应 exit 2，实际 ${again.status}；stderr=${again.stderr}`);
  assert.ok(readFileSync(file, "utf8").includes("sk-TEST-LOGIN"), "被拒后文件内容不变（仍是首次写入的配置）");

  // --force：覆盖成功，baseURL 更新
  const forced = runLogin(loginArgs(file, ["--force"]));
  assert.equal(forced.status, 0, `--force 应 exit 0，实际 ${forced.status}；stderr=${forced.stderr}`);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.provider.testprov.options.baseURL, "https://example.invalid/v1");
});

test("login 非交互：缺 flag → exit 2 并提示缺什么", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  // 缺 --api-key 与 --model
  const missing = runLogin([
    "opencode", "testprov", "--file", file,
    "--base-url", "https://example.invalid/v1",
    "--no-fetch", "--yes", "--no-backup",
  ]);
  assert.equal(missing.status, 2, `缺 flag 应 exit 2，实际 ${missing.status}`);
  assert.ok(missing.stderr.includes("--api-key"), "提示缺 --api-key");
  assert.ok(missing.stderr.includes("--model"), "提示缺 --model");
  assert.ok(!existsSync(file), "缺 flag 时不得写文件");

  // 缺 --base-url
  const missingUrl = runLogin([
    "opencode", "testprov", "--file", file,
    "--api-key", "sk-TEST-LOGIN", "--model", "gpt-6-astra",
    "--no-fetch", "--yes", "--no-backup",
  ]);
  assert.equal(missingUrl.status, 2);
  assert.ok(missingUrl.stderr.includes("--base-url"), "提示缺 --base-url");
});

test("login：--json 输出只含掩码 key，绝不回显明文", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  const run = runLogin(loginArgs(file, ["--json", "--force"]));
  assert.equal(run.status, 0, `--json 应 exit 0，实际 ${run.status}；stderr=${run.stderr}`);
  // stdout（JSON 计划）与 stderr（复验提示）合并检查：明文不得出现在任何输出
  assert.ok(!run.stdout.includes("sk-TEST-LOGIN"), "stdout 不得出现明文 key");
  assert.ok(!run.stderr.includes("sk-TEST-LOGIN"), "stderr 不得出现明文 key");
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.api_key_masked, "sk-TE***OGIN", "掩码格式：前5+***+后4");
});

test("login：未收录模型写最小条目 {name: id}", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  const run = runLogin([
    "opencode", "testprov",
    "--file", file,
    "--base-url", "https://example.invalid/v1",
    "--api-key", "sk-TEST-LOGIN",
    "--model", "totally-unknown-model",
    "--no-fetch", "--yes", "--no-backup",
  ]);
  assert.equal(run.status, 0, `未收录模型也应 exit 0，实际 ${run.status}；stderr=${run.stderr}`);
  assert.ok(run.stderr.includes("catalog 未收录"), "stderr 应提示未收录");
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(config.provider.testprov.models["totally-unknown-model"], { name: "totally-unknown-model" });
});

test("login：写入产物 fix --dry-run 零差异（规格与官网一致）", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-login-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc.json");

  const run = runLogin(loginArgs(file));
  assert.equal(run.status, 0);
  // fix dry-run 对已对齐的配置应报「无差异」exit 0（fix 语义：0 = 已应用或无差异）
  const fix = spawnSync(process.execPath, [CLI, "fix", file, "--dry-run"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(fix.status, 0, `fix --dry-run 应 exit 0（无差异），实际 ${fix.status}；stdout=${fix.stdout}；stderr=${fix.stderr}`);
});
