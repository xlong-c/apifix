#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_catalog.py — catalog.json 结构与取值校验（仅标准库，CI 使用）。

检查项：
  1. 合法 JSON，顶层为 {version, updated_at, models: [...]}；
  2. id 不重复（大小写不敏感），id/vendor 为合法字符串；
  3. 每个条目具备必需键（merge_catalog.py 的 REQUIRED_TOP schema）；
  4. 无明显畸形值：
     - context_window / max_output_tokens 为正整数或 null
     - sampling.*.range 为长度 2 的数值数组或 null（且 min <= max）
     - reasoning.effort_values / summary_values / tools.choice_modes /
       caching.ttl_options / aliases / legacy_ids / gotchas / sources 类型正确
     - verified 为 bool、lifecycle 枚举、confidence ∈ high|medium|low
     - aliases 为字符串数组；legacy_ids 为 [{"id": str, "note": str|null}]
     - sources 必须是 http(s) 链接
     - lifecycle=unreleased 的条目不应同时填满具体规格（提示级）
  5. 每个 vendor 至少 1 条。

退出码：0 通过（可能有 warning）；1 有 error。

用法：
  python3 tools/validate_catalog.py [catalog.json]
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(ROOT, "catalog.json")

REQUIRED_TOP = [
    "id", "vendor", "family", "api_protocol", "verified", "lifecycle", "lifecycle_note",
    "context_window", "max_output_tokens", "reasoning", "sampling", "tools",
    "structured_output", "vision", "pdf", "caching", "aliases", "legacy_ids",
    "gotchas", "sources", "confidence",
]
REQUIRED_REASONING = ["supported", "effort_values", "default_effort", "summary_values",
                      "can_disable", "thinking_budget"]
REQUIRED_SAMPLING = ["temperature", "top_p", "top_k"]
REQUIRED_TOOLS = ["function_calling", "parallel", "strict", "choice_modes"]
REQUIRED_CACHING = ["mode", "min_tokens", "ttl_options"]
LIFECYCLES = {"current", "legacy", "retired", "unreleased"}
CONFIDENCES = {"high", "medium", "low"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/\-]*$")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def is_pos_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_range(path, value):
    if value is None:
        return
    if not isinstance(value, list) or len(value) != 2 or not all(is_num(x) for x in value):
        err(f"{path}: range 必须是长度 2 的数值数组或 null，实际 {value!r}")
        return
    if value[0] > value[1]:
        err(f"{path}: range 下限大于上限 {value!r}")


def check_str_list(path, value):
    if value is None:
        return
    if not isinstance(value, list) or not all(isinstance(x, str) and x for x in value):
        err(f"{path}: 必须是字符串数组或 null，实际 {value!r}")


