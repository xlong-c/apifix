# Rust + Slint Migration Implementation Plan

> **已废弃（2026-11-11）**：桌面 GUI 已从 Slint 整体迁移到 GPUI（gpui-kit）。
> 迁移设计与落地记录见 [2026-11-11-gpui-migration-design.md](2026-11-11-gpui-migration-design.md)。
> 本文保留作历史记录；其中 `ui/app.slint`、`build.rs`、Slint 依赖均已删除。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace apifix's Node CLI and browser UI with a Rust CLI and native Slint desktop application while preserving catalog data and documented behavior.

**Architecture:** A Rust library owns catalog loading, matching, rendering, emitters, config audit/fix, login, search, compare, and protocols. The CLI and Slint desktop app call that shared library. The existing `catalog/` files remain the editable source and `catalog.json` remains generated; the JSON schema is unchanged.

**Tech Stack:** Rust 1.92+, Slint 1.18, serde/serde_json, clap, TOML parser, reqwest for the explicitly user-configured login probe only.

The feature-by-feature baseline and cutover gates are recorded in docs/plans/2026-11-02-rust-slint-inventory.md.

---

### Task 1: Rust workspace and shared catalog core — partial

**Files:** Create `Cargo.toml`, `build.rs`, `src/main.rs`, `src/lib.rs`, `src/catalog.rs`, `src/matching.rs`, `src/emit.rs`, and focused Rust tests.

Port catalog loading, exact/alias/legacy/normalized matching, strict matching, cards, and existing emitters. Retain input JSON as `serde_json::Value` where it avoids lossy schema translation. Check generated strings against the current CLI for representative models.

### Task 2: Native Slint desktop workflow — implemented, visual check pending

**Files:** Create `ui/app.slint` and `src/gui.rs`.

Implement searchable/filterable model list, query suggestions, specification details, emitter selection, full/minimal mode, copy action, and multiline batch matching. Run the app and inspect the actual native window at desktop and narrow dimensions.

### Task 3: Rust CLI compatibility — partial

**Files:** Extend `src/main.rs`; add command modules and integration fixtures.

Port list/match/search/compare/audit/fix/protocols/login, preserving exit codes, stdout/stderr separation, strict config identification, credential redaction, backups, and atomic writes. Keep `apifix` as the binary name and default to CLI unless the GUI is explicitly requested.

### Task 4: Official model refresh and documentation — ongoing

**Files:** Update only verified `catalog/<vendor>.json` entries and rebuild `catalog.json`; update `README.md`, `README.en.md`, `CONTRIBUTING.md`, and CI.

Review all current vendor catalogs for official model launches absent from the snapshot. Use only first-party model/API/pricing sources; third-party candidate lists are discovery hints only. Leave undocumented values null and report the exact model/source scope.

### Task 5: Cutover and validation

Remove Node/Web runtime entry points after Rust parity is demonstrated. Update workflows to build/test Rust on Windows and Linux, and retain catalog build/validation rules. Run Cargo tests, catalog validation, CLI smoke tests, and native UI visual checks before declaring migration complete.
