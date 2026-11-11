# AGENTS.md

本文件面向在本仓库工作的 AI 编码助手。改代码前请先读完「不变量」。

## 项目一句话

apifix：输入一个模型 id（支持中转/别名写法）→ 输出**官网参数规格** + 可直接粘贴的
opencode / pi / codex / claude 配置片段。纯 Rust 实现（Rust 1.99），桌面界面用
GPUI（gpui-kit），零网络请求。

## 架构树

```
Cargo.toml                 唯一构建入口（bin: apifix；依赖 gpui-kit）
rust-toolchain.toml        固定 Rust 1.99（gpui-kit 的 gpui-pre 需要）
src/main.rs                CLI 入口：clap 参数解析、--list/--match、emit 调度、audit/search/compare、catalog 子命令
src/lib.rs                 共享库根：model_label + 模块导出
src/gui.rs                 GPUI 桌面界面（单条查询 + 批量解析），复用共享库渲染
src/catalog.rs             catalog.json 加载（内嵌 include_str!）/ 过滤
src/catalog_tools.rs       catalog/ ↔ catalog.json 的构建与校验（原 Node 工具的 Rust 移植）
src/matching.rs            匹配：id / alias / legacy / 归一化 / 模糊 / 严格模式
src/render.rs              opencode / pi 片段与规格卡片
src/extra.rs               codex / claude-env / curl / sdk 片段
src/config.rs              配置审计（audit）：识别配置里的模型并比对官网规格
catalog/                   唯一数据源：一厂商一文件（catalog/<vendor>.json，手工编辑这里）
catalog/.order.json        vendor 文件的规范顺序清单（构建时维护，保证确定性）
catalog.json               **生成物**：由 catalog/ 打包的 bundle，二进制内嵌它
tools/build-catalog.mjs    Node 侧构建实现，仅被 merge 复用（正式入口是 `apifix catalog build`）
tools/merge-catalog.mjs    incoming/*.json + catalog/ → catalog/ + catalog.json（含 pricing 处理）
tools/schema.mjs           schema 词表（merge 使用）
tools/source-whitelist.mjs 官方来源白名单（merge 使用；Rust 侧有一份等价实现）
tools/fixtures/            audit 冒烟用配置夹具（内含假 key：sk-TEST）
skills/                    AI 技能包（catalog-maintain / model-spec-lookup）
docs/                      设计文档与发布说明（docs/plans/*、docs/RELEASE-*.md）
incoming/                  原始调研批次（模型批次 + pricing-*.json 定价文件），格式允许宽松
.github/workflows/validate.yml
                           CI（ubuntu+windows 矩阵）：fmt → test → clippy → catalog build --check →
                           catalog validate → CLI 冒烟（list/match/emit/search/compare/audit）
package.json               仅剩便利脚本：start / build / validate / merge
```

**已移除**：旧的 Node CLI（`apifix.mjs`）、`lib/`、纯静态 Web UI（`ui/`）、`test/`（node:test）、
`legacy-python/`、`tools/parity-check.mjs`、根 `index.html`。

## 不变量（改代码前必读）

1. **`src/lib.rs` 下的模块是唯一共享核心**：CLI（`src/main.rs`）与 GUI（`src/gui.rs`）
   都调用它，不要在 `main.rs` / `gui.rs` 里另写一套匹配或渲染逻辑。
   GUI 的卡片/片段必须由 `render::card` / `render::emit` 产出，保证与 CLI 逐字节一致。
2. **不带 `-f` 的输出是稳定契约**：现有用户依赖它，任何改动不得改变最小输出的字节。
   改动前后用 `diff` 对拍（可对已发布的公开 id 逐个比较）。
3. **`null` = 官方未文档化，绝不臆造数值**。catalog 只采信厂商官方文档（模型页 / API 文档 /
   定价页）；聚合站、中转后台、论坛不作来源。
4. **stderr 提示不污染 stdout**：stdout 必须是可直接粘贴的纯 JSON/文本；所有 `[i]`/`[!]`
   提示走 stderr。GUI 启动失败同样走 stderr 并 exit 1。
