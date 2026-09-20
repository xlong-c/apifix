# 贡献指南

apifix 的模型目录（`catalog.json`）是**人工核验的静态快照**。欢迎补充新模型、修正过期规格。

## 数据原则

1. **只引用官方文档**：厂商官方文档 / 官方模型页 / 官方定价页。博客、聚合站、中转站后台、
   论坛帖子**不能**作为规格来源。云平台（AWS / Azure / Vertex）文档对**非**云厂商的模型
   不能作为来源（例外：`vendor` 为 `amazon` / `microsoft` 时，其自有云文档即第一方文档）。
   完整规则见下方「来源白名单」，`tools/validate-catalog.mjs` 会强制校验。
2. **未文档化就留 null**：不猜、不抄本地配置、不抄中转商页面。`null` 表示「官方未文档化」，
   渲染时会显示 `未知/not documented`。
3. **不确定就降 confidence**：`high`（官方文档明确）/ `medium`（多源交叉推断）/
   `low`（间接来源、待核验）。
4. **每条都要有 `sources`**（http/https 链接），否则 CI 不通过。
5. 不要修改与本次贡献无关的条目。

### 来源白名单

`sources` 只接受**第一方厂商域名**（host 等于后缀或为其子域）。判定规则由
`tools/validate-catalog.mjs` 的 `checkSources` 执行，违规会以
`<id>: sources 含非官方来源 <url>（vendor=<vendor>）` 报 error。

- 云平台文档（`docs.aws.amazon.com`、`learn.microsoft.com`、`ai.azure.com`）**不是**
  另一家厂商模型的官方来源；仅当条目 `vendor` 本身就是 `amazon` / `microsoft` 时才接受。
- 第三方聚合站 / 中转站 / 博客 / 新闻站（如 therouter.ai、atlascloud.ai、ithome.com 等）
  **永远不接受**。
- `github.com` 仅当路径以 `/QwenLM/` 开头且 `vendor=alibaba` 时算官方。
- `sources: []` 是合法的（条目可能尚未找到官方来源）；此时应置 `verified: false`、
  `confidence: "low"`，并在 `gotchas` 首位注明「非官方来源，规格待核验」。

| vendor | 官方域名后缀 |
| --- | --- |
| openai | openai.com |
| anthropic | claude.com、anthropic.com |
| google | google.dev、google.com、googleapis.com |
| deepseek | deepseek.com |
| alibaba | aliyun.com、alibabacloud.com、aliyuncs.com、qwencloud.com、qianwenai.com |
| zhipu | z.ai、bigmodel.cn |
| moonshot | kimi.ai、kimi.com、moonshot.cn、moonshot.ai |
| baidu | baidu.com |
| xai | x.ai |
| meta | meta.ai、meta.com |
| mistral | mistral.ai |
| cohere | cohere.com |
| tencent | tencent.com、tencent.cn、tencentcloud.com |
| volcengine | volcengine.com、bytedance.com |
| nvidia | nvidia.com |
| microsoft | microsoft.com、azure.com |
| amazon | aws.amazon.com、amazon.com |
| minimax | minimax.io、minimaxi.com、minimax.cn |
| iflytek | xfyun.cn、xf-yun.com |
| 01ai | lingyiwanwu.com |
| ai21 | ai21.com |
| writer | writer.com |

## 如何新增一个模型

> **编辑 `catalog/<vendor>.json`，然后运行 `npm run build`。**
> `catalog/` 是唯一数据源（一厂商一文件，手工编辑这里）；`catalog.json` 是**生成物**，
> **不要手工编辑**。CI 会运行 `node tools/build-catalog.mjs --check`，
> 改了 `catalog/` 却忘记 rebuild 的 PR 会直接失败。

1. 在 `incoming/` 下新建批次文件（或追加到已有批次），结构：

   ```json
   {"batch": "your-batch", "researched_at": "2026-09-15",
    "source": "official docs", "models": [ { ...条目... } ]}
   ```

