# AGENTS.md

本文件面向在本仓库工作的 AI 编码助手。改代码前请先读完「不变量」。

## 项目一句话

apifix：输入一个模型 id（支持中转/别名写法）→ 输出**官网参数规格** + 可直接粘贴的
opencode / pi 配置片段；零依赖 Node（>= 18，ESM），内置纯静态 Web UI，零网络请求
（唯一例外：`login` 的模型自动检测，只请求用户填写的 baseURL）。

## 架构树

```
apifix.mjs                 CLI 入口：参数解析、--list/--match、emit 调度、audit/fix/login 子命令、本地 UI 静态服务器
lib/core.mjs               唯一共享核心：匹配 / 卡片 / emit（浏览器与 Node 通用，零 Node API）
ui/index.html, ui/app.js, ui/style.css
                           纯静态 UI（SPA）
ui/fallback.mjs            UI 降级实现（纯函数模块，零 Node API；与 core 逐字节对拍，见不变量 2）
catalog/                   唯一数据源：一厂商一文件（catalog/<vendor>.json，手工编辑这里）
catalog/.order.json        vendor 文件的规范顺序清单（build 生成，保证确定性）
catalog.json               **生成物**：由 catalog/ 打包的 bundle，CLI/UI 只读它
tools/build-catalog.mjs    catalog/*.json → catalog.json（导出 buildCatalog()，供 merge 复用）
tools/merge-catalog.mjs    incoming/*.json + catalog/ → catalog/ + catalog.json（含 pricing 处理）
tools/validate-catalog.mjs catalog/ 逐条校验 + 来源白名单 + catalog.json 与 catalog/ 一致性（CI 用）
tools/parity-check.mjs     core 与 ui/fallback 的 2616 组逐字节对拍（不变量 2 的自动化守护，CI 用）
tools/source-whitelist.mjs 官方来源白名单（validate / merge 共用）
test/                      node:test 单测（match/emit/scrub/fix/tiers/format，零依赖；node --test 运行）
skills/                    AI 技能包（catalog-maintain / model-spec-lookup，配套助手工作流）
docs/                      发布说明与文档资产（docs/RELEASE-*.md、配图）
incoming/                  原始调研批次（模型批次 + pricing-*.json 定价文件），格式允许宽松
index.html                 站点根：重定向到 /ui/（GitHub Pages 用）
legacy-python/             最初的 Python 实现，仅作行为对拍参考，不参与构建
.github/workflows/validate.yml
                           CI（ubuntu+windows 矩阵）：node --check → build --check → validate →
                           parity-check → node --test → 动态 id 冒烟（list/match/emit/fix）
package.json               scripts: start / build / merge / validate；bin: apifix
```

## 不变量（改代码前必读）

1. **`lib/core.mjs` 是唯一共享核心**：CLI（`apifix.mjs`）和 UI（`ui/app.js`）都依赖它；
   它必须**零 Node API**（无 fs/path/process/url/import），因为浏览器直接 `import` 它。
   改动后必须 `node --check lib/core.mjs` 并确认可在浏览器运行。
2. **`ui/fallback.mjs` 必须与 `lib/core.mjs` 逐字节一致**：UI 在 core 加载失败时降级
   动态 import 它（`ui/app.js` 接线，fallback 本体是独立纯函数模块，零 Node API）。
   对拍口径为 模型数 × 4 emitter（opencode/pi/codex/claude-env）× 2 模式（精简/`-f`），当前
   327 × 8 = **2616 组零差异**，由 `node tools/parity-check.mjs` 自动守护（CI 必跑）；
   改 core 的 emit 逻辑必须同步改 fallback，跑对拍确认 0 差异。
3. **不带 `-f` 的输出是稳定契约**：现有用户依赖它，任何改动不得改变最小输出的字节。
   改动前后用 `diff` 对拍。
4. **`null` = 官方未文档化，绝不臆造数值**。catalog 只采信厂商官方文档（模型页 / API 文档 /
   定价页）；聚合站、中转后台、论坛不作来源。
