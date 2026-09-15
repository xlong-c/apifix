# apifix v0.1.0

> 输入模型 ID，得到官网规格与可粘贴的 opencode / pi 配置片段。
> 首个版本：325 个模型 / 22 家厂商，零依赖 Node，含本地 Web UI。

## 为什么做这个

中转（relay）暴露给你的模型 ID 只是一个字符串。它背后支持什么参数、上下文多大、
推理档位有哪些——**这些信息不在中转的后台里，只在厂商的官方文档里**。
换模型时逐个翻 22 家厂商的文档不现实，于是配置里的数值常年不准：

- 中转沿用**旧官方 ID**（厂商改名/退役后中转不改名），你按新名字查不到规格
- 复制来的配置数值**已经过时**（厂商悄悄调整过上下文或输出上限）
- 某些参数**静默失效**（思考模式下 temperature 不生效、`medium` 档被折算成 `high`）
- 中转做协议翻译时**丢参数**，而你不报错、只是感觉"变笨了"

apifix 用厂商官方文档建立一份可查、可校验的规格目录，把上面这些变成可观测的事实。

## 快速开始

```bash
git clone <repo> && cd apifix
node apifix.mjs deepseek-v4.1-flash        # 默认输出 opencode 片段
node apifix.mjs deepseek-v4.1-flash --emit pi
node apifix.mjs --ui                        # 启动本地 Web UI
```

无需 `npm install`——零依赖，Node >= 18。

## 本版功能

### 目录（`catalog.json`）

**325 个模型 · 22 家厂商**，全部规格来自厂商官方文档（模型页 / API 文档 / 定价页），
聚合站与中转后台不作为来源。

| 厂商 | 数量 | 厂商 | 数量 | 厂商 | 数量 |
| --- | ---: | --- | ---: | --- | ---: |
| openai | 63 | anthropic | 24 | alibaba | 42 |
| zhipu | 21 | moonshot | 20 | baidu | 17 |
| google | 17 | xai | 16 | cohere | 15 |
| mistral | 12 | tencent | 11 | volcengine | 11 |
| deepseek | 10 | nvidia | 8 | amazon / iflytek / meta / microsoft | 各 7 |
| minimax | 5 | 01ai | 3 | ai21 / writer | 各 1 |

生命周期标注：`current` 148 · `legacy` 92 · `retired` 82 · `unreleased` 2。
退役模型的规格为**退役前规格**并明确标注。

### 定价

**229 个模型含官方定价**（美元 / 每 100 万 tokens），含输入、输出、缓存读/写、
长上下文档（如 OpenAI >272K 输入按 2x/1.5x 计费、xAI ≥200k 整单加价）
与阶梯价（如 MiniMax M3 的 512K 分档）。非美元厂商按固定参考汇率换算，
原始币种数值保留在 `cost.note`。

### 六个命令

| 命令 | 用途 |
| --- | --- |
| `apifix <id>` | 查规格 + 生成配置片段（`-f` 完整模式含价格） |
| `apifix --match <file>` | 批量解析中转 ID（`[OK]`/`[A]`/`[L]`/`[~]`/`[?]`） |
| `apifix audit <file>` | **体检本地配置**，逐项对照官网规格列出差异 |
| `apifix search [...]` | 按能力 / 上下文 / 价格筛选模型 |
| `apifix compare <id...>` | 多模型并排对比，支持用量成本估算 |
| `apifix protocols` | **跨工具协议总览**（Messages / Responses 差异） |

### Web UI

三栏界面：厂商与生命周期筛选 · 结果列表（含匹配结果卡片）· 详情面板
（规格表 + 注意事项 + 可复制的 opencode/pi 片段，支持精简/完整切换）。
另有批量解析视图，等同于图形版 `--match`。

UI 是**纯静态**的（`ui/` + `lib/core.mjs` + `catalog.json`），
可直接托管到 GitHub Pages 在线使用。

### 安全

- **零网络请求**：所有数据来自本地 `catalog.json`，不读取、不上传你的配置
- **audit / protocols 强制凭证脱敏**：`key`/`token`/`secret` 一律替换为
  `[REDACTED]`，解析失败也不回显文件原文
- `AGENTS.md` 载明凭证安全规则：禁止用 `cat` 等命令直接输出可能含 key 的配置文件，
  改用结构化方式（`jq` 或本项目工具）间接读写

## 一个真实例子

你的中转配置 vs 官网规格（`deepseek-v4.1-flash`）：

| 字段 | 你的配置 | 官网规格 | 差异 |
| --- | ---: | ---: | --- |
| 上下文 | 1,000,000 | 1,048,576 | 偏小 4.6% |
| 最大输出 | 384,000 | 393,216 | 偏小 2.3% |
| 推理档位 | `low,high,max` | `none,low,high,max` | 缺 `none`（关闭思考） |

三处都是静默错误——中转不会告诉你，模型也不会报错。

## 数据可信度

- `null` = **官方未文档化**（不是"等于 0"），渲染为 `未知/not documented`
- `verified` 标记是否已与官方文档逐项核验（当前 315/325）
- `confidence`（high/medium/low）+ `sources`（官方 URL）随每条记录提供
- 三种阶梯价格式、N 路协议值（如 `chat_completions|responses|anthropic_messages`）
  均有 schema 校验（CI 每次 push/PR 运行）

## 项目结构

```
apifix/
├── apifix.mjs        CLI + 本地 UI 服务器（零依赖）
├── lib/core.mjs      共享核心（纯 ESM，浏览器可直接 import）
├── ui/               Web UI（纯静态）
├── catalog.json      325 个模型的官方规格
├── tools/            合并 + 校验脚本（CI 用）
├── incoming/         原始调研批次（数据可溯源）
├── docs/             UI 截图
├── skills/           配套 AI 技能
└── legacy-python/    初版 Python 实现（仅参考）
```

## 已知限制

- 目录是**静态快照**，上游改规格需手动更新（`npm run merge`）
- 模糊匹配只给建议（相似度 ≥ 0.75），未收录时返回退出码 1
- 部分条目官方仅给出间接信息，标记为 `confidence: low` / `verified: false`
- `ark-code-latest` 等路由别名的真实规格随控制台选择变化
- codex 配置解析为窄范围行扫描（不引入 TOML 依赖），仅覆盖 `wire_api`/`base_url`/`model`

## 参与贡献

新增模型、补充定价、修正规格请参考 [CONTRIBUTING.md](CONTRIBUTING.md)。
只采信厂商官方文档；`null` 优先于猜测。

## License

MIT
