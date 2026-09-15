#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge_catalog.py — 把 incoming/*.json 批次合并进 catalog.json（仅标准库）。

做三件事：
  1. 读取 incoming/ 下所有批次文件（有 models 列表的）+ 现有 catalog.json；
  2. 规范化条目 schema（缺失字段补 null/[]、sampling range 字符串转数组等）；
  3. 按 id 去重并写回 catalog.json（version 2 包装）。

去重优先级：
  * catalog.json 的手工条目 优先于 批次条目（同一 id），
    但批次 verified=true 而 catalog verified 非 true 时，批次优先；
  * 批次之间：非空字段多者优先；同分时 confidence 高者优先；
  * 云镜像重复：
      - 同一 id 出现在不同 vendor 下 → 保留 id 的“原生 vendor”条目，丢弃镜像；
      - 同一 vendor 但在镜像/旧版批次里重复（western 的 anthropic/openai 为
        Azure/Bedrock 云文档口径；anthropic-2026.json 为旧版部分批次）→
        该 vendor 有专门批次时保留专门批次；
  * 其余同分情况按 原生批次 > -full 批次 > 文件名字典序 兜底。

输出：stdout 打印合并报告；catalog.json 原地更新（原子替换）。

用法：
  python3 tools/merge_catalog.py            # 合并并写回
  python3 tools/merge_catalog.py --dry-run  # 只打印报告，不写文件
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCOMING_DIR = os.path.join(ROOT, "incoming")
CATALOG_PATH = os.path.join(ROOT, "catalog.json")
UPDATED_AT = "2026-09-15"
CATALOG_VERSION = 2

CONF_RANK = {"high": 3, "medium": 2, "low": 1}
LIFECYCLES = {"current", "legacy", "retired", "unreleased"}

# 这些 vendor 在 western 批次里存在“云镜像”条目（Azure/Bedrock 口径），
# 若同一 id 在原生批次里也有，则优先原生批次（任务约定的 canonical vendor）。
MIRROR_VENDORS = {"anthropic", "openai", "xai", "meta"}

# 每个 vendor 的原生批次（同 id 同 vendor 冲突时的次级 tiebreak）
ORIGIN_BATCH = {
    "anthropic": "anthropic-2026-full.json",
    "openai": "openai-2026-full.json",
    "xai": "western-2026-full.json",
    "meta": "western-2026-full.json",
    "google": "western-2026-full.json",
    "mistral": "western-2026-full.json",
    "cohere": "western-2026-full.json",
    "amazon": "western-2026-full.json",
    "microsoft": "western-2026-full.json",
    "nvidia": "western-2026-full.json",
    "ai21": "western-2026-full.json",
    "writer": "western-2026-full.json",
    "baidu": "china-2026-full.json",
    "alibaba": "china-2026-full.json",
    "minimax": "china-2026-full.json",
    "tencent": "china-2026-full.json",
    "volcengine": "china-2026-full.json",
    "iflytek": "china-2026-full.json",
    "01ai": "china-2026-full.json",
    "deepseek": "dsk-zhipu-moonshot-2026-full.json",
    "zhipu": "dsk-zhipu-moonshot-2026-full.json",
    "moonshot": "dsk-zhipu-moonshot-2026-full.json",
}

