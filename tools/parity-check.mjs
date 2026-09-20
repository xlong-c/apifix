#!/usr/bin/env node
// parity-check.mjs — core ↔ UI fallback 逐字节对拍（零依赖 / ESM，CI 可用）
//
// AGENTS.md 不变量 2 的自动化保障：lib/core.mjs 是唯一正典，ui/fallback.mjs
// （UI 降级实现）必须与它逐字节一致。本工具读取 catalog.json，对每条模型 ×
// emitter(opencode|pi|codex|claude-env) × 模式(精简|-f) 共 8 种组合，断言两侧 emit
// 输出零差异；另做 match 弱断言：非 fuzzy 命中时两侧 kind 与命中 id 必须一致
// （fuzzy 候选允许不同，只计数不报错）。
//
// 用法：
//   node tools/parity-check.mjs
//
// 退出码：0 全部一致；1 存在差异（打印首个差异）；2 读取/解析/导入失败。

import { readFileSync } from "node:fs";

// catalog.json（生成物）与两侧模块。零 npm 依赖；动态 import 保证失败时可诊断。
const CATALOG_PATH = new URL("../catalog.json", import.meta.url);
const CORE_PATH = "../lib/core.mjs";
const FALLBACK_PATH = "../ui/fallback.mjs";

const EMITTERS = ["opencode", "pi", "codex", "claude-env"];
const MODES = ["精简", "-f"];

function fail(message, code) {
  process.stderr.write(`[!] ${message}\n`);
  process.exit(code);
}

// core.emitPi 的 note 回调：对拍时把 note 吞掉（note 走 stderr 通道，不属于输出字节契约）。
const onNote = () => {};

// 逐字节比较；返回首个差异的下标（用于定位），一致返回 -1。
function firstByteIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

// match 弱断言：非 fuzzy 命中时两侧 kind 与命中 id 必须一致；fuzzy 只计数。
function checkMatch(catalog, core, fallback) {
  const models = catalog.models;
  const inputs = [];
  for (const entry of models) {
    inputs.push(entry.id);
    // 中转常见写法 vendor/<id>：归一化阶段必须两侧一致（厂商前缀表漂移的护栏）
    if (typeof entry.vendor === "string" && entry.vendor) inputs.push(`${entry.vendor}/${entry.id}`);
    for (const alias of entry.aliases || []) inputs.push(alias);
    for (const legacy of entry.legacy_ids || []) {
      if (legacy && legacy.id) inputs.push(legacy.id);
    }
  }

  let checked = 0;
  let fuzzySkipped = 0;
  for (const input of inputs) {
    const a = core.matchModel(catalog, input);
    const b = fallback.matchFallback(models, input);
    if ((a && a.kind === "fuzzy") || (b && b.kind === "fuzzy")) {
      // fuzzy 仅是建议且 difflib/levenshtein 实现不同，候选允许不同：只计数。
      fuzzySkipped += 1;
      continue;
    }
    checked += 1;
    if ((a && a.kind) !== (b && b.kind) || (a && a.matchedId) !== (b && b.matchedId)) {
      return { input, checked, fuzzySkipped, diff: { core: a, fallback: b } };
    }
  }
  return { input: null, checked, fuzzySkipped, diff: null };
}

async function main() {
  // 读取 catalog.json（生成物；与 CLI/UI 同源）
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  } catch (err) {
    return fail(`无法读取/解析 ${CATALOG_PATH}: ${err.message}`, 2);
  }
  if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) {
    return fail("catalog.json 结构非法：缺少非空 models 数组", 2);
  }

  const [core, fallback] = await Promise.all([import(CORE_PATH), import(FALLBACK_PATH)]);

  const models = catalog.models;
  const totalGroups = models.length * EMITTERS.length * MODES.length;
  let groups = 0;

  for (const entry of models) {
    for (const emitter of EMITTERS) {
      for (const full of [false, true]) {
        groups += 1;
        // key 沿用规范 id、name 与 key 一致（与 CLI 默认路径相同的形态）
        const coreOut = emitter === "opencode"
          ? core.emitOpencode(entry, { name: entry.id, keyId: entry.id, full, onNote })
          : emitter === "pi"
            ? core.emitPi(entry, { name: entry.id, id: entry.id, full, onNote })
            : core.emitExtra(entry, emitter, { name: entry.id, keyId: entry.id, full, onNote });
        const fallbackOut = emitter === "opencode"
          ? fallback.emitOpencodeFallback(entry, entry.id, entry.id, full)
          : emitter === "pi"
            ? fallback.emitPiFallback(entry, entry.id, entry.id, full)
            : fallback.emitExtraFallback(entry, emitter, entry.id, entry.id, full);

        if (coreOut !== fallbackOut) {
          const idx = firstByteIndex(coreOut, fallbackOut);
          process.stderr.write(
            `[!] 首个差异（第 ${groups}/${totalGroups} 组）:\n` +
            `    模型 id : ${entry.id}\n` +
            `    emitter : ${emitter}\n` +
            `    模式    : ${modeLabel(full)}\n` +
            `    首个差异字节位置: ${idx}\n` +
            `--- core 输出 ---\n${coreOut}\n` +
            `--- fallback 输出 ---\n${fallbackOut}\n`,
          );
          return fail("core 与 fallback 输出不一致，exit 1", 1);
        }
      }
    }
  }

  const match = checkMatch(catalog, core, fallback);
  if (match.diff) {
    process.stderr.write(
      `[!] match 弱断言失败:\n` +
      `    输入   : ${match.input}\n` +
      `    core   : kind=${match.diff.core && match.diff.core.kind} ` +
      `matchedId=${JSON.stringify(match.diff.core && match.diff.core.matchedId)}\n` +
      `    fallback: kind=${match.diff.fallback && match.diff.fallback.kind} ` +
      `matchedId=${JSON.stringify(match.diff.fallback && match.diff.fallback.matchedId)}\n`,
    );
    return fail("core 与 fallback 匹配结论不一致，exit 1", 1);
  }

  // 汇总（stdout 打印，便于 CI 展示）
  console.log(
    `对拍通过：${models.length} 条模型 × 4 emitter × 2 模式 = ${groups} 组 emit 输出零差异；` +
    `match 弱断言 ${match.checked} 组一致（fuzzy 跳过 ${match.fuzzySkipped} 组，仅计数）`,
  );
  return 0;
}

function modeLabel(full) {
  return full ? "-f（完整）" : "精简";
}

process.exitCode = await (async () => {
  try {
    return await main();
  } catch (err) {
    process.stderr.write(`[!] parity-check 意外失败: ${err && err.stack ? err.stack : err}\n`);
    return 2;
  }
})();