def check_entry(entry, index):
    where = f"models[{index}]"
    if not isinstance(entry, dict):
        err(f"{where}: 条目必须是对象")
        return
    model_id = entry.get("id")
    where = f"models[{index}] ({model_id})" if isinstance(model_id, str) else where

    for key in REQUIRED_TOP:
        if key not in entry:
            err(f"{where}: 缺少必需键 {key!r}")

    if not isinstance(model_id, str) or not model_id:
        err(f"{where}: id 必须是非空字符串")
    elif not ID_RE.match(model_id):
        err(f"{where}: id 含可疑字符 {model_id!r}")

    vendor = entry.get("vendor")
    if not isinstance(vendor, str) or not vendor:
        err(f"{where}: vendor 必须是非空字符串")

    for key in ("context_window", "max_output_tokens"):
        value = entry.get(key)
        if value is not None and not is_pos_int(value):
            err(f"{where}: {key} 必须是正整数或 null，实际 {value!r}")

    verified = entry.get("verified")
    if not isinstance(verified, bool):
        err(f"{where}: verified 必须是 bool，实际 {verified!r}")

    lifecycle = entry.get("lifecycle")
    if lifecycle is not None and lifecycle not in LIFECYCLES:
        err(f"{where}: lifecycle 非法 {lifecycle!r}（允许 current/legacy/retired/unreleased/null）")

    confidence = entry.get("confidence")
    if confidence is not None and confidence not in CONFIDENCES:
        err(f"{where}: confidence 非法 {confidence!r}")

    for key in ("vision", "pdf"):
        value = entry.get(key)
        if value is not None and not isinstance(value, bool):
            err(f"{where}: {key} 必须是 bool 或 null，实际 {value!r}")

    reasoning = entry.get("reasoning")
    if not isinstance(reasoning, dict):
        err(f"{where}: reasoning 必须是对象")
    else:
        for key in REQUIRED_REASONING:
            if key not in reasoning:
                err(f"{where}.reasoning: 缺少键 {key!r}")
        for key in ("supported", "can_disable"):
            value = reasoning.get(key)
            if value is not None and not isinstance(value, bool):
                err(f"{where}.reasoning.{key} 必须是 bool 或 null")
        for key in ("effort_values", "summary_values"):
            check_str_list(f"{where}.reasoning.{key}", reasoning.get(key))
        budget = reasoning.get("thinking_budget")
        if budget is not None and not isinstance(budget, dict):
            err(f"{where}.reasoning.thinking_budget 必须是对象或 null，实际 {budget!r}")
        elif isinstance(budget, dict):
            unknown = set(budget) - {"min", "max", "less_than_max_tokens"}
            if unknown:
                warn(f"{where}.reasoning.thinking_budget 含未知键 {sorted(unknown)}")

    sampling = entry.get("sampling")
    if not isinstance(sampling, dict):
        err(f"{where}: sampling 必须是对象")
    else:
        for name in REQUIRED_SAMPLING:
            param = sampling.get(name)
            if not isinstance(param, dict):
                err(f"{where}.sampling.{name} 必须是对象")
                continue
            supported = param.get("supported")
            if supported is not None and not isinstance(supported, bool):
                err(f"{where}.sampling.{name}.supported 必须是 bool 或 null")
            check_range(f"{where}.sampling.{name}.range", param.get("range"))

    tools = entry.get("tools")
    if not isinstance(tools, dict):
        err(f"{where}: tools 必须是对象")
    else:
        for key in REQUIRED_TOOLS:
            if key not in tools:
                err(f"{where}.tools: 缺少键 {key!r}")
        for key in ("function_calling", "parallel", "strict"):
            value = tools.get(key)
            if value is not None and not isinstance(value, bool):
                err(f"{where}.tools.{key} 必须是 bool 或 null")
        check_str_list(f"{where}.tools.choice_modes", tools.get("choice_modes"))

    structured = entry.get("structured_output")
    if not isinstance(structured, dict):
        err(f"{where}: structured_output 必须是对象")
    elif structured.get("supported") is not None and not isinstance(structured.get("supported"), bool):
        err(f"{where}.structured_output.supported 必须是 bool 或 null")

    caching = entry.get("caching")
    if not isinstance(caching, dict):
        err(f"{where}: caching 必须是对象")
    else:
        for key in REQUIRED_CACHING:
            if key not in caching:
                err(f"{where}.caching: 缺少键 {key!r}")
        min_tokens = caching.get("min_tokens")
        if min_tokens is not None and not is_pos_int(min_tokens):
            err(f"{where}.caching.min_tokens 必须是正整数或 null")
        check_str_list(f"{where}.caching.ttl_options", caching.get("ttl_options"))

    aliases = entry.get("aliases")
    check_str_list(f"{where}.aliases", aliases)
    if isinstance(aliases, list):
        for alias in aliases:
            if alias == model_id:
                warn(f"{where}: aliases 含自身 id {alias!r}（匹配无影响）")

    legacy = entry.get("legacy_ids")
    if legacy is None or not isinstance(legacy, list):
        err(f"{where}.legacy_ids 必须是数组")
    else:
        for item in legacy:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                err(f"{where}.legacy_ids: 每项必须是 {{'id': str, 'note': str|null}}，实际 {item!r}")
                continue
            note = item.get("note")
            if note is not None and not isinstance(note, str):
                err(f"{where}.legacy_ids[{item.get('id')}].note 必须是字符串或 null")

    check_str_list(f"{where}.gotchas", entry.get("gotchas"))

    sources = entry.get("sources")
    check_str_list(f"{where}.sources", sources)
    if isinstance(sources, list):
        for src in sources:
            if not isinstance(src, str) or not src.startswith(("http://", "https://")):
                err(f"{where}.sources: 非 http(s) 链接 {src!r}")

    if lifecycle == "unreleased" and is_pos_int(entry.get("context_window")):
        warn(f"{where}: lifecycle=unreleased 但已填 context_window={entry.get('context_window')}，请确认")


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    path = args[0] if args else DEFAULT_PATH

    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"[x] 无法读取 {path}: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"[x] {path} 不是合法 JSON: {exc}", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        print(f"[x] {path} 顶层必须是 {{version, updated_at, models: [...]}}", file=sys.stderr)
        return 1

    models = data["models"]
    if not models:
        err("models 为空数组")

    seen = {}
    for index, entry in enumerate(models):
        check_entry(entry, index)
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            low = entry["id"].lower()
            if low in seen:
                err(f"id 重复（大小写不敏感）：{entry['id']!r} 与 models[{seen[low]}] 的 {models[seen[low]].get('id')!r}")
            else:
                seen[low] = index

    vendors = {e.get("vendor") for e in models if isinstance(e, dict)}
    if not vendors:
        err("没有任何 vendor")
    if data.get("version") is None:
        warn("顶层缺少 version")
    if data.get("updated_at") is None:
        warn("顶层缺少 updated_at")

    for item in warnings:
        print(f"[!] {item}")
    for item in errors:
        print(f"[x] {item}")

    print(f"[i] {path}: {len(models)} 条，{len(vendors)} 个 vendor，"
          f"{len(errors)} 个 error，{len(warnings)} 个 warning")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