2. 条目 schema（字段缺失会被 merge 脚本补 `null`/`[]`，但请尽量写全）：

   | 字段 | 说明 |
   | --- | --- |
   | `id` | 官方规范 id（必填，唯一） |
   | `vendor` / `family` / `api_protocol` | 厂商 / 家族 / 协议（`chat_completions`、`responses`、`anthropic_messages`、`gemini`、`native`） |
   | `verified` | 是否已与官方文档核验（bool） |
   | `lifecycle` | `current` / `legacy` / `retired` / `unreleased`，配 `lifecycle_note` |
   | `context_window` / `max_output_tokens` | 整数或 null |
   | `reasoning` | `{supported, effort_values, default_effort, summary_values, can_disable, thinking_budget}` |
   | `sampling` | `{temperature, top_p, top_k}`，各含 `{supported, range, constraint}`；`range` 用 JSON 数组 `[0, 2]` |
   | `tools` | `{function_calling, parallel, strict, choice_modes}` |
   | `structured_output` | `{supported, mechanism}` |
   | `vision` / `pdf` | bool 或 null |
   | `caching` | `{mode, min_tokens, ttl_options}` |
   | `aliases` / `legacy_ids` | `aliases` 为字符串数组；`legacy_ids` 为 `[{"id": "...", "note": "..."}]`（含退役/中转沿用 id 的说明） |
    | `gotchas` / `sources` / `confidence` | 踩坑点 / 官方链接 / `high|medium|low` |
    | `cost` | 官方定价（见下节）；merge 脚本会自动维护，手工编辑请保持结构一致 |

3. 运行合并脚本（会把批次与现有目录按 id 去重、规范化后写回 `catalog/<vendor>.json`，
   再自动打包 `catalog.json`）：

   ```bash
   node tools/merge-catalog.mjs --dry-run   # 先看报告
   node tools/merge-catalog.mjs             # 写 catalog/ + catalog.json
   ```

   同一 id 冲突时：手工目录条目优先；批次条目 `verified: true` 可覆盖未核验的目录条目；
   批次之间取信息量更大者；云镜像重复（同一模型出现在多个 vendor 批次）保留原生 vendor。
   合并阶段会再次执行来源白名单过滤：批次里的第三方/云平台链接一律丢弃；
   若某条目过滤后只剩非官方来源，会自动降级为 `verified: false` + `confidence: low`
   并在 `gotchas` 首位注明。

4. 直接编辑 `catalog/<vendor>.json`（推荐）或改完批次后跑 merge，然后重建 + 自检：

   ```bash
   npm run build                            # catalog/ → catalog.json（生成物）
   node tools/build-catalog.mjs --check     # 确认 catalog.json 与 catalog/ 一致
   node tools/validate-catalog.mjs          # 结构 + 来源白名单 + bundle 一致性
   node apifix.mjs --list | head
   node apifix.mjs <你的模型 id>
   ```

   厂商文件格式：`{"vendor": "<vendor>", "updated_at": "YYYY-MM-DD", "models": [ ... ]}`；
   条目 `vendor` 必须与文件名/文件 `vendor` 一致，`id` 在所有厂商文件间全局唯一。

## 如何补充定价（cost）

定价是**独立的来源文件**：`incoming/pricing-<group>.json`（例如 `pricing-openai-anthropic.json`，
5 个文件各管一组 vendor）。它们**不是**模型批次，merge 脚本会单独处理、按 `id` 精确匹配 catalog 条目。

```json
{
  "batch": "pricing-openai-anthropic",
  "researched_at": "2026-09-15",
  "unit": "per_1m_tokens",
  "models": [
    {
      "id": "gpt-5.6-sol",
      "currency": "USD",
      "input": 4.0,
      "output": 20.0,
      "cache_read": 0.4,
      "cache_write": null,
      "context_over_200k": {"input": 8.0, "output": 30.0, "cache_read": 0.8, "cache_write": null},
      "tiers": [{"max_input": 32000, "input": 2.0, "output": 8.0}],
      "note": "可选说明",
      "as_of": "2026-09-15",
      "sources": ["https://..."],
      "confidence": "high"
    }
  ]
}
```

