# Slint → GPUI（gpui-kit）桌面 GUI 迁移设计

日期：2026-11-11
状态：**已实施并验证**（编译 / clippy / fmt / 单元测试 / 实机窗口截图全部通过）

## 目标

把 apifix 桌面 GUI 从 Slint 整体迁移到 **gpui-kit**（longbridge/gpui-kit），
功能与现有 Slint 版 1:1 对齐（单条查询 + 批量解析），Rust CLI 与共享库
`src/lib.rs`（catalog / matching / render）完全不动，GUI 输出与 CLI 输出
逐字节一致。

## 背景与选型

- 现状：`ui/app.slint`（161 行）+ `src/gui.rs`（222 行），Slint 1.18.1，
  `renderer-software` 后端。用户反馈 Slint bug 多，要求整体切换到 GPUI。
- 评估过裸 GPUI 0.2.2（crates.io 正式版）+ 手写控件，但用户明确选择
  **gpui-kit 全家桶**（组件齐全、主题现成、虚拟列表）。
- 关键约束：gpui-kit 内部统一使用 `gpui-pre` =0.3.12（Zed gpui 的 pinned
  snapshot），我们 Cargo.toml 也统一走这套，**不混入官方 `gpui` 0.2.2**，
  以免出现两棵 gpui 树类型不兼容。

## 依赖策略（最终落地）

```toml
[dependencies]
# UI：gpui-kit 全家桶，单一依赖即带上 GPUI + Base + Component + 图标资源。
# 它内部统一锁定 gpui-pre =0.3.12，官方 gpui 0.2.2 不要同时引入，避免两棵 gpui 树。
gpui-kit = "0.9.1"

# 保留
clap = { version = "4.5", features = ["derive"] }
serde_json = { version = "1.0", features = ["preserve_order"] }
strsim = "0.11"
```

- 一开始试过分别引入 `gpui-component` / `gpui-base` / `gpui-pre`，能用但三处版本要自己对齐；
  改为 `gpui-kit` 后入口也统一成 `gpui_kit::application()` / `gpui_kit::init()` /
  `gpui_kit::open_window()`，与官方示例一致。
- 移除：`slint`、`slint-build`、`arboard`（GPUI 自带 `ClipboardItem` /
  `cx.write_to_clipboard`）。
- `build.rs` 删除（Slint 编译步骤消失），`Cargo.toml` 移除 `build = "build.rs"`。
- `Cargo.lock` 重新生成，Slint 全家（i-slint-*、slint-macros 等）从依赖树消失。
- 跨平台：gpui-kit 支持 Windows / macOS / Linux（X11 + Wayland），CI 矩阵不变。

## 工具链要求（实施中发现）

`gpui-pre` 0.3.12 用了 `std::hint::cold_path`，Rust 1.93 stable 尚未稳定该 API，
默认 stable 直接编译失败。因此：

- `Cargo.toml` 的 `rust-version` 提到 **1.99**；
- 新增 `rust-toolchain.toml` 固定 `channel = "1.99.0"`（rustup 会自动安装），
  保证 `cargo run` / `cargo test` 在本地与 CI 都用同一版本。

## GPU 不可用行为

GPUI 仍是 GPU-only 渲染（blade/Vulkan/Metal/DX），无软件渲染降级：

- GPU 不可用 / 窗口创建失败 → `gui::run()` 返回 `Err`，`main.rs` 打印
  「GPU 不可用/初始化失败，请用 CLI：`cargo run -- <id>` 或 `npm start` 的
  Web UI」并 exit 1。
- 可选增强：启动后用 `GpuSpecs::is_software_emulated` 检测 llvmpipe/WARP
  软件渲染，弹一条警告但照常运行。
- catalog 加载失败同理走 CLI 兜底提示。

## UI 控件映射

| Slint 控件 | gpui-component |
|---|---|
| LineEdit（搜索） | `input::TextInput` |
| ComboBox（厂商/状态/emitter） | `select::Select` |
| CheckBox（仅已核验/完整模式） | `checkbox::Checkbox` |
| Button | `button::Button` |
| ScrollView + 列表 | `scroll::Scrollable` + `VirtualList`（337 行虚拟化） |
| TextEdit（详情/输出/批量） | `input::TextArea`（只读） |
| 布局 | `h_flex` / `v_flex` + `resizable::ResizablePanelGroup` |

## 架构与数据流（实际实现）

- `src/gui.rs` 重写为 GPUI `Render` 视图树：`AppView` 实现 `Render`，
  顶部 `render_header` + 主体 `render_single` / `render_batch`。
- 共享可变状态放 `Rc<RefCell<ViewState>>`（`selected_id` / `emitter` / `full` /
  `query` / `vendor` / `lifecycle` / `verified_only`）；`batch_view` 与
  `batch_output` 直接放 `AppView` 字段。
- 事件接线：
  - 搜索框 → `cx.subscribe_in(&search, window, ..)` 监听 `InputEvent::Change`；
  - 三个下拉 → `cx.subscribe_in(..)` 监听 `SelectEvent::Confirm`；
  - 复选框/行点击回调只给 `&mut App`，因此用 `App::notify(entity_id)` 触发重绘；
  - 按钮类（批量切换 / 解析 / 复制）用 `cx.listener(..)` 拿到 `&mut Context<Self>`。
