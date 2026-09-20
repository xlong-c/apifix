# apifix

[中文](README.md) | [English](README.en.md)

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![dependencies](https://img.shields.io/badge/dependencies-0-success.svg)
![models](https://img.shields.io/badge/models-325-informational.svg)

输入一个模型 id（通常是中转沿用的 legacy 名字），拿到它的**官网规格**，以及可直接粘贴的 opencode / pi 配置片段。

零依赖、零网络请求；配置只在本地按需读取（`audit` / `fix` / `protocols`）。

## 为什么需要它

- **中转不造新 id，只沿用官网旧 id。** 厂商改名或退役后，中转仍按旧名对外服务，于是 `deepseek-v4.1-flash` 这类名字流传开来——它从来不是官方稳定 id。
- **你配置里的数字往往是错的或过期的。** 中转自己填的 context / max output 会随上游漂移，客户端里那一行没人会去核对。
- **"降智"是静默发生的。** thinking 模式下 `temperature` 被直接忽略、`top_p` 有下限、官方不支持的 effort 档位悄悄回落到别的档位。行为变了，但你从配置上看不出来。
- **换模型等于读 22 家厂商的文档。** 每家对推理档位、采样约束、缓存、工具调用的口径都不一样。
- **apifix 只做一件事**：把官方规格摊开，顺手生成配置片段。它对未文档化的值写 `null`，绝不猜。

## 一个真实例子

中转配置里的 `deepseek-v4.1-flash`，对比官网 `deepseek-flash` 的规格：

| 字段 | 你的配置 | 官网规格 |
| --- | --- | --- |
| context | 1,000,000 | 1,048,576 |
| max output | 384,000 | 393,216 |
| effort 档位 | low/high/max | none/low/high/max |

三个字段，三处偏差。`deepseek-v4.1-flash` 从来不是官方稳定 id：官方 V4.1 的测试 id 是
`deepseek-v4.1-flash-expires-on-0910`（按设计过期），正式 id 是 `deepseek-flash`，中转把后缀去掉继续沿用。

context 和 max output 的差额来自上游改版，而 **effort 档位少了 `none`**——意味着这份配置下你关不掉 thinking。

再看"降智"那一面：DeepSeek 在 thinking 模式下**静默忽略** `temperature`，`top_p` 实际下限 0.95，
`medium` / `xhigh` 这类档位会被悄悄折叠成 `high`。这些都是 apifix 卡片和片段里的「注意事项」。

## 快速开始

```bash
git clone <repo> && cd apifix          # 无需 npm install：零依赖
node apifix.mjs deepseek-v4.1-flash    # 默认输出 opencode 片段（key 沿用你输入的 id）
npm start                              # = node apifix.mjs --ui，打开本地 Web UI
```

常用命令：

```bash
node apifix.mjs <id>                   # opencode 片段；stdout 是纯 JSON，提示走 stderr
node apifix.mjs <id> --emit pi         # pi 片段；也可 codex|claude-env|curl|sdk
node apifix.mjs <id> -f                # 完整模式：追加 family/status/modalities/cost 等
node apifix.mjs <id> --card            # box 卡片：完整规格表 + 注意事项 + 来源
node apifix.mjs <id> --json            # catalog 原始条目（全部字段）
node apifix.mjs <id> --name MCGDS      # 覆盖片段里的展示名
node apifix.mjs <id> --canonical-id    # key 用官网规范 id（如 deepseek-flash）
node apifix.mjs --list                 # 全部 id（按 vendor 分组）；--list --json 供脚本用
node apifix.mjs --match ids.txt        # 逐行批量匹配，逐行给结论
node apifix.mjs fix <file> --dry-run   # 配置差异修复预览（y 应用 / --yes 脚本用）
node apifix.mjs --version | --help
```

退出码：`0` 成功、`1` 未收录、`2` 用法或文件错误。

### 协议总览（protocols）

一条命令看清**所有工具配置里每个 provider 实际说的协议**，并对照模型的原生协议：

```bash
node apifix.mjs protocols            # 自动扫描 ~/.config/opencode、~/.pi、~/.claude、~/.codex
node apifix.mjs protocols --json     # 机器可读；--no-defaults 只扫 --file 指定的文件
```

协议不匹配 = 中转必须做协议翻译 = `thinking`/`temperature` 等参数可能在翻译中被静默丢弃（俗称"降智"）。
报告逐行给出 `✓ 匹配` / `⚠ 原生 X（需翻译）` / `? 协议不确定`，末尾汇总不一致的 provider 数量。
支持 opencode（`npm` + `baseURL` 推断）、pi（`api` 字段）、claude-code（`ANTHROPIC_BASE_URL`）、
codex（`config.toml` 的 `wire_api`）；多路协议值（如 `chat_completions|responses|anthropic_messages`）
按"任一皆可"判定为匹配。

### 配置修复（fix）

`audit` 报出的差异，一条命令改回官网规格：先显示差异计划，再询问 `[y/N]`——`y` 应用，`n` 取消。

```bash
node apifix.mjs fix opencode                 # ~/.config/opencode/opencode.json
node apifix.mjs fix pi                       # ~/.pi/agent/models.json
node apifix.mjs fix ./my-config.json         # 任意文件：自动识别 opencode / pi 格式
node apifix.mjs fix opencode --dry-run       # 只看差异计划，不写入
node apifix.mjs fix opencode --yes           # 跳过 [y/N] 询问（脚本用）
```

只改官网已文档化的规格字段（opencode 的 `limit.context`/`limit.output`/`reasoning`/`temperature`/
`tool_call`/`attachment`/`variants`（effort 档位）；pi 的 `contextWindow`/`maxTokens`/`reasoning`/
`thinkingLevelMap`/`input`）。配置里未声明的字段不动；官网未文档化的值不猜，跳过并注明。
**凭证（`apiKey`/`token`）永不触碰、永不回显。** 写入前自动备份为 `<file>.bak-<时间戳>`，
经临时文件原子替换，写后自动复验。`--json` 输出机器可读结果，`--no-backup` 关闭自动备份。

退出码：`0` 已修复或无需修复、`1` 存在差异但未应用（取消 / `--dry-run`）、`2` 用法或读取错误。

## Web UI

```bash
node apifix.mjs --ui                   # 默认 http://127.0.0.1:7788/
node apifix.mjs --ui --port 8000 --no-open
```

![apifix Web UI](docs/ui.png)

- **单条查询**：三栏布局——左侧按 vendor / 生命周期筛选，中间结果列表（含匹配卡片），右侧详情（规格表、注意事项、opencode / pi 片段，带**精简 / 完整**切换）。
- **批量解析**：粘贴一批 id，一次给出每行的匹配结论与命中项。

![批量解析](docs/batch.png)

只监听 `127.0.0.1`，仅暴露 `/`、`/ui/*`、`/lib/*`、`/catalog.json`；端口被占用时自动 +1 重试（最多 +10）。

UI 是**纯静态**的（`ui/` + `lib/core.mjs` + `catalog.json`），把仓库根目录作为站点根发布即可跑在
GitHub Pages 上：根 `index.html` 会重定向到 `/ui/`。

## 支持范围

当前收录 **325** 个条目、22 个 vendor：

| vendor | 数量 | vendor | 数量 | vendor | 数量 |
| --- | ---: | --- | ---: | --- | ---: |
| openai | 63 | anthropic | 24 | alibaba | 42 |
| zhipu | 21 | moonshot | 20 | baidu | 17 |
| google | 17 | cohere | 15 | mistral | 12 |
| tencent | 11 | volcengine | 11 | deepseek | 10 |
| nvidia | 8 | amazon | 7 | iflytek | 7 |
| microsoft | 7 | meta | 7 | xai | 16 |
| minimax | 5 | 01ai | 3 | ai21 / writer | 各 1 |

生命周期：`current` 148、`legacy` 92、`retired` 82、`unreleased` 2（另有 1 条未标注）；305 条已核验官网。

**定价**：**229** 个模型带官方 USD 定价（每 1M tokens）。非美元定价在合并时按固定参考汇率
1 USD = 7.2 CNY 换算，原始币种数值保留在 `cost.note` 里；该汇率是参考值，不是实时行情。

## 匹配规则

依次尝试：**canonical id → aliases → legacy_ids** → 去厂商前缀（`openai/`、`anthropic/`、`meta/`、
`google/`、`x-ai/`、`deepseek/`、`moonshotai/`、`z-ai/`、`qwen/`、`minimax/` 等）→ 去 relay 后缀
（`-free`、`-preview`、`-exp`、`-latest`、`-build`、`-contributor`、`-vision-exp`、`-expires-on-*`、
`-ga-*`、`-YYYYMMDD`、`-vN`）→ 分隔符等价（`-` `.` `_` 视为相同，故 `glm-5-3-flash` 命中
`glm-5.3-flash`）→ 模糊兜底（相似度 ≥ 0.75，只给建议）。

`--match` 标签：`[OK]` 精确、`[A]` 别名、`[L]` legacy、`[~]` 归一化、`[?]` 未收录。
提示只写到 **stderr**，不污染 stdout 的可粘贴输出：

```
[i] deepseek-v4.1-flash 是旧版/退役 id，对应 deepseek-flash；中转仍在沿用，值按官网当前规格输出
```

注意：`-free` 是**第三方/中转约定**（OpenCode Zen、AIHubMix 等；OpenRouter 用冒号形式 `:free`），
**不是厂商官方命名**——官方免费档会用独立模型名（如 `GLM-4.7-Flash`）。

## 完整模式（`-f`）

默认只输出 7 个核心字段；`-f` 追加 catalog 能提供的全部可推导字段：`opencode` 增加 `family`、`status`
（`current`→active / `legacy`/`retired`→deprecated / `unreleased`→beta）、`modalities`（按 `vision`/`pdf`
推导 input）、`cost`（有官方定价时）；`pi` 增加 `api`（`anthropic_messages`→anthropic-messages、
`responses`→openai-responses、`chat_completions`→openai-completions；`native`/`gemini`/null 则省略）。

`cost` 一律是**美元 / 每 1M tokens**（`input`/`output`/`cache_read`/`cache_write`/`context_over_200k`，
空值键省略；`input`/`output` 缺一即整体不输出）。catalog 里没有官方数据的字段（opencode 的
release_date/interleaved/experimental/options/headers，pi 的 provider/baseUrl/compat/cost）**一律省略**，
并在 stderr 用一条 `[i]` 说明——该说明是动态的，`cost` 成功输出后会从缺失列表里去掉。

`-f` 仅对 `--emit opencode|pi` 生效（其他目标提示忽略）；`--card`/`--json`/`--list`/`--match` 本就展示完整数据。

```bash
node apifix.mjs deepseek-flash -f              # opencode 完整模式（含 cost）
node apifix.mjs gpt-5.6-sol --emit pi -f       # pi 完整模式
```

## 数据来源与可信度

- **只采信厂商官方文档**（官方模型页 / API 文档 / 定价页）。聚合站、中转商后台、论坛不作为来源。
- **`null` = 官方未文档化**，不是「等于 0」；渲染为 `未知/not documented`。宁可留空，绝不臆造数值。
- **`verified`**：`true` 表示已与官方文档逐项核验（305/325）；`false` 表示来源间接或待核验，卡片会显式提示。
- **`confidence`**（`high`/`medium`/`low`）配合 `sources` 使用，来源可逐条追溯。
- 生命周期与 `legacy_ids` 记录退役、中转沿用 id 的历史；**退役模型的规格为退役前规格**。

已知限制：目录是静态快照，不会自动更新；模糊匹配只给建议、不自动纠错；`ark-code-latest` 是路由别名，
真实规格随控制台选择变化；`curl`/`sdk` 片段里的 key 需自行设置环境变量。

## 项目结构

```
apifix/
├── apifix.mjs        CLI + 本地 UI 服务器（零依赖）
├── lib/core.mjs      共享核心（纯 ESM，浏览器可直接 import）
├── ui/               Web UI（纯静态）
├── catalog/          数据源：一厂商一文件（catalog/<vendor>.json，手工编辑这里）
├── catalog.json      **生成物**：由 catalog/ 打包的 bundle（CLI/UI 只读它，勿手工编辑）
├── tools/            打包 + 合并 + 校验脚本（CI 用）
├── incoming/         原始调研批次（可追溯数据来源）
├── legacy-python/    初版 Python 实现（仅参考）
└── skills/           配套 AI 技能（model-spec-lookup / catalog-maintain）
```

改数据：编辑 `catalog/<vendor>.json` → `npm run build` 重建 `catalog.json`（详见
[CONTRIBUTING.md](CONTRIBUTING.md)）。

## 常见问题

**数据是哪里来的？**
全部来自厂商官方文档，逐条附 `sources` 链接。`incoming/` 里保留了原始调研批次，可回溯。

**为什么我的 id 显示未收录？**
它可能既不是官方 id、也不是已知的别名或 legacy id（比如中转自造的命名）。用 `--match` 批量跑一遍，
未收录时给出最接近的候选；确认是真实模型就按 [CONTRIBUTING.md](CONTRIBUTING.md) 补一条。

**价格准吗？**
价格来自官方定价页，标注 `as_of` 日期，并用 `confidence` 标注可信度。它是**静态快照**，不保证实时；
调价频繁的模型请以厂商账单为准。非美元定价按 1 USD = 7.2 CNY 参考汇率换算，原值保留在 `cost.note`。

**会读取或上传我的配置吗？**
只在本地读取，全程零网络：`audit` / `fix` 读取你指定的配置文件，`protocols` 默认扫描已知路径
（`--file` 可指定）。凭证字段在提取阶段即被剥离，任何输出都不回显；`fix` 写入前自动备份。

**和 cc-switch 什么关系？**
无关，也不依赖它。生成的片段可以直接贴进你的中转配置，两者可以配合使用。

**怎么新增或修正一个模型？**
见 [CONTRIBUTING.md](CONTRIBUTING.md)：调研结果落到 `incoming/` 批次，跑 `npm run merge` 合并、
`npm run validate` 校验（CI 每次 push/PR 都会跑）。

## 参与贡献

欢迎补充新模型、修正过期规格。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)——最重要的一条是：
**只引用官方文档，未文档化的值写 `null`。**

## License

[MIT](LICENSE)