5. **stderr 提示不污染 stdout**：stdout 必须是可直接粘贴的纯 JSON/文本；所有 `[i]`/`[!]`
   提示走 stderr（`apifix.mjs` 的 `stderr()`；core 内通过 `onNote` 回调转交）。
6. `incoming/` 是原始调研批次（允许宽松格式）；**手工修正写 `catalog/<vendor>.json`**
   （合并时手工条目优先，不会被批次覆盖）。
7. **`catalog/` 是唯一数据源，`catalog.json` 是构建产物**：改数据只改 `catalog/<vendor>.json`，
   然后 `npm run build`（或 `npm run merge`）重新生成 `catalog.json`；**永远不要手工编辑
   `catalog.json`**。`tools/build-catalog.mjs --check` 与 `tools/validate-catalog.mjs` 会强制
   两者一致（CI 第一步就跑 `--check`），不一致时报
   `catalog.json 与 catalog/ 不一致，请运行 npm run build`。
   厂商文件格式为 `{vendor, updated_at, models: [...]}`，条目 `vendor` 必须与文件一致、
   `id` 跨文件全局唯一；全局顺序由 `catalog/.order.json` 固定。

## 凭证安全（AI 助手必读）

**禁止**用 `cat` / `head` / `tail` / `less` / `more` / `bat` 等命令直接输出可能含 API key 的文件。这类文件包括但不限于：
- `~/.config/opencode/opencode.json`（provider.options.apiKey）
- `~/.pi/agent/models.json`、`~/.pi/agent/models-store.json`（provider.apiKey）
- `~/.claude/settings.json`、`~/.claude.json`（env.ANTHROPIC_AUTH_TOKEN）
- `~/.codex/config.toml`（experimental_bearer_token）
- `~/.cc-switch/cc-switch.db`（providers.settings_config 内的 env）
- 任何 `.env` / `.env.*` / `*.key` / `*.pem` / credentials 文件

**原因**：AI 会话记录会完整留存（本地数据库 + 可能上传），key 一旦进入上下文即视为泄露。即使后续删除文件也无法撤回。

**正确做法 —— 用规则化的方式间接读取/修改**：

读取（只取需要的字段，绕开凭证）：
```bash
# 用 jq 只提取非敏感字段
jq '.provider.r4.models | keys' ~/.config/opencode/opencode.json
jq '.providers.r4.api' ~/.pi/agent/models.json

# 需要看结构时，用键名递归（不含值）
jq 'paths(scalars) as $p | $p | join(".")' ~/.config/opencode/opencode.json

# 或用本项目自带工具（已内置脱敏）
node apifix.mjs audit ~/.config/opencode/opencode.json
```

修改（结构化写入，不碰凭证）：
```bash
# 用 jq 做结构化更新并原子替换（示例：改一个非敏感字段）
jq '.provider.ark.models["gpt-6-astra"].limit.context = 1050000' \
  ~/.config/opencode/opencode.json > /tmp/oc.json && mv /tmp/oc.json ~/.config/opencode/opencode.json
```
或使用编辑工具的精确字符串替换（只替换目标字段，不整文件输出）。

推荐用 `apifix fix <file>` 做结构化修复——只改官方规格字段、凭证永不进入计划、自动备份 + 原子写入。

**绝对禁止**：
- 把配置文件内容粘贴进对话、提交到 git、写进日志或测试夹具
- 用 `sed -i` / `awk` 整文件重写（容易破坏 JSON 且中间态可能入日志）
- 在 `--match` / `audit` 的测试夹具里使用真实 key（用 `sk-TEST` 等假值）
- 在报错信息、调试输出中回显文件原文（本项目 audit 已强制脱敏，其他脚本也要遵守）

**发现泄露时的处理**：立即提示用户轮换该 key，并说明泄露位置（哪个文件被哪条命令输出过）。

## 常用命令

