# Release v0.2.0

> codex / claude code 全面支持：配置文件级片段（`-f`）、audit 体检与 fix 自动修复；对拍扩到 2616 组。

## 新增

### codex / claude code 的完整配置片段（`-f`）

```bash
node apifix.mjs gpt-6-astra --emit codex -f        # 完整 config.toml（model_provider + [model_providers.x]）
node apifix.mjs gpt-6-astra --emit claude-env -f   # ~/.claude/settings.json 的 env 块
```

- codex：`model` / `model_reasoning_effort` / `model_provider` + provider 段（`name` / `base_url` /
  `wire_api`）。`wire_api` 由 `api_protocol` 推导（chat_completions→`chat`、responses→`responses`），
  无法映射（native / gemini / anthropic_messages）时输出注释说明、不臆造。
- claude：`settings.json` 的 `env` 块（`ANTHROPIC_MODEL` / `MAX_THINKING_TOKENS` /
  `CLAUDE_CODE_EFFORT_LEVEL`，值均为字符串）；官网未文档化的字段整键省略，stderr 说明。
- `base_url` / `env_key` / `ANTHROPIC_AUTH_TOKEN` 一律输出**占位符**（不联网、不臆造），替换后再用。
- **精简输出（不带 `-f`）逐字节不变**：327 条模型 × 2 目标的输出与升级前逐字节一致。

### `audit` / `fix` 支持 codex 与 claude

```bash
node apifix.mjs audit ~/.codex/config.toml        # 也可直接审 ~/.claude/settings.json
node apifix.mjs fix codex                          # TOML 行级回写：注释/缩进/CRLF 全保留
node apifix.mjs fix claude                         # AUTH_TOKEN 永不读写，只改白名单键
```

- 格式：`--format {auto,opencode,pi,codex,claude,generic}`（`claude-env` 为 claude 别名）；
  auto 识别按 `.toml` 后缀与内容特征（含 `env` 块 → claude）。
- audit 校验项：codex 的 `model_reasoning_effort`（是否属于官方档位）与生效 provider 的 `wire_api`
  （是否与官方协议一致）；claude 的 `CLAUDE_CODE_EFFORT_LEVEL`（档位成员）与 `MAX_THINKING_TOKENS`
  （是否落在官方 thinking budget 区间）。
- fix 只改官网已文档化的字段：非官方档位 → 改为官方 `default_effort`；`wire_api` 不符 → 改写；
  `MAX_THINKING_TOKENS` 越界 → 收窄到官方区间。未声明字段绝不新增；官网未文档化一律跳过并注明。
- 凭证纪律：claude 的 `ANTHROPIC_AUTH_TOKEN` 在任何输出（含 `--json`）中都不出现，
  只以占位符形态出现在 `-f` 片段里。

## 质量与工程化

- **对拍扩到 4 emitter**：core 与 UI fallback 的逐字节对拍从 1300 组扩到 **2616 组**
  （327 模型 × opencode/pi/codex/claude-env × 精简/完整）。
- 新增 15 例单测：emit 契约（全量形状 + 精确快照）、audit（识别/差异/exit code/不回显原文）、
  fix round-trip（逐字节保真、CRLF、注释、幂等、凭证不动）。
- CI 冒烟补 codex/claude：`--emit codex|claude-env -f`，以及两个新夹具的 fix → audit 全流程。
- UI：配置片段新增 codex / claude 两个 tab，完整模式给出占位符提示。

## 安装

```bash
npm install -g --install-links=true github:xlong-c/apifix
apifix gpt-6-astra
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