# 模型 id 前缀 → 原生 vendor（用于识别跨 vendor 的云镜像重复）
ORIGIN_VENDOR_PREFIXES = [
    ("anthropic", ("claude-",)),
    ("openai", ("gpt-", "o1", "o3", "o4", "chatgpt-", "text-embedding-", "gpt-oss")),
    ("xai", ("grok-",)),
    ("meta", ("llama-", "llama2", "llama3")),
    ("google", ("gemini-", "palm-", "imagen-", "veo-")),
    ("mistral", ("mistral", "codestral", "ministral", "magistral", "pixtral", "devstral")),
    ("cohere", ("command", "embed-", "rerank-")),
    ("amazon", ("amazon.", "nova-", "titan-")),
    ("microsoft", ("phi-", "mai-")),
    ("nvidia", ("nvidia/", "nvidia.", "nemotron")),
    ("baidu", ("ernie-",)),
    ("alibaba", ("qwen",)),
    ("volcengine", ("doubao-",)),
    ("tencent", ("hunyuan-",)),
    ("iflytek", ("spark-",)),
    ("01ai", ("yi-",)),
    ("zhipu", ("glm-",)),
    ("moonshot", ("kimi-", "moonshot-")),
    ("deepseek", ("deepseek-",)),
    ("minimax", ("minimax-", "abab")),
    ("ai21", ("jamba-",)),
    ("writer", ("palmyra-",)),
]


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def is_blank(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def deep_non_null(value) -> int:
    """统计叶子层的非空值数量，用于比较条目信息量。"""
    if is_blank(value):
        return 0
    if isinstance(value, dict):
        return sum(deep_non_null(v) for v in value.values())
    if isinstance(value, list):
        return 1 + sum(deep_non_null(v) for v in value)
    return 1


def origin_vendor_for(model_id: str):
    low = (model_id or "").lower()
    for vendor, prefixes in ORIGIN_VENDOR_PREFIXES:
        if low.startswith(prefixes):
            return vendor
    return None


RANGE_RE = re.compile(
    r"^\s*([\[\(])\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*([\]\)])\s*$"
)


def parse_range(raw, report, where: str):
    """把 '[0,2]' / '(0,1]' 之类的字符串转成 [0,2] / [0,1]。返回 (值, note)。"""
    if raw is None:
        return None, None
    if isinstance(raw, list):
        if len(raw) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in raw):
            return list(raw), None
        report["range_bad"].append(f"{where}: 区间数组形状异常 {raw!r} → null")
        return None, f"原始区间 {raw!r} 形状异常，已置 null"
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return [raw, raw], f"原始区间为标量 {raw!r}，按 [x, x] 记录"
    if not isinstance(raw, str):
        report["range_bad"].append(f"{where}: 区间类型异常 {type(raw).__name__} → null")
        return None, f"原始区间类型异常（{type(raw).__name__}），已置 null"

    match = RANGE_RE.match(raw)
    if not match:
        report["range_bad"].append(f"{where}: 无法解析区间 {raw!r} → null")
        return None, f"原始区间字符串 {raw!r} 无法解析，已置 null"

    left, lo, hi, right = match.groups()
    lo = float(lo) if "." in lo else int(lo)
    hi = float(hi) if "." in hi else int(hi)
    if lo == int(lo):
        lo = int(lo)
    if hi == int(hi):
        hi = int(hi)
    note = None
    if left == "(" or right == ")":
        note = f'原始文档写法 "{raw}"（开区间）；端点按闭区间取值记录'
        report["range_open"].append(f"{where}: {raw!r} → [{lo}, {hi}]")
    report["range_ok"] += 1
    return [lo, hi], note


def normalize_legacy_ids(raw, report, where: str):
    out = []
    seen = set()
    for item in raw or []:
        if isinstance(item, str):
            item = {"id": item, "note": ""}
            report["legacy_coerced"].append(f"{where}: legacy_ids 字符串 {item['id']!r} → dict")
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            report["legacy_dropped"].append(f"{where}: 非法 legacy_ids 项 {item!r}")
            continue
        if item["id"] in seen:
            report["legacy_dropped"].append(f"{where}: 重复 legacy id {item['id']!r}")
            continue
        seen.add(item["id"])
        note = item.get("note")
        out.append({"id": item["id"], "note": note if isinstance(note, str) else None})
    return out


def normalize_aliases(raw, model_id, report, where: str):
    out = []
    for item in raw or []:
        if not isinstance(item, str) or not item:
            report["alias_dropped"].append(f"{where}: 非法 alias {item!r}")
            continue
        if item == model_id:
            report["self_alias"].append(f"{where}: 自身别名 {item!r}")
            continue
        if item not in out:
            out.append(item)
    return out


