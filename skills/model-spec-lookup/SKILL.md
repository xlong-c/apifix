---
name: model-spec-lookup
description: 查询 LLM 模型的官方参数规格（上下文窗口、最大输出、推理档位、采样限制、定价、已知陷阱），并生成可直接粘贴的 opencode / pi 配置片段。当用户询问某个模型支持什么参数、在配置中转/relay 模型、怀疑模型被"降智"或参数不生效、或需要把中转模型 ID 对照到官网规范 ID 时使用。
---

# model-spec-lookup

输入一个模型 ID（支持中转/别名写法），输出**官网规格值**与可直接粘贴的配置片段。
零网络请求，数据来自仓库内 `catalog.json`。

**何时使用**：问某模型支持什么参数（上下文 / 最大输出 / 推理档位 / 采样限制）；在中转、
relay 上配置模型需要粘贴片段；怀疑模型被「降智」或参数不生效；把中转 ID
（`gpt-6-astra-free`、`openai/gpt-6-astra`）对照官网规范 ID。

**前置条件**：`git clone` 本仓库 + Node.js >= 18，在仓库根目录跑 `node apifix.mjs`；
全局安装过则用 `apifix <id>`。**离线可用**，不联网、不读本地客户端配置。

## 怎么跑

```bash
node apifix.mjs <id>                 # 默认输出 opencode 片段（最小字段集）
node apifix.mjs <id> --emit pi       # pi 片段
node apifix.mjs <id> --canonical-id  # key 用官网规范 id（修正中转旧名）
node apifix.mjs <id> --card          # 完整规格卡片（含 gotchas / sources）
node apifix.mjs <id> --json          # catalog 原始条目（含 pricing 元数据）
node apifix.mjs <id> -f              # 完整模式：追加 cost / status / modalities
node apifix.mjs --match ids.txt      # 批量逐行匹配
```

退出码：`0` 成功、`1` 未收录（`<id>` 与 `--match`）、`2` 用法/文件错误。

## 怎么读输出

**匹配标签**：`[OK]` 精确命中 / `[A]` 别名 / `[L]` legacy 或退役 id（中转常沿用旧名，值按
**当前**官网规格给）/ `[~]` 归一化（去前缀、`-free`/`-preview` 等后缀、分隔符等价）/
`[?]` 未收录（可能拼错或第三方专有命名，会给出最接近建议）。

**stderr 提示**（不污染 stdout，可 `2>/dev/null` 丢弃）：`[i]` 解析说明，`[!]` 生命周期
警告与可信度提示。生命周期：`current` 在架 / `legacy` 仍可调用 / `retired` 已退役（规格为
退役前）/ `unreleased` 尚未发布；卡片里 `未核验 (unofficial)` 表示未与官网逐项核对。

## 示例

**1）中转写法 → 官网规格**（stderr 提示不影响 stdout 可粘贴性）：

```bash
$ node apifix.mjs gpt-6-astra-free
[i] gpt-6-astra-free -> 官网规范 id gpt-6-astra（值采用官方规格，去除 relay 后缀 -free）
{ "gpt-6-astra-free": { "attachment": true,
    "limit": { "context": 1050000, "output": 128000 }, "name": "gpt-6-astra-free",
    "reasoning": true, "temperature": false, "tool_call": true,
    "variants": { "high": {"reasoningEffort": "high"}, "low": {...}, "max": {...},
                  "medium": {...}, "xhigh": {...} } } }
```

key 仍是输入 id（可直接替换中转配置），数值来自官网条目 `gpt-6-astra`；
加 `--canonical-id` 则 key 变为 `gpt-6-astra`。

**2）批量核对**（`--match` 列已对齐，此处省略多余空格）：

```bash
$ printf 'gpt-6-astra\ngpt_6_astra\nopenai/gpt-6-astra\ngpt-6-astra-free\ngpt-6-astra-preview\n' > ids.txt
$ node apifix.mjs --match ids.txt
[OK] gpt-6-astra            -> gpt-6-astra
[~] gpt_6_astra             -> gpt-6-astra（分隔符等价匹配 (-/./_ 视为相同)）
[~] openai/gpt-6-astra      -> gpt-6-astra（去除厂商前缀 openai/）
[~] gpt-6-astra-free        -> gpt-6-astra（去除 relay 后缀 -free）
[~] gpt-6-astra-preview     -> gpt-6-astra（去除 relay 后缀 -preview）
```

只要有 1 行 `[?]`，退出码即为 `1`（便于脚本判断）。

**3）看踩坑点与定价**（配置前必查）：

```bash
$ node apifix.mjs gpt-6-astra --card   # 卡片尾部给出 gotchas 与 sources
[!] reasoning.effort 'none' 返回 400（不支持 none/minimal）
[!] 工具调用必须用 Responses API；Chat Completions 不支持 tools

$ node apifix.mjs gpt-6-astra -f       # cost 只在 -f 输出，USD / 每 1M tokens
"cost": { "input": 10, "output": 50, "cache_read": 1, "cache_write": 12.5,
          "context_over_200k": { "input": 20, "output": 75 } }
```

## 注意

- 目录是静态快照，官方改规格需更新仓库（见 `catalog-maintain` skill）。
- `null` / `未知/not documented` 表示**官方未文档化**，不要臆造替代值。