档位（`tiers`）的边界有三种等价写法，**三选一**（给多个或一个都不给都会被 validate 判为 error），
merge 会原样保留你写的那一侧：

- `max_input`：该档适用于**不超过**这么多 input tokens（数值，上限口径），如 `{"max_input": 32000, ...}`；
- `min_input_tokens`：该档适用于**从**这么多 input tokens 起（数值，下限口径），
  如 `{"min_input_tokens": 512000, "input": 0.6, "output": 2.4, "cache_read": 0.12}`；
- `condition`：人类可读的区间描述（非空字符串，适合官方只给文字档位时），
  如 `{"condition": "输入长度(32,128]", "input": 0.6667, "output": 3.3333}`。

每个档位对象都必须有数值 `input` / `output`；`cache_read` / `cache_write` 可选（数值）。
`tiers` 属于 catalog 元数据，**不会**出现在 `apifix.mjs -f` 的 opencode 片段里。

其余规则：

- **单位固定为 `per_1m_tokens`，币种请一律写 USD**（官方定价页多为美元）。价格是**每 1M tokens
  的美元数**，不是每 1K。
- 若确实只能拿到非 USD 原始价（目前仅支持 CNY），merge 会按固定兜底汇率 **1 USD = 7.2 CNY**
  换算并在 `cost.note` 里保留原币种数值；该汇率是参考值、非实时行情，仅作最后手段。
- `cache_write` / `context_over_200k` / `tiers` / `note` 可省略或写 `null`。
- **价格会过时，最新研究优先**：新的 pricing 文件会覆盖 `catalog.json` 里已有的 `cost`；
  多个文件提到同一 id 时，`confidence` 高者优先，同分取文件名字典序靠后者。
- 没有被任何 pricing 文件提到的条目，`cost` 为 `null`（这是合法状态，不是错误）。
- 合并后 catalog 里的 `cost` 结构（由脚本生成，手工改动需保持一致）：

```json
"cost": {
  "currency": "USD", "unit": "per_1m_tokens",
  "input": 4.0, "output": 20.0, "cache_read": 0.4, "cache_write": null,
  "context_over_200k": {"input": 8.0, "output": 30.0, "cache_read": 0.8, "cache_write": null},
  "tiers": [{"max_input": 32000, "input": 2.0, "output": 8.0}],
  "note": null, "as_of": "2026-09-15", "sources": ["https://..."], "confidence": "high"
}
```

`node apifix.mjs <id> -f` 会把 `cost` 输出为 opencode 的 cost 片段（仅 `input`/`output`/
`cache_read`/`cache_write`/`context_over_200k`，空值键省略；`input`/`output` 缺一即整体不输出）。

## PR 检查清单

- [ ] 只改必要文件（`incoming/*.json`、`catalog/<vendor>.json`，必要时 `apifix.mjs` / `lib/core.mjs` / README）
- [ ] 改过 `catalog/` 后已运行 `npm run build`（`catalog.json` 是生成物，不要手工编辑）
- [ ] 条目只引用官方文档，`sources` 为可访问的 http(s) 链接且通过来源白名单
- [ ] 未文档化的值写 `null`，没有臆造数值
- [ ] 定价文件放在 `incoming/pricing-*.json`，`unit` 为 `per_1m_tokens`、币种为 USD（或注明 CNY 原价）
- [ ] `node --check apifix.mjs && node --check lib/core.mjs && node --check tools/*.mjs` 通过
- [ ] `node tools/build-catalog.mjs --check` 通过（bundle 与 catalog/ 一致）
- [ ] `node tools/validate-catalog.mjs` 0 error
- [ ] `node apifix.mjs <id>` 输出符合预期，legacy id 有 `legacy_ids` note
- [ ] 条目数 / vendor / verified / 定价数有变化时，已同步 README 与 README.en 的统计数字（模型数 badge、支持范围、verified 比例）
- [ ] PR 描述里写清依据的官方页面