def normalize_thinking_budget(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        return {
            "min": raw.get("min"),
            "max": raw.get("max"),
            "less_than_max_tokens": raw.get("less_than_max_tokens"),
        }
    return raw


def normalize_sampling_param(raw, where: str, report):
    param = raw if isinstance(raw, dict) else {}
    if not isinstance(raw, dict):
        report["sampling_fixed"].append(f"{where}: sampling 项非对象 {raw!r} → 空对象")
    value, note = parse_range(param.get("range"), report, where)
    if note is None and isinstance(param.get("range_note"), str) and param["range_note"]:
        # 已转换过的条目（catalog 里的 range_note）：重复合并时保留原注释
        note = param["range_note"]
    out = {
        "supported": param.get("supported"),
        "range": value,
        "constraint": param.get("constraint") if param.get("constraint") not in ("",) else None,
    }
    if note:
        out["range_note"] = note
    return out


REQUIRED_TOP = [
    "id", "vendor", "family", "api_protocol", "verified", "lifecycle", "lifecycle_note",
    "context_window", "max_output_tokens", "reasoning", "sampling", "tools",
    "structured_output", "vision", "pdf", "caching", "aliases", "legacy_ids",
    "gotchas", "sources", "confidence",
]

# catalog 条目缺失这些键时，允许用批次条目补齐（不覆盖 catalog 已有的值）
BACKFILL_KEYS = ["lifecycle", "lifecycle_note", "legacy_ids", "aliases", "sources", "gotchas"]


def as_obj(value) -> dict:
    return value if isinstance(value, dict) else {}


def normalize_entry(raw: dict, src: str, report) -> dict:
    """把批次/目录条目规范成统一 schema。"""
    if not isinstance(raw, dict):
        report["entry_dropped"].append(f"{src}: 条目不是对象 {raw!r}")
        return {}
    model_id = raw.get("id")
    if not isinstance(model_id, str) or not model_id:
        report["entry_dropped"].append(f"{src}: 条目缺少合法 id：{raw!r}")
        return {}
    where = f"{src}:{model_id}"

    context_window = raw.get("context_window")
    if isinstance(context_window, bool) or not isinstance(context_window, int):
        if context_window is not None:
            report["type_fixed"].append(f"{where}: context_window={context_window!r} → null")
        context_window = None

    max_output = raw.get("max_output_tokens")
    if isinstance(max_output, bool) or not isinstance(max_output, int):
        if max_output is not None:
            report["type_fixed"].append(f"{where}: max_output_tokens={max_output!r} → null")
        max_output = None

    confidence = raw.get("confidence")
    if confidence not in CONF_RANK:
        if confidence is not None:
            report["type_fixed"].append(f"{where}: confidence={confidence!r} → null")
        confidence = None

    lifecycle = raw.get("lifecycle")
    if lifecycle not in LIFECYCLES:
        if lifecycle is not None:
            report["type_fixed"].append(f"{where}: lifecycle={lifecycle!r} → null")
        lifecycle = None

    reasoning = as_obj(raw.get("reasoning"))
    tools = as_obj(raw.get("tools"))
    structured = as_obj(raw.get("structured_output"))
    caching = as_obj(raw.get("caching"))
    sampling = as_obj(raw.get("sampling"))

    entry = {
        "id": model_id,
        "vendor": raw.get("vendor"),
        "family": raw.get("family"),
        "api_protocol": raw.get("api_protocol"),
        "verified": raw.get("verified") if isinstance(raw.get("verified"), bool) else None,
        "lifecycle": lifecycle,
        "lifecycle_note": raw.get("lifecycle_note") if isinstance(raw.get("lifecycle_note"), str) else None,
        "context_window": context_window,
        "max_output_tokens": max_output,
        "reasoning": {
            "supported": reasoning.get("supported") if isinstance(reasoning.get("supported"), bool) else None,
            "effort_values": reasoning.get("effort_values") if isinstance(reasoning.get("effort_values"), list) else None,
            "default_effort": reasoning.get("default_effort") if isinstance(reasoning.get("default_effort"), str) else None,
            "summary_values": reasoning.get("summary_values") if isinstance(reasoning.get("summary_values"), list) else None,
            "can_disable": reasoning.get("can_disable") if isinstance(reasoning.get("can_disable"), bool) else None,
            "thinking_budget": normalize_thinking_budget(reasoning.get("thinking_budget")),
        },
        "sampling": {
            "temperature": normalize_sampling_param(sampling.get("temperature"), f"{where}:temperature", report),
            "top_p": normalize_sampling_param(sampling.get("top_p"), f"{where}:top_p", report),
            "top_k": normalize_sampling_param(sampling.get("top_k"), f"{where}:top_k", report),
        },
        "tools": {
            "function_calling": tools.get("function_calling") if isinstance(tools.get("function_calling"), bool) else None,
            "parallel": tools.get("parallel") if isinstance(tools.get("parallel"), bool) else None,
            "strict": tools.get("strict") if isinstance(tools.get("strict"), bool) else None,
            "choice_modes": tools.get("choice_modes") if isinstance(tools.get("choice_modes"), list) else None,
        },
        "structured_output": {
            "supported": structured.get("supported") if isinstance(structured.get("supported"), bool) else None,
            "mechanism": structured.get("mechanism") if isinstance(structured.get("mechanism"), str) and structured.get("mechanism") else None,
        },
        "vision": raw.get("vision") if isinstance(raw.get("vision"), bool) else None,
        "pdf": raw.get("pdf") if isinstance(raw.get("pdf"), bool) else None,
        "caching": {
            "mode": caching.get("mode") if isinstance(caching.get("mode"), str) else None,
            "min_tokens": caching.get("min_tokens") if isinstance(caching.get("min_tokens"), int) and not isinstance(caching.get("min_tokens"), bool) else None,
            "ttl_options": caching.get("ttl_options") if isinstance(caching.get("ttl_options"), list) else None,
        },
        "aliases": normalize_aliases(raw.get("aliases"), model_id, report, where),
        "legacy_ids": normalize_legacy_ids(raw.get("legacy_ids"), report, where),
        "gotchas": [g for g in (raw.get("gotchas") or []) if isinstance(g, str)],
        "sources": [s for s in (raw.get("sources") or []) if isinstance(s, str)],
        "confidence": confidence,
    }
    missing = [k for k in REQUIRED_TOP if k not in entry]
    assert not missing, f"schema 漏字段: {missing}"
    return entry


# --------------------------------------------------------------------------
# 输入
# --------------------------------------------------------------------------

def load_inputs(report):
    """返回 (catalog_entry, [(file, entry)...])；catalog 条目也可能为空。"""
    files = sorted(glob.glob(os.path.join(INCOMING_DIR, "*.json")))
    if not files:
        print(f"[x] {INCOMING_DIR} 下没有批次文件", file=sys.stderr)
        sys.exit(2)

    batches = []  # (basename, entry)
    for path in files:
        name = os.path.basename(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            report["file_skipped"].append(f"{name}: 读取失败 {exc}")
            continue
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list) or not models:
            report["file_skipped"].append(f"{name}: 无 models 列表（候选清单/非批次文件）")
            continue
        report["files_used"].append(name)
        for raw in models:
            entry = normalize_entry(raw, name, report)
            if entry:
                batches.append((name, entry))

    catalog = []
    if os.path.exists(CATALOG_PATH):
        try:
            with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            for raw in data.get("models", []):
                entry = normalize_entry(raw, "catalog.json", report)
                if entry:
                    catalog.append(entry)
        except (OSError, json.JSONDecodeError) as exc:
            report["file_skipped"].append(f"catalog.json: 读取失败 {exc}")
    return catalog, batches


# --------------------------------------------------------------------------
# 去重
# --------------------------------------------------------------------------

def batch_sort_key(item):
    """批次候选的择优排序键（越大越优先）。"""
    name, entry = item[0], item[1]
    is_full = 1 if name.endswith("-full.json") else 0
    is_origin = 1 if ORIGIN_BATCH.get(entry.get("vendor")) == name else 0
    return (
        deep_non_null(entry),
        CONF_RANK.get(entry.get("confidence"), 0),
        is_origin,
        is_full,
        name,
    )


def merge(catalog_entries, batches, report):
    by_id = {}

    for name, entry in batches:
        by_id.setdefault(entry["id"], []).append((name, entry, "batch"))

    for entry in catalog_entries:
        by_id.setdefault(entry["id"], []).append(("catalog.json", entry, "catalog"))

    merged = []
    for model_id in sorted(by_id):
        candidates = by_id[model_id]
        origin = origin_vendor_for(model_id)
        mirror_names = set()

        # 规则 1：云镜像重复
        # 1a) 同一 id 出现在不同 vendor 下：只保留原生 vendor 的候选
        vendors = {e.get("vendor") for _n, e, _k in candidates}
        if origin and len(vendors) > 1 and origin in vendors:
            for name, entry, _kind in candidates:
                if entry.get("vendor") != origin:
                    mirror_names.add(name)
                    report["dropped"].append(
                        (model_id, f"云镜像重复：vendor={entry.get('vendor')} 非原生 vendor={origin}"
                                   f"（来源 {name}）")
                    )
            candidates = [c for c in candidates if c[1].get("vendor") == origin]

        # 1b) 同一 vendor 但来自“镜像/旧版批次”的重复条目：
        #     - western-2026-full 里的 anthropic/openai 条目是 Azure/Bedrock 云文档口径；
        #     - anthropic-2026.json 是同一 vendor 的旧版部分批次。
        #     该 vendor 有专门批次时保留专门批次，丢弃镜像。
        origin_batch = ORIGIN_BATCH.get(origin) if origin else None
        batch_names = {name for name, _e, kind in candidates if kind == "batch"}
        if origin_batch and origin_batch in batch_names and origin in MIRROR_VENDORS:
            for name, entry, kind in candidates:
                if kind != "batch" or name == origin_batch:
                    continue
                mirror_names.add(name)
                if name == "western-2026-full.json":
                    why = "云镜像重复：western 批次为 Azure/Bedrock 云文档口径"
                else:
                    why = f"重复批次：{name} 与原生批次重复（较旧/较薄）"
                report["dropped"].append(
                    (model_id, f"{why}，保留 {origin_batch}（vendor={entry.get('vendor')}）")
                )
            candidates = [c for c in candidates
                          if c[2] != "batch" or c[0] == origin_batch]

        catalog_cands = [c for c in candidates if c[2] == "catalog"]
        batch_cands = [c for c in candidates if c[2] == "batch"]
        donors = [c for c in batch_cands if c[0] not in mirror_names]

        # 规则 2：catalog 手工条目优先（批次 verified=true 且 catalog 非 true 时例外）
        winner = None
        if catalog_cands:
            cat = max(catalog_cands, key=lambda c: deep_non_null(c[1]))[1]
            if batch_cands:
                best_batch = max(batch_cands, key=batch_sort_key)
                cat_verified = cat.get("verified") is True
                batch_verified = best_batch[1].get("verified") is True
                if batch_verified and not cat_verified:
                    winner = best_batch[1]
                    report["dropped"].append(
                        (model_id, f"批次 verified=true 覆盖 catalog verified={cat.get('verified')!r}"
                                   f"（来源 {best_batch[0]}）")
                    )
                    for name, entry, _k in batch_cands:
                        if (name, entry) != (best_batch[0], best_batch[1]):
                            report["dropped"].append((model_id, f"批次内部去重：信息量/置信度较低（来源 {name}）"))
                else:
                    winner = cat
                    reason = ("catalog 手工条目优先"
                              + ("（批次 verified=true 但 catalog 同为 true）" if batch_verified else "（批次未核验）"))
                    for name, _entry, _k in batch_cands:
                        report["superseded"].append((model_id, f"{reason}；忽略批次条目（来源 {name}）"))
            else:
                winner = cat
        else:
            best_batch = max(batch_cands, key=batch_sort_key)
            winner = best_batch[1]
            for name, entry, _k in batch_cands:
                if (name, entry) == (best_batch[0], best_batch[1]):
                    continue
                if entry.get("vendor") != best_batch[1].get("vendor"):
                    reason = (f"云镜像重复：vendor={entry.get('vendor')}，"
                              f"保留 vendor={best_batch[1].get('vendor')}（来源 {best_batch[0]}）")
                else:
                    a, b = deep_non_null(entry), deep_non_null(best_batch[1])
                    if a != b:
                        reason = f"非空字段较少（{a} < {b}，来源 {best_batch[0]}）"
                    elif CONF_RANK.get(entry.get("confidence"), 0) != CONF_RANK.get(best_batch[1].get("confidence"), 0):
                        reason = (f"confidence 较低（{entry.get('confidence')} < "
                                  f"{best_batch[1].get('confidence')}，来源 {best_batch[0]}）")
                    else:
                        reason = f"同分兜底：{best_batch[0]} 优先于 {name}"
                report["dropped"].append((model_id, reason))

        # 规则 3：winner 缺失的元数据键，用最佳非镜像批次候选补齐（不覆盖已有值）
        if winner is not None and donors:
            donor = max(donors, key=batch_sort_key)
            for key in BACKFILL_KEYS:
                if is_blank(winner.get(key)) and not is_blank(donor[1].get(key)):
                    winner[key] = donor[1][key]
                    report["backfilled"].append(f"{model_id}: {key} ← {donor[0]}")

        if winner is not None:
            merged.append(winner)

    merged.sort(key=lambda e: ((e.get("vendor") or "~"), (e.get("id") or "").lower(), e.get("id") or ""))
    return merged


# --------------------------------------------------------------------------
# 报告 / 输出
# --------------------------------------------------------------------------

def new_report():
    return {
        "files_used": [], "file_skipped": [], "entry_dropped": [],
        "dropped": [], "superseded": [], "backfilled": [], "range_ok": 0,
        "range_open": [], "range_bad": [], "type_fixed": [], "sampling_fixed": [],
        "self_alias": [], "alias_dropped": [], "legacy_dropped": [], "legacy_coerced": [],
    }


def print_report(report, merged, catalog_count, batch_count):
    by_vendor = {}
    for entry in merged:
        by_vendor.setdefault(entry.get("vendor") or "unknown", []).append(entry)

    print("=" * 72)
    print("合并报告 — incoming/*.json + catalog.json → catalog.json")
    print("=" * 72)
    print(f"使用批次文件 ({len(report['files_used'])}): " + ", ".join(report["files_used"]))
    for item in report["file_skipped"]:
        print(f"  [跳过] {item}")
    print(f"catalog.json 已有条目: {catalog_count}")
    print(f"批次条目（规范化后）: {batch_count}")
    print(f"合并后总条目: {len(merged)}")
    print()
    print("按 vendor 统计:")
    for vendor in sorted(by_vendor):
        print(f"  {vendor:14} {len(by_vendor[vendor]):3}")
    print()
    print(f"去重丢弃: {len(report['dropped'])} 条")
    for model_id, reason in report["dropped"]:
        print(f"  - {model_id}: {reason}")
    if report["superseded"]:
        print()
        print(f"目录条目优先（批次同 id 未采用）: {len(report['superseded'])} 条")
        for model_id, reason in report["superseded"]:
            print(f"  - {model_id}: {reason}")
    print()
    print("规范化统计:")
    print(f"  sampling range 成功转换: {report['range_ok']}（其中开区间: {len(report['range_open'])}）")
    for item in report["range_open"][:8]:
        print(f"      {item}")
    if len(report["range_open"]) > 8:
        print(f"      ... 其余 {len(report['range_open']) - 8} 条同类")
    print(f"  sampling range 无法解析/异常: {len(report['range_bad'])}")
    for item in report["range_bad"]:
        print(f"      {item}")
    print(f"  类型修正: {len(report['type_fixed'])}")
    for item in report["type_fixed"][:10]:
        print(f"      {item}")
    print(f"  丢弃自身别名: {len(report['self_alias'])}")
    print(f"  丢弃非法/重复别名: {len(report['alias_dropped'])}")
    for item in report["alias_dropped"]:
        print(f"      {item}")
    print(f"  丢弃非法 legacy_ids: {len(report['legacy_dropped'])}")
    for item in report["legacy_dropped"]:
        print(f"      {item}")
    print(f"  非对象条目丢弃: {len(report['entry_dropped'])}")
    for item in report["entry_dropped"]:
        print(f"      {item}")
    print(f"  元数据补齐（catalog 缺失键 ← 批次）: {len(report['backfilled'])}")
    for item in report["backfilled"]:
        print(f"      {item}")
    print("=" * 72)


def write_catalog(path: str, models) -> None:
    payload = {"version": CATALOG_VERSION, "updated_at": UPDATED_AT, "models": models}
    fd, tmp = tempfile.mkstemp(prefix=".catalog.", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="合并 incoming 批次与 catalog.json（仅标准库）")
    parser.add_argument("--dry-run", action="store_true", help="只打印报告，不写 catalog.json")
    args = parser.parse_args(argv)

    report = new_report()
    catalog_entries, batches = load_inputs(report)
    merged = merge(catalog_entries, batches, report)
    print_report(report, merged, len(catalog_entries), len(batches))

    if args.dry_run:
        print("[i] --dry-run：未写入 catalog.json")
        return 0
    write_catalog(CATALOG_PATH, merged)
    print(f"[ok] 已写入 {CATALOG_PATH}（version {CATALOG_VERSION}, updated_at {UPDATED_AT}, {len(merged)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