```bash
node apifix.mjs <id>                    # 冒烟（默认输出 opencode 片段）
node apifix.mjs <id> --card             # 规格卡片（含 gotchas / sources）
node apifix.mjs <id> -f                 # 完整模式（含 cost / status / modalities）
node apifix.mjs fix <file> --dry-run    # 配置差异修复预览（y 应用 / --yes 脚本用）
node apifix.mjs login opencode [名称]   # 交互式添加 opencode 供应商（baseURL/协议/key/模型）
npm start                               # UI (127.0.0.1:7788)
npm run build                           # catalog/ → catalog.json（生成物）
node tools/build-catalog.mjs --check    # 确认 catalog.json 与 catalog/ 一致（CI 第一步）
node tools/parity-check.mjs             # core 与 ui/fallback 逐字节对拍（改 emit 后必跑，CI 必跑）
node --test                             # 运行 test/ 单测（零依赖，Node >= 18 自带）
npm run merge                           # 合并 incoming → catalog/ + catalog.json
npm run validate                        # 校验 catalog/ + 一致性（CI 用）
node --check <file>.mjs                 # 语法检查（所有 .mjs；ui/app.js 也查）
```

Python 参考实现在 `legacy-python/`，可用
`python3 legacy-python/apifix.py --catalog catalog.json <id>` 做行为对拍（它与 Node 版
逐字节一致是历史基线，除已知的 pi `off` 映射差异：官方 `none` 存在时 Node 输出 `"none"`、
Python 输出 `null`；且 Python 版没有 `-f`）。

## 如何新增/更新模型（简版流程，详见 CONTRIBUTING.md）

1. 调研：**只查官方文档**（模型页 / API 文档 / 定价页），记下链接；
2. 写 `incoming/<batch>.json`（模型批次）或 `incoming/pricing-<group>.json`（定价），
   或直接编辑 `catalog/<vendor>.json`（一厂商一文件，推荐小改动）；
3. `npm run merge`（先 `node tools/merge-catalog.mjs --dry-run` 看报告）；
   合并会写 `catalog/` 并自动重建 `catalog.json`；
4. `npm run build -- --check` 或 `node tools/build-catalog.mjs --check` 确认 bundle 一致；
5. `npm run validate`，必须 0 error；
6. `git diff catalog/ catalog.json` 复核改动（只应出现预期的条目/字段）；
7. 条目数/vendor/verified/定价数有变化时，同步 README 与 README.en 的统计数字，例如：
   `node -e "const j=require('./catalog.json');console.log(j.models.length, new Set(j.models.map(m=>m.vendor)).size, j.models.filter(m=>m.verified).length)"`。

## 数据格式速查

catalog 条目关键字段：

- 基础：`id` / `vendor` / `family` / `api_protocol` / `verified` / `confidence`；
- 生命周期：`lifecycle`（current / legacy / retired / unreleased）+ `lifecycle_note`；
- 规格：`context_window` / `max_output_tokens`；
  `reasoning{effort_values, default_effort, can_disable, thinking_budget}`；
  `sampling{temperature, top_p, top_k}` 各含 `{supported, range, constraint}`；
  `tools{function_calling, parallel, strict, choice_modes}`；
  `structured_output{supported, mechanism}`；`vision` / `pdf`；`caching{mode, min_tokens, ttl_options}`；
- id 映射：`aliases[]` / `legacy_ids[{id, note}]`；
- 备注：`gotchas[]` / `sources[]`；
- `cost`：USD / 每 1M tokens，含 `tiers`（三种边界写法：`max_input` 数值、`min_input_tokens`
  数值、`condition` 字符串，**三者恰有其一**）。

## 已知陷阱

- `cost` 只在 `-f` 完整模式输出；`tiers` 是 catalog 元数据，**永不进配置片段**
  （`--json` 会原样 dump 整个条目，属例外）。
- pi 的 `off` 档：官方 `none` 存在时映射为 `"none"`，否则 `null`。
- `lifecycle` → opencode `status` 映射：current→active / legacy·retired→deprecated /
  unreleased→beta。
- 模糊匹配只建议（相似度 ≥ 0.75），命中失败返回 exit 1；用法错误 exit 2。
- **配置识别走严格模式**：`audit` / `fix` / `protocols` 读配置里的模型 id 时一律用
  `matchModel(models, id, { strict: true })`——链路是 `id → 模型 → 识别接口 → 修复参数`，只认
  id / alias / legacy；归一化（去厂商前缀、去 relay 后缀、分隔符等价）与模糊只回落到 `suggestion`
  （`suggestionKind: "normalized" | "prefix" | null`），**绝不自动命中**（避免把中转变体误套官网规格）。
  CLI 直接查询（`<id>`、`--match`、`login`、UI）保持宽松语义，两处不要混用。
  **中转自造的名字**（如 `MiniMaxAI/MiniMax-M2`、`muse-spark-1.3-contributor`）应在 catalog 里
  显式登记为 `aliases` 做锚定，而不是依赖算法猜测。
