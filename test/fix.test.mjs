// fix 子命令 round-trip 测试 —— 通过子进程跑 CLI（node apifix.mjs fix <tmpfile>）
// 夹具全部放在 os.tmpdir()，凭证只用假值（sk-TEST-*），绝不读写真实用户配置。
// 覆盖：(a) --dry-run 不改文件；(b) 应用后只有计划内字段被改；(c) 生成备份；(d) 幂等。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");

// 造 opencode 配置夹具（全部假值）：
//   - 假 key（sk-TEST-*）
//   - deepseek-v4-pro：limit.context 与官网（1048576）有差异
//   - my-own-thing：catalog 未声明的自定义模型（含未声明字段，fix 不得动）
//   - myNote / limit.myExtra：catalog 未声明的字段（应原样保留）
function makeFixture(dir) {
  const file = path.join(dir, "oc.json");
  const fixture = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      r4: {
        options: { apiKey: "sk-TEST-not-a-real-key" },
        models: {
          "deepseek-v4-pro": {
            name: "deepseek-v4-pro",
            limit: { context: 999999, output: 393216 },
            reasoning: true,
            tool_call: true,
            attachment: false,
            temperature: true,
            variants: {
              high: { reasoningEffort: "high" },
              low: { reasoningEffort: "low" },
              max: { reasoningEffort: "max" },
              none: { reasoningEffort: "none" },
            },
          },
          "my-own-thing": {
            name: "my-own-thing",
            limit: { context: 12345 },
            myNote: "自定义字段",
          },
        },
      },
    },
  };
  writeFileSync(file, JSON.stringify(fixture, null, 2), "utf8");
  return file;
}

function runFix(file, args) {
  return spawnSync(process.execPath, [CLI, "fix", file, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

test("fix round-trip：dry-run 不改文件、应用只改计划内字段、有备份、幂等", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = makeFixture(dir);
  const before = readFileSync(file, "utf8");

  // (a) --dry-run：有差异时 exit 1，文件保持原样
  const dry = runFix(file, ["--dry-run"]);
  assert.equal(dry.status, 1, `--dry-run 有差异应 exit 1，实际 ${dry.status}`);
  assert.ok(dry.stdout.includes("999,999 → 1,048,576"), "计划应展示 context 差异");
  assert.ok(dry.stdout.includes("1,048,576"), "计划应展示目标值");
  assert.equal(readFileSync(file, "utf8"), before, "--dry-run 不得改写文件");
  assert.ok(!readdirSync(dir).some((n) => n.startsWith("oc.json.bak")), "--dry-run 不得写备份");

  // --json 模式的计划：确认计划只含 context 一项
  const dryJson = runFix(file, ["--dry-run", "--json"]);
  assert.equal(dryJson.status, 1);
  const plan = JSON.parse(dryJson.stdout);
  assert.equal(plan.format, "opencode");
  assert.equal(plan.dry_run, true);
  assert.equal(plan.applied, false);
  assert.equal(plan.summary.change_items, 1, "只有 context 一处差异");
  const planned = plan.entries.filter((e) => e.changes.length);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].input, "deepseek-v4-pro");
  assert.equal(planned[0].changes[0].field, "context");
  assert.equal(planned[0].changes[0].to, 1048576);
  // 未收录模型在计划里登记但无可修项
  const unmatched = plan.entries.filter((e) => !e.matchedId);
  assert.ok(unmatched.some((e) => e.input === "my-own-thing"), "未收录模型应登记为 unmatched");

  // (b)+(c) 应用（--yes）：exit 0，写备份，只有计划内字段被改
  const apply = runFix(file, ["--yes"]);
  assert.equal(apply.status, 0, `应用应 exit 0，stderr=${apply.stderr}`);

  const backups = readdirSync(dir).filter((n) => n.startsWith("oc.json.bak-"));
  assert.equal(backups.length, 1, "应生成恰好一个备份文件");
  const backupContent = JSON.parse(readFileSync(path.join(dir, backups[0]), "utf8"));
  assert.equal(backupContent.provider.r4.models["deepseek-v4-pro"].limit.context, 999999, "备份应保存修复前状态");

  const applied = JSON.parse(readFileSync(file, "utf8"));
  const r4 = applied.provider.r4.models;
  // 计划内字段被改为官网规格
  assert.equal(r4["deepseek-v4-pro"].limit.context, 1048576, "context 应回写官网规格");
  // 假 key 原样保留（凭证永不进计划）
  assert.equal(applied.provider.r4.options.apiKey, "sk-TEST-not-a-real-key");
  // catalog 未声明字段：原样保留
  assert.equal(r4["my-own-thing"].limit.context, 12345, "未收录模型的字段不得改动");
  assert.equal(r4["my-own-thing"].myNote, "自定义字段", "未声明字段应原样保留");
  // 其他字段未被波及
  assert.equal(r4["deepseek-v4-pro"].limit.output, 393216);
  assert.equal(r4["deepseek-v4-pro"].reasoning, true);

  // (d) 幂等：二次运行 0 差异，exit 0
  // 注意：夹具含 1 个未收录模型（my-own-thing），故不会显示「全部与官网一致」，
  // 幂等口径 = exit 0 + 无可修项 + 文件内容零差异。
  const again = runFix(file, ["--yes"]);
  assert.equal(again.status, 0, `幂等复跑应 exit 0，stderr=${again.stderr}`);
  assert.ok(!again.stdout.includes("可修复"), "二次运行不应再有可修复项");
  assert.ok(again.stdout.includes("1 未收录"), "未收录模型仍应登记");
  const afterAgain = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(afterAgain, applied, "二次运行后文件内容应零差异");
});

test("fix round-trip：官网 null 字段不臆造（跳过并说明）", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-fix-null-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oc2.json");
  // deepseek-v4.1-flash-expires-on-0910：官网 context_window / max_output_tokens / temperature 均为 null
  const fixture = {
    provider: {
      r4: {
        options: { apiKey: "sk-TEST-not-a-real-key" },
        models: {
          "deepseek-v4.1-flash-expires-on-0910": {
            name: "x",
            limit: { context: 123456, output: 65536 },
            temperature: true,
          },
        },
      },
    },
  };
  writeFileSync(file, JSON.stringify(fixture, null, 2), "utf8");

  const apply = runFix(file, ["--yes"]);
  assert.equal(apply.status, 0, `应用应 exit 0，stderr=${apply.stderr}`);
  const after = JSON.parse(readFileSync(file, "utf8"));
  const model = after.provider.r4.models["deepseek-v4.1-flash-expires-on-0910"];
  // null = 官网未文档化，绝不臆造数值：原值保留、不写官网值
  assert.equal(model.limit.context, 123456, "官网 null 的 context 不得被臆造回写");
  assert.equal(model.limit.output, 65536, "官网 null 的 output 不得被臆造回写");
  assert.equal(model.temperature, true, "官网 null 的 temperature 不得被臆造回写");
});
