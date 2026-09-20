// cost.tiers 三种边界写法测试 —— max_input / min_input_tokens / condition 三选一（恰有其一）
// validate-catalog.mjs 无可导入的导出函数，按任务约定用子进程跑
// `node tools/validate-catalog.mjs <临时 bundle 文件>`，夹具放临时目录、测试后清理。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VALIDATE = path.join(ROOT, "tools", "validate-catalog.mjs");

// 最小合法条目骨架（满足 validate 的 REQUIRED_TOP schema）
function baseEntry(id) {
  return {
    id,
    vendor: "probe",
    family: "Probe",
    api_protocol: "chat_completions",
    verified: true,
    lifecycle: "current",
    lifecycle_note: null,
    context_window: 1000,
    max_output_tokens: 100,
    reasoning: {
      supported: false,
      effort_values: [],
      default_effort: null,
      summary_values: null,
      can_disable: null,
      thinking_budget: null,
    },
    sampling: {
      temperature: { supported: null, range: null, constraint: null },
      top_p: { supported: null, range: null, constraint: null },
      top_k: { supported: null, range: null, constraint: null },
    },
    tools: { function_calling: null, parallel: null, strict: null, choice_modes: null },
    structured_output: { supported: null, mechanism: null },
    vision: null,
    pdf: null,
    caching: { mode: null, min_tokens: null, ttl_options: null },
    aliases: [],
    legacy_ids: [],
    gotchas: [],
    sources: [],
    confidence: "high",
  };
}

function entryWithTiers(id, tiers) {
  return {
    ...baseEntry(id),
    cost: {
      currency: "USD",
      unit: "per_1m_tokens",
      input: 1,
      output: 2,
      cache_read: null,
      cache_write: null,
      context_over_200k: null,
      tiers,
      as_of: "2026-09-20",
      sources: null,
      confidence: "high",
    },
  };
}

function writeBundle(dir, models) {
  const file = path.join(dir, `tiers-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  writeFileSync(file, JSON.stringify({ version: 2, updated_at: "2026-09-20", models }, null, 2), "utf8");
  return file;
}

function runValidate(bundleFile) {
  return spawnSync(process.execPath, [VALIDATE, bundleFile], { encoding: "utf8", cwd: ROOT });
}

// 三种边界写法各占一个条目，全部被接受（exit 0、0 error）
test("tiers 三种边界写法均被 validate 接受", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-tiers-ok-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = writeBundle(dir, [
    entryWithTiers("probe/t1", [{ max_input: 128000, input: 1, output: 2 }]),
    entryWithTiers("probe/t2", [{ min_input_tokens: 128001, input: 2, output: 4 }]),
    entryWithTiers("probe/t3", [{ condition: "输入超过 200k tokens", input: 3, output: 6 }]),
  ]);
  const r = runValidate(bundle);
  assert.equal(r.status, 0, `三种写法都应通过，stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.ok(r.stdout.includes("0 个 error"), `应报 0 error，实际：${r.stdout}`);
});

test("tiers：同一档位出现多种边界 → 报错", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-tiers-multi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = writeBundle(dir, [
    entryWithTiers("probe/bad-multi", [
      { max_input: 1000, min_input_tokens: 1000, input: 1, output: 2 },
    ]),
  ]);
  const r = runValidate(bundle);
  assert.equal(r.status, 1, "多种边界并存应 exit 1");
  assert.ok(r.stdout.includes("档位边界只能给一个"), `应报“只能给一个”，实际：${r.stdout}`);
});

test("tiers：边界全缺 → 报错", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-tiers-none-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = writeBundle(dir, [
    entryWithTiers("probe/bad-none", [{ input: 1, output: 2 }]),
  ]);
  const r = runValidate(bundle);
  assert.equal(r.status, 1, "边界全缺应 exit 1");
  assert.ok(r.stdout.includes("缺少档位边界"), `应报“缺少档位边界”，实际：${r.stdout}`);
});

test("tiers：混合合法 + 非法条目时只对非法条目报错", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-tiers-mix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = writeBundle(dir, [
    entryWithTiers("probe/good", [{ max_input: 128000, input: 1, output: 2 }]),
    entryWithTiers("probe/bad", [{ condition: "", input: 1, output: 2 }]),
  ]);
  const r = runValidate(bundle);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("probe/bad"), "报错应定位到非法条目");
  assert.ok(!r.stdout.includes("probe/good"), "合法条目不应被报错");
});

test("tiers：tiers 为 null 合法（无阶梯定价）", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifix-tiers-null-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = writeBundle(dir, [entryWithTiers("probe/no-tier", null)]);
  const r = runValidate(bundle);
  assert.equal(r.status, 0, `tiers=null 应通过，stdout=${r.stdout}`);
});
