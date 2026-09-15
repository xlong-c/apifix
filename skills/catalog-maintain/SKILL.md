---
name: catalog-maintain
description: 维护 apifix 的模型目录：新增或更新模型规格与定价、编写 incoming 调研批次、运行合并与校验脚本、排查 catalog 校验错误。当需要往 catalog.json 添加模型、更新过时的官方规格、补充定价数据、或修复 CI 校验失败时使用。
---

# catalog-maintain

维护 `catalog.json`（唯一数据源）。流程：**调研 → 写 incoming 批次 → merge → validate → PR**。

**铁律**：只采信厂商官方文档（模型页 / API 文档 / 定价页），聚合站、中转后台、论坛不作来源；
未文档化就写 `null`，绝不臆造数值，不确定就降 `confidence`；每条必须带 `sources`
（http/https），否则 validate 报 error；`incoming/` 是宽松批次，**手工修正直接写 `catalog.json`**
（合并时手工条目优先）；价格会过时，**最新研究优先**。

## 1）写模型批次（`incoming/<batch>.json`）

```json
{
  "batch": "example-batch", "researched_at": "2026-09-15", "source": "official docs",
  "models": [{
    "id": "example-model-1", "vendor": "example", "family": "Example",
    "api_protocol": "chat_completions", "verified": true,
    "lifecycle": "current", "lifecycle_note": "2026-09-01 发布",
    "context_window": 200000, "max_output_tokens": 64000,
    "reasoning": {"supported": true, "effort_values": ["low", "high"], "default_effort": "high",
                  "summary_values": null, "can_disable": true, "thinking_budget": null},
    "sampling": {
      "temperature": {"supported": true, "range": "[0,2]", "constraint": null},
      "top_p": {"supported": true, "range": null, "constraint": "默认 0.95"},
      "top_k": {"supported": false, "range": null, "constraint": "忽略"}
    },
    "tools": {"function_calling": true, "parallel": null, "strict": true, "choice_modes": ["auto", "none"]},
    "structured_output": {"supported": true, "mechanism": "response_format.type=json_object"},
    "vision": true, "pdf": false,
    "caching": {"mode": "automatic", "min_tokens": null, "ttl_options": null},
    "aliases": [], "legacy_ids": [{"id": "example-v1", "note": "中转沿用的旧名"}],
    "gotchas": ["中转常用旧名 example-v1，请核对官方 id"],
    "sources": ["https://example.com/docs/models/example-model-1"], "confidence": "high"
  }]
}
```

`range` 可写字符串 `"[0,2]"` / `"(0,1]"`，merge 会转成数组并在开区间时加 `range_note`。

## 2）写定价批次（独立文件 `incoming/pricing-<group>.json`）

不是模型批次，merge 按 `id` 精确匹配 catalog。`unit` 固定 `per_1m_tokens`，币种一律 USD
（官方只有 CNY 时写 `"currency": "CNY"`，merge 按固定参考汇率换算并保留原值）：

```json
{
  "batch": "pricing-example", "researched_at": "2026-09-15", "unit": "per_1m_tokens",
  "models": [{
    "id": "example-model-1", "currency": "USD",
    "input": 3.0, "output": 12.0, "cache_read": 0.3, "cache_write": null,
    "context_over_200k": {"input": 6.0, "output": 24.0},
    "tiers": [
      {"max_input": 32000, "input": 2.0, "output": 8.0},
      {"min_input_tokens": 128000, "input": 4.0, "output": 16.0, "cache_read": 0.4},
      {"condition": "输入长度 (32k,128k]", "input": 3.0, "output": 12.0}
    ],
    "as_of": "2026-09-15", "sources": ["https://example.com/pricing"], "confidence": "high"
  }]
}
```

**`tiers` 边界三种写法，三选一**（给多个或一个都不给都报 error）：`max_input` 数值（上限
口径「不超过」）/ `min_input_tokens` 数值（下限口径「从…起」）/ `condition` 非空字符串
（人类可读区间，官方只给文字档位时用）。每档必须有数值 `input` / `output`，`cache_read` /
`cache_write` 可选。

## 3）合并与校验

```bash
node tools/merge-catalog.mjs --dry-run   # 先看报告（去重、range 转换、cost 写入）
node tools/merge-catalog.mjs             # 写回 catalog.json
node tools/validate-catalog.mjs          # 必须 0 error（CI 也跑这个）
node apifix.mjs <你的 id>                # 冒烟
git diff catalog.json                    # 只应出现预期条目
```

同 id 冲突的去重优先级：手工目录条目优先；批次 `verified: true` 可覆盖未核验的目录条目；
批次之间取信息量更大者；云镜像重复保留原生 vendor。

## 常见校验错误与修法

| 报错 | 修法 |
| --- | --- |
| `缺少必需键 'confidence'` | 补字段；跑一次 merge 通常会自动补 `null` |
| `id 重复（大小写不敏感）` | 删重复条目，或改成 `aliases` / `legacy_ids` |
| `range 必须是长度 2 的数值数组或 null` | 跑 merge 自动转换，或改成 `[0, 2]` |
| `cost.currency 必须是 USD` | 写 USD；只有 CNY 时在 pricing 文件写 `"currency": "CNY"` |
| `档位边界只能给一个（三选一）` / `缺少档位边界（…三选一）` | tier 里恰好留一个边界键 |
| `sources: 非 http(s) 链接` | 换成官方文档 URL |
| `lifecycle 非法 'preview'` | 用 `current`/`legacy`/`retired`/`unreleased` |
| `lifecycle=unreleased 但已填 context_window`（warning） | 确认是否真的未发布；不阻塞 CI |

## PR 前检查清单

- [ ] 只改必要文件（`incoming/*.json`、`catalog.json`，必要时 `apifix.mjs` / `lib/core.mjs` / README）
- [ ] 条目只引用官方文档，`sources` 为可访问的 http(s) 链接；未文档化的值写 `null`
- [ ] 定价文件放在 `incoming/pricing-*.json`，`unit` 为 `per_1m_tokens`、币种 USD
- [ ] `for f in apifix.mjs lib/*.mjs tools/*.mjs; do node --check "$f"; done` 通过
- [ ] `node tools/validate-catalog.mjs` 0 error；`node apifix.mjs <id>` 输出符合预期
- [ ] legacy id 有 `legacy_ids` note；PR 描述写清依据的官方页面

## 其他

- 改了 `lib/core.mjs` 的 emit 逻辑，必须同步改 `ui/app.js` 内置 fallback（两者逐字节一致）。
- 详细规则见 `CONTRIBUTING.md`；架构与不变量见 `AGENTS.md`。
