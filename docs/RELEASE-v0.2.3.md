# Release v0.2.3

> UI 可查阅 / 写入本机配置（按供应商切换）；`apifix fix --fill` 把「只声明 name」的最小条目一次性补齐为官网规格。

## 新增

- **Web UI 本机配置**（需 `npm start` / `apifix --ui`）：在「API 配置」页查阅本机
  OpenCode / Pi / Codex / Claude Code 配置。供应商做成与顶部平台栏一样的切换；
  可编辑某一家的 JSON 片段、删除空供应商或单个模型，也可把已选模型写入对应供应商
  （官网规格自动注入，写入前备份为 `.bak-时间戳`）。凭证在预览里脱敏为 `[REDACTED]`，
  编辑片段时占位符会沿用原 key。详情页可点「加入配置」。
- **`apifix fix --fill` 补齐模式**：默认只对比配置里已声明的字段；加 `--fill` 后，
  未声明的可比字段也纳入计划，从「（缺失）」一次性补全为官网值。
  适合 `login` 为未收录模型写入的 `{name: id}` 最小条目，或手写的中转配置。

  ```bash
  apifix fix opencode --fill --dry-run   # 先看会补哪些字段
  apifix fix opencode --fill --yes       # 一次性补齐
  ```

- 字段清单与默认模式一致（opencode：`limit`/`reasoning`/`temperature`/`tool_call`/
  `attachment`/`variants`；pi：`contextWindow`/`maxTokens`/`reasoning`/`thinkingLevelMap`/`input`）；
  官网 `null`（未文档化）的字段仍然跳过并注明，绝不臆造；凭证字段不受影响。
- **空 `name` 一并补为模型 id**：配置里已声明但 `trim()` 后为空的 `name`（如 `{ "glm-5.3-flash":
  { "name": "" } }`）会补为模型 id，与 `apifix <id> --emit opencode` 默认输出一致；未声明 `name`
  的条目不新增字段，非空 `name` 保留用户自定义展示名。补齐后条目与 emit 输出逐字节一致。
- `--fill` 仅支持 opencode / pi；对 codex / claude 传 `--fill` 直接报「不支持」并以 exit 2 退出。
- `--json` 输出的 plan 新增 `fill: true/false` 字段。
- 补齐后再次运行 `--fill` 计划为 0 项（幂等）。

## 数据

- 收录云知声 `u2-flash`（厂商前缀 `unisound` 并入匹配表）。

## 质量

- 新增 `test/fix-fill.test.mjs`：覆盖 name-only 补齐、null 不臆造、未传 `--fill` 输出不变、
  codex/claude 不支持、fill 幂等。
- 新增 `test/ui-local-config.test.mjs` / `test/ui-api.test.mjs`：本机配置查阅脱敏、注入官网规格、
  备份、空供应商删除、片段编辑沿用原 key。
- 未开 `--fill` 时输出与旧版逐字节一致（不变量 3）。
- 单测 91 → **103** 例。

## 安装

```bash
npm install -g --install-links=true "github:xlong-c/apifix#v0.2.3"
apifix --ui
apifix fix opencode --fill --dry-run
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