- 厂商前缀（`vendor/id`）识别 = 静态别名表 + **目录内 vendor 自动并入**（core 的 `vendorPrefixSet`，
  fallback 的 `vendorPrefixSetFallback` 必须同步）——新增厂商后 `stepfun/step-5-preview` 这类中转写法
  直接命中；parity-check 的 match 弱断言已覆盖 `vendor/<id>` 形态（约 985 组）。
- 短缩写（如 `step5`）走「前缀匹配」建议：`suggestionKind: "prefix"`，**只建议**（kind 保持 none、
  退出码不变），CLI 展示为「最接近: …（前缀匹配）」。
- `protocols` 的 `@ai-sdk/openai` 是**格式声明**（`OPENCODE_NPM_PROTOCOLS`，`inferred: false`，协议列显示
  `openai`）：比对按 **OpenAI 家族**（`OPENAI_FAMILY = chat_completions / responses`），模型支持其中任一即
  `✓ 匹配`；仅 baseURL 含 `/responses` 时细化为 responses（该细化是 URL 启发式、`inferred: true`，
  与官方不一致只出 `? 协议不确定`，绝不武断报「需翻译」）。
- 三种阶梯价格式都必须被 merge/validate 接受，改 schema 时三者一起改。
- `audit` 输出已强制凭证脱敏（key/token/secret → `[REDACTED]`），但其他脚本/命令不保证——读写配置一律走结构化路径。
- pi 的 `input` 比较**不含 `pdf`**（pi 只支持 text/image，见 pi-ai 类型定义）；`audit` 不再对 pi 报「缺 pdf」。
- `protocols` 把**模型库**（`~/.pi/agent/models-store.json`，工具自动生成的模型清单）与手写配置分流：
  source / `provider` 带 `store: true`（默认扫描清单里 `{ shape: "pi-store", store: true }`），
  渲染折叠成一行；`summary.unmapped` 只统计手写配置，模型库单列 `store_models` / `store_unmapped`。
- windows CI 矩阵依赖 `.gitattributes`（`* text=auto eol=lf`）统一行尾：`build-catalog.mjs --check`
  是逐字节比较，runner 默认 `core.autocrlf=true` 会把检出转成 CRLF、在 Windows 上假红——不要删该文件。
- codex / claude-env 的**精简输出同样是不变量 3 的一部分**：新内容（codex 的 provider 段、claude 的
  settings.json env 块）只进 `-f`；两者用固定占位符（`YOUR_BASE_URL` / `YOUR_API_KEY`），不联网不臆造。
- codex 的 audit/exchange 判定顺序：`[model_providers.x]` 以 `[` 开头，**TOML 判定必须在「JSON 形状
  解析失败」检查之前**（`cmdAudit` 的 `isCodex`），否则 .toml 会被当破损 JSON 报错。
- codex fix 走 **行级回写**（`scanCodexToml` / `applyCodexFixes`）：只替换目标值的字符区间，
  注释 / 缩进 / 引号风格 / CRLF 等其余字节一律不动；未声明字段绝不新增。
- claude 的 `env` 是凭证容器：必须走 `projectClaudeEnv` **白名单投影**（AUTH_TOKEN 直接丢弃），
  不能走 `stripCredentials`（它整段删 `env`，会导致 0 条目）；fix 只允许改
  `CLAUDE_CODE_EFFORT_LEVEL` 与 `MAX_THINKING_TOKENS`（值保持字符串）。

## 风格约定

- 中文注释 / 中文文档；
- 不引入任何 npm 依赖，不加构建步骤，UI 保持纯静态；
- 新增行为优先放 `lib/core.mjs`（保持浏览器可运行），CLI 只做参数与 I/O。
