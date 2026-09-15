---
name: model-spec-lookup
description: 查询 LLM 模型的官方参数规格（上下文窗口、最大输出、推理档位、采样限制、定价、已知陷阱），并生成可直接粘贴的 opencode / pi 配置片段。当用户询问某个模型支持什么参数、在配置中转/relay 模型、怀疑模型被"降智"或参数不生效、或需要把中转模型 ID 对照到官网规范 ID 时使用。
---

# model-spec-lookup

输入一个模型 ID（支持中转/别名写法），输出**官网规格值**与可直接粘贴的配置片段。
零网络请求，数据来自仓库内 `catalog.json`。

**何时使用**：问某模型支持什么参数（上下文 / 最大输出 / 推理档位 / 采样限制）；在中转、
relay 上配置模型需要粘贴片段；怀疑模型被「降智」或参数不生效；把中转 ID
（`deepseek-v4.1-flash`、`openai/gpt-5.6-sol-preview-free`）对照官网规范 ID。

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

**1）中转旧名 → 官网规格**（stderr 提示不影响 stdout 可粘贴性）：

```bash
$ node apifix.mjs deepseek-v4.1-flash
[i] deepseek-v4.1-flash 是旧版/退役 id，对应 deepseek-flash；中转仍在沿用，值按官网当前规格输出
{ "deepseek-v4.1-flash": { "attachment": true,
    "limit": { "context": 1048576, "output": 393216 }, "name": "deepseek-v4.1-flash",
    "reasoning": true, "temperature": true, "tool_call": true,
    "variants": { "high": {"reasoningEffort": "high"}, "low": {...}, "max": {...}, "none": {...} } } }
```

key 仍是输入 id（可直接替换中转配置），数值来自官网条目 `deepseek-flash`；
加 `--canonical-id` 则 key 变为 `deepseek-flash`。

**2）批量核对**（`--match` 列已对齐，此处省略多余空格）：

```bash
$ printf 'deepseek-v4.1-flash\nglm-5-3-flash\nkimi-k2.5\nopenai/gpt-5.6-sol-preview-free\n' > ids.txt
$ node apifix.mjs --match ids.txt
[L] deepseek-v4.1-flash    -> deepseek-flash（旧版/退役 id）
[~] glm-5-3-flash          -> glm-5.3-flash（分隔符等价匹配 (-/./_ 视为相同)）
[OK] kimi-k2.5             -> kimi-k2.5
     [!] kimi-k2.5 官方已退役；第三方可能仍提供
[~] openai/gpt-5.6-sol-preview-free -> gpt-5.6-sol（去除厂商前缀 openai/；去除 relay 后缀 -free；去除 relay 后缀 -preview）
```

只要有 1 行 `[?]`，退出码即为 `1`（便于脚本判断）。

**3）看踩坑点与定价**（配置前必查）：

```bash
$ node apifix.mjs kimi-k2.5 --card     # 卡片尾部给出 gotchas 与 sources
[!] 已退役：2026-08-31 起官方 API 返回 404，官方迁移到 kimi-k3
[!] thinking 是 K2.x 专属 extra_body 参数 {type:enabled|disabled}，无 reasoning_effort

$ node apifix.mjs gpt-5.6-sol -f       # cost 只在 -f 输出，USD / 每 1M tokens
"cost": { "input": 4, "output": 20, "cache_read": 0.4, "cache_write": 5,
          "context_over_200k": { "input": 8, "output": 30 } }
```

## 注意

- 目录是静态快照，官方改规格需更新仓库（见 `catalog-maintain` skill）。
- `null` / `未知/not documented` 表示**官方未文档化**，不要臆造替代值。