5. `incoming/` 是原始调研批次（允许宽松格式）；**手工修正写 `catalog/<vendor>.json`**
   （合并时手工条目优先，不会被批次覆盖）。
6. **`catalog/` 是唯一数据源，`catalog.json` 是构建产物**：改数据只改 `catalog/<vendor>.json`，
   然后 `cargo run -- catalog build` 重新生成 `catalog.json`；**永远不要手工编辑
   `catalog.json`**。`cargo run -- catalog build --check` 与 `cargo run -- catalog validate`
   会强制两者一致（CI 必跑），不一致时报
   `catalog.json 与 catalog/ 不一致，请运行 apifix catalog build`。
   厂商文件格式为 `{vendor, updated_at, models: [...]}`，条目 `vendor` 必须与文件一致、
   `id` 跨文件全局唯一；全局顺序由 `catalog/.order.json` 固定。
7. **Rust 与 Node 工具必须产出一致字节**：`tools/build-catalog.mjs` 仍被
   `tools/merge-catalog.mjs` 复用。合并后务必跑 `cargo run -- catalog build --check`
   确认 Rust 与提交的 `catalog.json` 一致；两边序列化口径（2 空格缩进 + 末尾换行 +
   模型顺序来自 `.order.json`）不得分叉。

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
cargo run -- audit ~/.config/opencode/opencode.json
```

修改（结构化写入，不碰凭证）：
```bash
# 用 jq 做结构化更新并原子替换（示例：改一个非敏感字段）
jq '.provider.ark.models["gpt-6-astra"].limit.context = 1050000' \
  ~/.config/opencode/opencode.json > /tmp/oc.json && mv /tmp/oc.json ~/.config/opencode/opencode.json
```
或使用编辑工具的精确字符串替换（只替换目标字段，不整文件输出）。

**绝对禁止**：
- 把配置文件内容粘贴进对话、提交到 git、写进日志或测试夹具
- 用 `sed -i` / `awk` 整文件重写（容易破坏 JSON 且中间态可能入日志）
- 在 `--match` / `audit` 的测试夹具里使用真实 key（用 `sk-TEST` 等假值）
- 在报错信息、调试输出中回显文件原文（本项目 audit 已强制脱敏，其他代码也要遵守）

**发现泄露时的处理**：立即提示用户轮换该 key，并说明泄露位置（哪个文件被哪条命令输出过）。

## 常用命令

```bash
cargo run                               # GPUI 桌面应用
cargo run -- <id>                       # 冒烟（默认输出 opencode 片段）
cargo run -- <id> --card                # 规格卡片（含 gotchas / sources）
cargo run -- <id> -f                    # 完整模式（含 cost / status / modalities）
cargo run -- --list                     # 列出全部模型
cargo run -- --match <file>             # 批量匹配（每行一个 id）
cargo run -- search <q>                 # 全文搜索
cargo run -- compare <id> <id>          # 并排对比
cargo run -- audit <file> [--json]      # 配置审计（已脱敏）
cargo run -- catalog build [--check]    # catalog/ → catalog.json（--check 只校验一致性）
cargo run -- catalog validate [FILE]    # 校验 catalog/ + schema + 来源白名单 + bundle 一致性
npm run merge                           # 合并 incoming → catalog/ + catalog.json（Node，仍需 Node >= 18）
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## 如何新增/更新模型（简版流程，详见 CONTRIBUTING.md）

1. 调研：**只查官方文档**（模型页 / API 文档 / 定价页），记下链接；
2. 写 `incoming/<batch>.json`（模型批次）或 `incoming/pricing-<group>.json`（定价），
   或直接编辑 `catalog/<vendor>.json`（一厂商一文件，推荐小改动）；
3. `npm run merge`（先 `node tools/merge-catalog.mjs --dry-run` 看报告）；
   合并会写 `catalog/` 并自动重建 `catalog.json`；
