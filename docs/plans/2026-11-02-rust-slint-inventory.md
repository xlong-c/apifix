# Rust + Slint Migration Inventory

Snapshot: 2026-11-02

## Runtime and Command Coverage

| Surface | Rust + Slint status | Existing Node status |
| --- | --- | --- |
| Native desktop entry | Implemented with Slint; npm start invokes cargo run | Static browser UI retained as npm run legacy:web |
| Catalog load and filters | Embedded catalog; search, vendor, lifecycle, verified-only filters | Existing browser implementation remains |
| Model lookup and matching | Exact, alias, legacy, normalization, fuzzy and prefix suggestions | Existing shared core remains the compatibility baseline |
| Specification details | Basic and extended text card | Existing richer card remains available |
| Emitters | opencode, pi, codex, claude-env, curl, sdk; minimal/full output | Existing outputs are the byte-level comparison baseline |
| Batch matching | Slint batch view and CLI --match | Existing CLI batch matching |
| Search and compare | Rust has basic query search and context/output comparison | Node has capability filters, price sorting and usage-cost calculation |
| Audit | Not ported | JSON formats, Codex TOML and Claude env; strict model matching and redaction |
| Fix | Not ported | Structured plans, dry-run/confirmation, backup, atomic replacement, post-write audit; Codex byte-range edits |
| Protocols | Not ported | Provider protocol inference, explicit-file/default scans, pi model-store separation |
| Login | Not ported | Interactive/noninteractive OpenCode setup, silent key input, optional user-baseURL probe |
| CLI packaging | Partial | Rust binary builds; npm bin.apifix still points to apifix.mjs |
| Release workflow | Not ported | Existing release workflow still packages Node artifacts |

## Data and Existing Work

- The Rust bundle and source catalogs contain 337 models across 23 vendors; 317 are marked verified.
- Official additions in this migration: GPT-6.1 Sol/Terra; Claude Opus/Sonnet/Haiku 5.5; Kimi K3.1 Pro/Highspeed; Step 3.5 Flash, Step 3.5 Flash 2603, and Step 3.7 Flash.
- StepFun pricing is published in CNY and converted at the catalog's existing 7.2 CNY/USD fallback rate. Kimi highspeed and Claude Haiku 5.5 prices remain unknown where the official pages provide no fixed amount.
- xAI Grok 4.20 model and pricing sources were refreshed from current official pages.
- The worktree already contained user changes in lib/core.mjs, catalog/stepfun.json, and catalog.json. Those changes were preserved and included in the existing Node checks.

## Verification Snapshot

- Rust: 5 unit tests pass; Clippy passes with warnings denied; Windows release build succeeds.
- Rust/Node emitter comparison: 72 representative output cases match byte-for-byte.
- Catalog: build check passes; validation has 0 errors and one existing MAI-Thinking-1 lifecycle warning.
- Core/fallback parity: 2,696 emitter cases match; 1,008 match assertions agree.
- Existing Node suite: 88 pass, 3 fail in the pre-existing core changes (fix-extra, vendor-prefix matching, strict normalization).
- Native UI starts through npm start; screenshot-based visual inspection is still outstanding because the Computer Use native pipe was unavailable.

## Cutover Gates

1. In progress: Rust `audit` CLI and initial OpenCode/pi/Claude/generic JSON plus Codex TOML extraction are implemented with strict matching and a credential-safe report. Remaining: full comparison semantics/rendering, duplicate tracking, and exit-code parity.
2. Port fix planning/application with dry-run, confirmation, backups, atomic writes, re-audit, TOML byte preservation, and Claude env whitelist projection.
3. Port protocols and login, including the pi model-store distinction and the rule that login probes only the user-entered base URL.
4. Port full search/compare filters and formatting; add Rust integration tests for all CLI commands, exit codes, stdout/stderr separation, and credential safety.
5. Replace npm's Node binary entry and release artifacts with Rust binaries; keep the browser UI only if explicitly retained as a separate legacy tool.
6. Resolve the existing Node test failures or document them as unrelated before removing the Node compatibility baseline; verify the native window visually on desktop and narrow layouts.

## Migration Progress (2026-11-02)

- Added `cargo run -- audit <file|-> [--format ...] [--json]` for OpenCode, pi, Claude settings JSON, generic JSON/text, and Codex TOML input. Initial format-specific checks cover model limits/capabilities, effort levels, Codex wire protocol, and Claude thinking budget; duplicate ids are marked in reports.
- Added read-only Codex TOML recognition and extraction for active model, effort, and provider `wire_api`; unrelated TOML values are ignored.
- Audit uses strict model matching and only extracts known non-secret specification fields; API keys and token values never enter the report.
- Rust unit coverage is 9 tests passing; this does not establish full parity with the Node audit implementation. Node remains the compatibility entry point until all cutover gates pass.
