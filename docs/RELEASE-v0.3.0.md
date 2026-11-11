# apifix v0.3.0

> **破坏性变更版本**：桌面 UI 从 Slint 换成 GPUI，Node CLI 与旧 Web UI 已移除，
> 版本要求升到 Rust 1.99。升级前请先看下面的「移除」与「尚未提供」。

## 桌面 UI：Slint → GPUI

Slint 版本问题较多，桌面界面整体迁移到 [longbridge/gpui-kit](https://github.com/longbridge/gpui-kit)。

- 单一依赖 `gpui-kit = "0.9.1"`（内部统一锁定 `gpui-pre = 0.3.12`，不再混用官方 gpui 树）
- 功能与 Slint 版对齐：单条查询（搜索 / 厂商 / 状态 / 仅已核验 / 模型列表 /
  规格详情 / 配置片段）+ 批量解析（双栏 + 解析 / 复制）
- 详情与片段仍由共享库 `render::card` / `render::emit` 产出，与 CLI 输出逐字节一致

![GPUI 桌面版：模型规格与配置片段](docs/screenshots/gpui-model-lookup.png)

![GPUI 桌面版：批量模型匹配](docs/screenshots/gpui-batch-lookup.png)

> **GPU 要求**：GPUI 是 GPU 渲染，没有软件渲染降级。无可用 GPU（无显卡、虚拟机、
> 远程桌面未直通、Linux 缺 Vulkan 驱动等）时窗口创建失败，程序打印提示并以退出码 1
> 结束；此时请改用 CLI。

## 工具链：需要 Rust 1.99

`gpui-pre` 0.3.12 使用了 `std::hint::cold_path`（Rust 1.93 stable 尚未稳定），
因此仓库新增 `rust-toolchain.toml` 固定 **Rust 1.99**，rustup 会自动安装。

## 新增：`catalog` 子命令（catalog 构建与校验进入 Rust）

原来只存在于 Node 脚本里的构建 / 校验，现在是 CLI 的一部分：

```bash
apifix catalog build            # catalog/ → catalog.json
apifix catalog build --check    # 只校验一致性（CI 用）
apifix catalog build --dry-run  # 只打印摘要，不写入
apifix catalog validate         # 结构 + schema + 来源白名单 + bundle 一致性
apifix catalog validate FILE    # 校验指定的 bundle 文件
```

行为与原脚本对齐（已逐字节对拍）：序列化口径（2 空格缩进 + 末尾换行 +
`.order.json` 顺序）、报错文案、退出码均一致。

## 移除

- **Node CLI**：`apifix.mjs`、`lib/core.mjs`、`test/`（node:test）
- **旧纯静态 Web UI**：`ui/`（`app.js` / `index.html` / `style.css` / `fallback.mjs`）、
  根 `index.html`
- **行为参考实现**：`legacy-python/`
- **旧工具**：`tools/validate-catalog.mjs`、`tools/parity-check.mjs`

仓库净减约 1.9 万行。

## 尚未提供

以下命令原本只有 Node 实现，随 Node CLI 一起移除，**当前没有等价 Rust 实现**：

- `fix` —— 配置差异修复（自动备份 + 原子写入 + TOML 行级回写）
- `login` —— 交互式添加供应商（原项目中唯一会发网络请求的命令）
- `protocols` —— 协议扫描

`audit`（配置审计）保留并继续可用。需要上述能力时欢迎提交 Rust 移植 PR，
`tools/fixtures/` 的夹具可直接作为回归输入。

## 其他

- `package.json` 精简为便利脚本（`start` / `build` / `validate` / `merge`），
  不再作为 npm 包安装；`npm start` 仍等于 `cargo run`
- CI 改为纯 Rust 流水线，并降低 Actions 分钟数：push 只在 master 触发、
  加 concurrency 取消旧运行、加 cargo 缓存
- 文档（README / AGENTS.md / CONTRIBUTING.md / skills）按纯 Rust 架构重写

## 升级指引

```bash
# 从源码更新
git pull && cargo run

# 重新安装
cargo install --git https://github.com/xlong-c/apifix --locked
```

如果你此前依赖 `apifix fix` / `login` / `protocols`，请先留在 v0.2.3，
或用 `git checkout v0.2.3` 构建旧版本。
