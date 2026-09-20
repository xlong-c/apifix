// emit 字节契约快照 —— 不变量 3：不带 -f 的最小输出是稳定契约，逐字节比对
// 快照值取自 catalog.json 现条目实际输出（lifecycle=current、字段齐全的模型）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { emitOpencode, emitPi } from "../lib/core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(readFileSync(path.join(ROOT, "catalog.json"), "utf8"));

function entry(id) {
  const found = catalog.models.find((m) => m.id === id);
  assert.ok(found, `catalog.json 中应存在 ${id}`);
  return found;
}

// 快照 1：deepseek-v4-pro（opencode + pi，精简模式）
test("字节契约：deepseek-v4-pro opencode 精简输出", () => {
  assert.equal(
    emitOpencode(entry("deepseek-v4-pro")),
    `{
  "deepseek-v4-pro": {
    "attachment": false,
    "limit": {
      "context": 1048576,
      "output": 393216
    },
    "name": "deepseek-v4-pro",
    "reasoning": true,
    "temperature": true,
    "tool_call": true,
    "variants": {
      "high": {
        "reasoningEffort": "high"
      },
      "low": {
        "reasoningEffort": "low"
      },
      "max": {
        "reasoningEffort": "max"
      },
      "none": {
        "reasoningEffort": "none"
      }
    }
  }
}`,
  );
});

test("字节契约：deepseek-v4-pro pi 精简输出", () => {
  assert.equal(
    emitPi(entry("deepseek-v4-pro")),
    `{
  "id": "deepseek-v4-pro",
  "name": "deepseek-v4-pro",
  "reasoning": true,
  "input": [
    "text"
  ],
  "contextWindow": 1048576,
  "maxTokens": 393216,
  "thinkingLevelMap": {
    "off": "none",
    "minimal": null,
    "low": "low",
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}`,
  );
});

// 快照 2：claude-sonnet-5（opencode + pi，精简模式）
test("字节契约：claude-sonnet-5 opencode 精简输出", () => {
  assert.equal(
    emitOpencode(entry("claude-sonnet-5")),
    `{
  "claude-sonnet-5": {
    "attachment": true,
    "limit": {
      "context": 1000000,
      "output": 131072
    },
    "name": "claude-sonnet-5",
    "reasoning": true,
    "temperature": false,
    "tool_call": true,
    "variants": {
      "high": {
        "reasoningEffort": "high"
      },
      "low": {
        "reasoningEffort": "low"
      },
      "max": {
        "reasoningEffort": "max"
      },
      "medium": {
        "reasoningEffort": "medium"
      },
      "xhigh": {
        "reasoningEffort": "xhigh"
      }
    }
  }
}`,
  );
});

test("字节契约：claude-sonnet-5 pi 精简输出", () => {
  assert.equal(
    emitPi(entry("claude-sonnet-5")),
    `{
  "id": "claude-sonnet-5",
  "name": "claude-sonnet-5",
  "reasoning": true,
  "input": [
    "text",
    "image"
  ],
  "contextWindow": 1000000,
  "maxTokens": 131072,
  "thinkingLevelMap": {
    "off": null,
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max"
  }
}`,
  );
});

// -f 完整模式：只断言结构关键字段存在（cost / status / modalities），不做字节快照
test("-f 完整模式：opencode 含 cost / status / modalities（deepseek-v4-pro）", () => {
  const out = emitOpencode(entry("deepseek-v4-pro"), { full: true });
  const parsed = JSON.parse(out);
  const snippet = parsed["deepseek-v4-pro"];
  assert.ok(snippet, "opencode 片段应以模型 id 为键");
  assert.ok(snippet.cost && typeof snippet.cost === "object", "-f 模式应有 cost 对象");
  assert.ok(typeof snippet.cost.input === "number");
  assert.ok(typeof snippet.cost.output === "number");
  assert.equal(snippet.status, "active", "lifecycle=current 应映射 status=active");
  assert.ok(snippet.modalities && Array.isArray(snippet.modalities.input));
  assert.ok(Array.isArray(snippet.modalities.output));
  // 精简模式不含这些字段（契约差异的回归哨兵）
  const minimal = JSON.parse(emitOpencode(entry("deepseek-v4-pro")));
  assert.ok(!("cost" in minimal["deepseek-v4-pro"]), "精简模式不应含 cost");
  assert.ok(!("status" in minimal["deepseek-v4-pro"]), "精简模式不应含 status");
  assert.ok(!("modalities" in minimal["deepseek-v4-pro"]), "精简模式不应含 modalities");
});

test("-f 完整模式：pi 含 api 字段（claude-sonnet-5）", () => {
  const out = emitPi(entry("claude-sonnet-5"), { full: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "claude-sonnet-5");
  assert.ok(typeof parsed.api === "string" && parsed.api, "-f 模式 pi 片段应有 api 协议字段");
  assert.ok(Array.isArray(parsed.input));
  assert.ok(typeof parsed.contextWindow === "number");
  // 精简模式不含 api
  const minimal = JSON.parse(emitPi(entry("claude-sonnet-5")));
  assert.ok(!("api" in minimal), "pi 精简模式不应含 api");
});