- catalog 加载、`match_model`、`render::card`、`render::emit` 全部复用
  现有 `apifix::` 库，保证与 CLI 输出逐字节一致。详情/片段在 `render` 里由
  当前状态即时算出（不再维护第二份文本状态，避免 `set_value` → `notify` 抖动）。
- 布局对齐原 Slint 版：
  - 单条查询：顶栏（标题 + 批量切换 + 状态）；左栏（搜索/厂商/状态/仅已核验/
    模型目录列表）；右栏（规格详情 + 配置片段：emitter 下拉 + 完整模式 +
    复制 + 只读输出）。
  - 批量解析：左右双栏（输入 / 输出）+ 解析 / 复制结果按钮。

### GPUI 布局踩坑（已修）

- `overflow_y_scroll()` 定义在 `StatefulInteractiveElement` 上，必须先 `.id(..)`。
- flex 容器里放滚动区必须给 `.min_h_0()` / `.min_w(px(0.))`，否则子项按内容
  撑高（模型列表 338 行会把整行撑到上万像素）。
- `h_flex()` 自带 `items_center()`；左右两栏并排时要用 `.items_start()` /
  `.items_stretch()` 覆盖，否则较矮的一栏会被垂直居中到屏幕外。
- `Textarea::h_full()` 需要外层容器有确定高度（`v_flex().flex_1().h_full()`）。

## 错误处理

- `gui::run() -> Result<(), String>`，窗口创建失败（典型：GPU 不可用）返回 Err。
- `main.rs` 捕获 Err，stderr 打印 CLI 兜底提示，**exit 1**（用法错误仍是 exit 2，
  stdout 保持干净）。
- 交互内错误（如 emitter 未知）在输出区显示错误文本，不 panic。

## 测试

- `cargo test`：共享库 + catalog 工具共 12 个测试全部通过。
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 均通过（CI 同口径）。
- GUI 冒烟：实机启动窗口，`PrintWindow` 截图确认单条查询与批量解析两种视图都正确
  渲染（截图落在 `docs/screenshots/gpui-*.png`）。
- `catalog build/validate` 与旧 Node 脚本逐字节对拍：
  - `--check` 一致（338 条 / 24 厂商）；
  - 正常校验输出 2 行完全相同；
  - 注入错误的 bundle（71 行报错）输出逐行相同，退出码相同。

## 文件变更清单

- 删除：`build.rs`、`ui/app.slint`、`docs/screenshots/slint-*.png`
- 重写：`src/gui.rs`
- 新增：`rust-toolchain.toml`、`docs/screenshots/gpui-*.png`、
  `src/catalog_tools.rs`、本设计文档
- 微调：`src/main.rs`（GUI 失败 exit 1、新增 `catalog` 子命令、移除 `--ui`）、
  `Cargo.toml`（gpui-kit + rust-version 1.99）、`package.json`、
  `.github/workflows/validate.yml`（Rust 1.99 + GPUI Linux 依赖 + Rust 版 catalog 检查）
- 更新：`README.md`、`README.en.md`、`AGENTS.md`、`CONTRIBUTING.md`、`skills/*`
  （Slint → GPUI、去掉 Node CLI / Web UI 段落、命令改 `cargo run -- ...`）、
  `docs/plans/2026-11-02-rust-slint-*.md`（加废弃注记）
- `Cargo.lock` 重新生成

## 后续清理（2026-11-11，第二轮）

用户要求清掉旧 UI 与 Node 侧，按「连同 Node 侧全部删掉 + build/validate 迁 Rust」执行：

- **删除**：`apifix.mjs`、`lib/`（core.mjs）、`ui/`（index.html / app.js / style.css /
  fallback.mjs）、`test/`（14 个 node:test 文件）、`legacy-python/`、根 `index.html`、
  `docs/ui.png`、`docs/batch.png`、`tools/validate-catalog.mjs`、`tools/parity-check.mjs`。
- **迁移**：`tools/build-catalog.mjs` + `tools/validate-catalog.mjs` 的行为移植到
  `src/catalog_tools.rs`，新增 CLI 子命令：
  - `apifix catalog build [--check] [--dry-run]`
  - `apifix catalog validate [FILE]`
  序列化口径（2 空格缩进 + 末尾换行 + `.order.json` 顺序）、报错文案（含 `pyRepr`
  形态）、退出码全部与原脚本一致。
- **保留**：`tools/{build-catalog,merge-catalog,schema,source-whitelist}.mjs` ——
  `merge-catalog.mjs` 仍依赖它们来合并 `incoming/` 批次；构建/校验的正式入口已是 Rust。
- **随删功能**：`fix` / `login` / `protocols` 三类命令（原本只有 Node 实现）暂时没有等价
  Rust 实现，README/AGENTS 已明确标注「尚未提供」。
- `package.json` 精简为便利脚本（start / build / validate / merge）。

## 不变量延续

- catalog 数据与生成流程不变（`catalog/` 唯一数据源，`catalog.json` 生成物）。
- CLI 行为、stdout/stderr 分离、exit code 语义不变。
- GUI 的 emit 输出与 CLI 逐字节一致（复用同一 `render::emit`）。