4. `cargo run -- catalog build --check` 确认 bundle 一致；
5. `cargo run -- catalog validate`，必须 0 error；
6. `git diff catalog/ catalog.json` 复核改动（只应出现预期的条目/字段）；
7. 条目数/vendor/verified/定价数有变化时，同步 README 与 README.en 的统计数字，
   可用 `jq '[.models|length, (.models|map(.vendor)|unique|length), (.models|map(select(.verified))|length)]' catalog.json`。

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
- **配置识别走严格模式**：`audit` 读配置里的模型 id 时用 `match_model(models, id, true)`——
  链路是 `id → 模型 → 识别接口 → 修复参数`，只认 id / alias / legacy；归一化（去厂商前缀、
  去 relay 后缀、分隔符等价）与模糊只回落到 `suggestion`
  （`suggestion_kind: "normalized" | "prefix" | null`），**绝不自动命中**（避免把中转变体误套官网规格）。
  CLI 直接查询（`<id>`、`--match`）保持宽松语义，两处不要混用。
  **中转自造的名字**（如 `MiniMaxAI/MiniMax-M2`、`muse-spark-1.3-contributor`）应在 catalog 里
  显式登记为 `aliases` 做锚定，而不是依赖算法猜测。
- 厂商前缀（`vendor/id`）识别 = 静态别名表 + **目录内 vendor 自动并入**
  （`matching::known_vendor_prefix`）——新增厂商后 `stepfun/step-5-preview` 这类中转写法直接命中。
- 短缩写（如 `step5`）走「前缀匹配」建议：`suggestion_kind: "prefix"`，**只建议**
  （kind 保持 none、退出码不变），CLI 展示为「最接近: …（前缀匹配）」。
- 三种阶梯价格式都必须被 merge 与 `catalog validate` 接受，改 schema 时三者一起改
  （Rust 侧在 `src/catalog_tools.rs::check_cost`，Node 侧在 `tools/schema.mjs`）。
- `audit` 输出已强制凭证脱敏（key/token/secret → `[REDACTED]`），但其他代码不保证——
  读写配置一律走结构化路径。
- pi 的 `input` 比较**不含 `pdf`**（pi 只支持 text/image）；`audit` 不再对 pi 报「缺 pdf」。
- windows CI 矩阵依赖 `.gitattributes`（`* text=auto eol=lf`）统一行尾：`catalog build --check`
  是逐字节比较，runner 默认 `core.autocrlf=true` 会把检出转成 CRLF、在 Windows 上假红——不要删该文件。
- codex / claude-env 的**精简输出同样是不变量 2 的一部分**：新内容（codex 的 provider 段、claude 的
  settings.json env 块）只进 `-f`；两者用固定占位符（`YOUR_BASE_URL` / `YOUR_API_KEY`），不联网不臆造。
- **GPUI 布局陷阱**（改 `src/gui.rs` 前必读）：
  - `overflow_y_scroll()` 在 `StatefulInteractiveElement` 上，必须先 `.id("...")`；
  - flex 容器里的滚动区要加 `.min_h_0()` / `.min_w(px(0.))`，否则子项按内容撑高
    （338 行模型列表会把整行撑到上万像素，右栏被挤出屏幕）；
  - `h_flex()` 自带 `items_center()`，并排两栏要用 `.items_start()` / `.items_stretch()` 覆盖；
  - `Textarea::h_full()` 需要外层容器有确定高度。
- **GPU 要求**：GPUI 无软件渲染降级。窗口创建失败时 `gui::run()` 返回 Err，
  `main.rs` 打印 CLI 兜底提示并 exit 1（用法错误仍是 exit 2）。

## 尚未移植（原 Node 实现已删除）

`fix`（配置修复）、`login`（交互式添加供应商）、`protocols`（协议扫描）三类命令目前
**没有实现**：它们随旧 Node CLI 一起删除。需要这些能力时再按原有行为往 Rust 里移植，
`tools/fixtures/` 里的夹具可作为回归输入。

## 风格约定

- 中文注释 / 中文文档；
- 不引入任何 npm 依赖，不加构建步骤；
- 新增行为优先放共享库模块（`src/matching.rs` / `src/render.rs` / `src/catalog.rs`），
  CLI 与 GUI 只做参数、I/O 与展示。
