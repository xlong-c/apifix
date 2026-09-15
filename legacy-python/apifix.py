#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apifix — 模型官方参数速查 + 配置片段生成器（Python 3.12 / 仅标准库）

用途：给定一个模型 id（支持中转/别名写法），打印该模型的**官网规格值**
（推理档位、上下文、最大输出、采样约束、思考预算、工具、结构化输出、缓存）
以及可直接粘贴的 opencode / pi 配置片段。

设计原则：
  * 输出的是官网规格，不复制用户本地配置里的数值（本地配置往往不准）。
  * 未文档化的值一律不猜：JSON 里为 null，文本里为「未知/not documented」。
  * 不做任何网络请求，不依赖 cc-switch。

退出码：0 成功；1 未收录；2 用法/输入错误。
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import unicodedata

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json")

VENDOR_PREFIXES = [
    "openai", "anthropic", "meta", "google", "x-ai", "xai", "deepseek",
    "moonshotai", "moonshot", "z-ai", "zhipu", "qwen", "dashscope",
    "minimax", "minimaxai", "volcengine", "volcengine-plan", "doubao",
    "tencent", "alibaba", "ark",
]

# 中转/发布渠道后缀。顺序敏感：长后缀优先。
SUFFIX_PATTERNS = [
    ("-vision-exp", re.compile(r"-vision-exp$", re.I)),
    ("-experimental", re.compile(r"-experimental$", re.I)),
    ("-expires-on-*", re.compile(r"-expires-on-[0-9a-z]+$", re.I)),
    ("-ga-*", re.compile(r"-ga-[0-9a-z]+$", re.I)),
    ("-contributor", re.compile(r"-contributor$", re.I)),
    ("-preview", re.compile(r"-preview$", re.I)),
    ("-free", re.compile(r"-free$", re.I)),
    ("-latest", re.compile(r"-latest$", re.I)),
    ("-build", re.compile(r"-build$", re.I)),
    ("-exp", re.compile(r"-exp$", re.I)),
    ("-YYYYMMDD", re.compile(r"-(19|20)\d{6}$")),
    ("-vN", re.compile(r"-v\d+$", re.I)),
]

SEP_RE = re.compile(r"[-._]")

# key 冲突（同一字符串既是某条 id 又是另一条 alias/legacy）时的类型优先级
_PRIO = {"exact": 0, "alias": 1, "legacy": 2}

PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

NULL_TEXT = "未知/not documented"
MISSING_TEXT = "unknown"

_MISSING = object()


class MatchResult:
    __slots__ = ("entry", "canonical_id", "ops", "suggestion", "score", "input_id", "kind")

    def __init__(self, entry=None, canonical_id=None, ops=None, suggestion=None,
                 score=0.0, input_id="", kind=None):
        self.entry = entry
        self.canonical_id = canonical_id
        self.ops = ops or []
        self.suggestion = suggestion
        self.score = score
        self.input_id = input_id
        self.kind = kind  # exact | alias | legacy | normalized | fuzzy

    @property
    def ok(self) -> bool:
        return self.entry is not None


# --------------------------------------------------------------------------
# 宽度处理 / 格式化
# --------------------------------------------------------------------------

def display_width(text: str) -> int:
    """东亚宽度感知的显示宽度（CJK 全角算 2）。"""
    width = 0
    for ch in text:
        if unicodedata.combining(ch):
            continue
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            width += 2
        else:
            width += 1
    return width


def pad(text: str, width: int, align: str = "left") -> str:
    gap = width - display_width(text)
    if gap <= 0:
        return text
    if align == "right":
        return " " * gap + text
    if align == "center":
        left = gap // 2
        return " " * left + text + " " * (gap - left)
    return text + " " * gap


def dig(obj, *path):
    """安全取值；缺失返回 _MISSING。"""
    cur = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return _MISSING
        cur = cur[key]
    return cur


def as_dict(value) -> dict:
    """把可能是 _MISSING / None / 非 dict 的值安全地变成 dict。"""
    return value if isinstance(value, dict) else {}


def val_or_none(entry: dict, *path):
    """取 catalog 值；缺失或 null 一律返回 None（JSON 里输出 null）。"""
    value = dig(entry, *path)
    return None if value is _MISSING else value


def fmt(value, *, missing=MISSING_TEXT, null=NULL_TEXT, yes="是", no="否"):
    if value is _MISSING:
        return missing
    if value is None:
        return null
    if value is True:
        return yes
    if value is False:
        return no
    if isinstance(value, (list, tuple)):
        return "、".join(str(v) for v in value) if value else "(空)"
    return str(value)


def fmt_num(value):
    """数字带千分位，其余走 fmt。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return fmt(value)
    return f"{value:,}"


def fmt_range(value):
    if value is _MISSING or value is None:
        return fmt(value)
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return f"[{value[0]}, {value[1]}]"
    return fmt(value)


def fmt_flag_with_note(value, constraint):
    """supported + constraint 合并展示。"""
    base = fmt(value)
    if constraint not in (_MISSING, None, ""):
        return f"{base}（{constraint}）"
    return base


# --------------------------------------------------------------------------
# catalog
# --------------------------------------------------------------------------

def load_catalog(path: str = CATALOG_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise ValueError("catalog.json 结构非法：需要 {version, models: [...]}")
    return data


def catalog_keys(models):
    """(文本, entry, 种类) 列表；种类为 exact | alias | legacy，id 优先。"""
    keys = []
    for entry in models:
        keys.append((entry.get("id", ""), entry, "exact"))
        for alias in entry.get("aliases") or []:
            if isinstance(alias, str) and alias:
                keys.append((alias, entry, "alias"))
        for legacy in entry.get("legacy_ids") or []:
            if isinstance(legacy, dict):
                lid = legacy.get("id")
                if isinstance(lid, str) and lid:
                    keys.append((lid, entry, "legacy"))
    return keys


def _sep_key(text: str) -> str:
    return SEP_RE.sub("-", text.strip().lower())


def _exact_lookup(cand: str, keys):
    """返回 (entry, kind)；未命中返回 (None, None)。

    同一字符串可能既是某条的 canonical id，又是另一条的 alias/legacy
    （目录合并后会出现这种冲突）。按文档优先级 exact > alias > legacy 取。
    """
    low = cand.lower()
    best = None
    best_prio = None
    for text, entry, kind in keys:
        if text.lower() != low:
            continue
        prio = _PRIO.get(kind, 3)
        if best_prio is None or prio < best_prio:
            best = (entry, kind)
            best_prio = prio
            if prio == 0:
                break
    return best if best is not None else (None, None)


def _sep_lookup(cand: str, sep_map):
    return sep_map.get(_sep_key(cand))


def normalize(raw: str, models):
    """逐步归一化并返回 (候选串, 操作列表) 序列，用于说明归一化过程。"""
    stages = [(raw.strip(), [])]
    cand = raw.strip()
    ops = []

    if "/" in cand:
        prefix, rest = cand.split("/", 1)
        if prefix.lower() in VENDOR_PREFIXES and rest:
            cand = rest
            ops = ops + [f"去除厂商前缀 {prefix.lower()}/"]
            stages.append((cand, list(ops)))

    changed = True
    while changed:
        changed = False
        for label, pattern in SUFFIX_PATTERNS:
            if pattern.search(cand):
                cand = pattern.sub("", cand)
                ops = ops + [f"去除 relay 后缀 {label}"]
                stages.append((cand, list(ops)))
                changed = True
                break

    if _sep_key(cand) != cand.strip().lower():
        ops = ops + ["分隔符归一化 (-/./_ 等价)"]
        stages.append((cand, list(ops)))

    return stages


def match(raw_id: str, models) -> MatchResult:
    """按「canonical id → aliases → legacy_ids → 去前缀 → 去后缀 →
    分隔符等价 → 模糊(0.75)」顺序匹配，并记录匹配类型。"""
    raw = (raw_id or "").strip()
    res = MatchResult(input_id=raw)
    if not raw:
        return res

    keys = catalog_keys(models)
    # 分隔符等价表：同一 key 出现多种类型时，优先级 exact > alias > legacy
    sep_map = {}
    sep_kinds = {}
    for text, entry, kind in keys:
        sk = _sep_key(text)
        if sk not in sep_map or _PRIO[kind] < _PRIO[sep_kinds[sk]]:
            sep_map[sk] = entry
            sep_kinds[sk] = kind

    # 第 1 阶段：原始输入（含大小写不敏感）直接命中 id / alias / legacy
    hit, kind = _exact_lookup(raw, keys)
    if hit is not None:
        res.entry = hit
        res.canonical_id = hit.get("id")
        res.kind = kind
        return res

    # 第 2 阶段：归一化后命中（去前缀/后缀/分隔符）
    for cand, ops in normalize(raw, models):
        if not ops:
            continue
        hit, kind = _exact_lookup(cand, keys)
        if hit is not None:
            res.entry = hit
            res.canonical_id = hit.get("id")
            res.ops = ops
            res.kind = "legacy" if kind == "legacy" else "normalized"
            return res
        hit = _sep_lookup(cand, sep_map)
        if hit is not None:
            sk = _sep_key(cand)
            kind = sep_kinds.get(sk)
            if kind == "legacy":
                res.entry = hit
                res.canonical_id = hit.get("id")
                res.ops = ops
                res.kind = "legacy"
                return res
            cid = (hit.get("id") or "").lower()
            if cand.strip().lower() != cid:
                ops = ops + ["分隔符等价匹配 (-/./_ 视为相同)"]
            res.entry = hit
            res.canonical_id = hit.get("id")
            res.ops = ops
            res.kind = "normalized"
            return res

    # 第 3 阶段：分隔符等价（无前缀/后缀变更）
    hit = _sep_lookup(raw, sep_map)
    if hit is not None:
        sk = _sep_key(raw)
        kind = sep_kinds.get(sk)
        cid = (hit.get("id") or "").lower()
        if kind == "legacy":
            res.entry = hit
            res.canonical_id = hit.get("id")
            res.kind = "legacy"
            return res
        if raw.strip().lower() != cid:
            res.ops = ["分隔符等价匹配 (-/./_ 视为相同)"]
        res.entry = hit
        res.canonical_id = hit.get("id")
        res.kind = "normalized"
        return res

    # 模糊兜底
    pool = sorted({text for text, _e, _k in keys if text})
    probe = _sep_key(raw)
    close = difflib.get_close_matches(probe, [_sep_key(p) for p in pool], n=1, cutoff=0.75)
    if close:
        # 找回原始大小写
        wanted = close[0]
        for p in pool:
            if _sep_key(p) == wanted:
                res.suggestion = p
                break
        res.score = difflib.SequenceMatcher(None, probe, wanted).ratio()
        res.kind = "fuzzy"
    return res


def notes_for(res: MatchResult) -> list:
    """生成 stderr 提示行（可能多条）。"""
    if not res.ok or not res.input_id:
        return []
    cid = res.canonical_id or ""
    out = []

    if res.kind == "legacy":
        out.append(f"[i] {res.input_id} 是旧版/退役 id，对应 {cid}；"
                   "中转仍在沿用，值按官网当前规格输出")
    elif res.kind == "alias":
        out.append(f"[i] {res.input_id} -> {cid}（别名解析）")
    elif res.kind == "normalized":
        detail = "；".join(res.ops) if res.ops else "归一化解析"
        out.append(f"[i] {res.input_id} -> 官网规范 id {cid}（值采用官方规格，{detail}）")

    entry = res.entry or {}
    lifecycle = dig(entry, "lifecycle")
    note = dig(entry, "lifecycle_note")
    has_note = isinstance(note, str) and bool(note)
    if lifecycle == "retired":
        if has_note:
            out.append(f"[!] {cid} {note}")
        else:
            out.append(f"[!] {cid} 官方已退役；第三方可能仍提供，参数为退役前规格")
    elif lifecycle == "unreleased":
        if has_note:
            out.append(f"[!] {cid} {note}")
        else:
            out.append(f"[!] {cid} 官方尚未发布")
    return out


def note_for(res: MatchResult) -> str | None:
    """兼容旧接口：返回第一条提示。"""
    notes = notes_for(res)
    return notes[0] if notes else None


# --------------------------------------------------------------------------
# 卡片渲染
# --------------------------------------------------------------------------

def _lines_from_rows(rows, label_w):
    out = []
    for label, value in rows:
        out.append(f"{pad(label, label_w)} │ {value}")
    return out


def render_card(entry: dict, note: str | None = None) -> str:
    eid = fmt(dig(entry, "id"))
    vendor = fmt(dig(entry, "vendor"))
    family = fmt(dig(entry, "family"))
    protocol = fmt(dig(entry, "api_protocol"))
    verified = dig(entry, "verified")
    if verified is True:
        vflag = "已核验官网"
    elif verified is False:
        vflag = "未核验 (unofficial)"
    else:
        vflag = fmt(verified)

    reasoning = as_dict(dig(entry, "reasoning"))
    sampling = as_dict(dig(entry, "sampling"))
    tools = as_dict(dig(entry, "tools"))
    caching = as_dict(dig(entry, "caching"))
    so = as_dict(dig(entry, "structured_output"))
    tb = reasoning.get("thinking_budget", _MISSING)

    temp = as_dict(sampling.get("temperature"))
    top_p = as_dict(sampling.get("top_p"))
    top_k = as_dict(sampling.get("top_k"))

    rows = [
        ("上下文窗口", fmt_num(dig(entry, "context_window"))),
        ("最大输出", fmt_num(dig(entry, "max_output_tokens"))),
        ("推理/思考", fmt(reasoning.get("supported", _MISSING))),
        ("effort 档位", fmt(reasoning.get("effort_values", _MISSING))),
        ("默认 effort", fmt(reasoning.get("default_effort", _MISSING))),
        ("可关闭思考", fmt(reasoning.get("can_disable", _MISSING))),
        ("思考预算", _fmt_budget(tb)),
        ("摘要模式", fmt(reasoning.get("summary_values", _MISSING))),
        ("temperature", fmt_flag_with_note(temp.get("supported", _MISSING), temp.get("constraint", _MISSING))),
        ("temperature 范围", fmt_range(temp.get("range", _MISSING))),
        ("top_p", fmt_flag_with_note(top_p.get("supported", _MISSING), top_p.get("constraint", _MISSING))),
        ("top_k", fmt_flag_with_note(top_k.get("supported", _MISSING), top_k.get("constraint", _MISSING))),
        ("工具调用", fmt(tools.get("function_calling", _MISSING))),
        ("并行工具", fmt(tools.get("parallel", _MISSING))),
        ("严格 schema", fmt(tools.get("strict", _MISSING))),
        ("tool_choice", fmt(tools.get("choice_modes", _MISSING))),
        ("结构化输出", fmt_flag_with_note(so.get("supported", _MISSING), so.get("mechanism", _MISSING))),
        ("视觉", fmt(dig(entry, "vision"))),
        ("PDF", fmt(dig(entry, "pdf"))),
        ("缓存模式", fmt(caching.get("mode", _MISSING))),
        ("缓存最小 token", fmt_num(caching.get("min_tokens", _MISSING))),
        ("缓存 TTL", fmt(caching.get("ttl_options", _MISSING))),
        ("服务层级", fmt(dig(entry, "service_tiers"))),
        ("别名", fmt(dig(entry, "aliases"))),
        ("数据来源", fmt(dig(entry, "data_origin"))),
        ("生命周期", _fmt_lifecycle(entry)),
        ("置信度", fmt(dig(entry, "confidence"))),
    ]

    label_w = max(display_width(r[0]) for r in rows)
    body = _lines_from_rows(rows, label_w)

    warnings = []
    gotchas = dig(entry, "gotchas")
    if isinstance(gotchas, list):
        for g in gotchas:
            warnings.append(f"[!] {g}")
    sources = dig(entry, "sources")
    if isinstance(sources, list) and sources:
        warnings.append("来源:")
        for s in sources:
            warnings.append(f"    {s}")
    if note:
        warnings.append(note)

    head = [eid, f"{vendor} / {family} · {protocol} · {vflag}"]
    if verified is False:
        head.append("[!] 该条目未与官网核验，数值仅供排查参考")

    content = head + body
    if warnings:
        content = content + ["─" * 8] + warnings

    width = max(display_width(line) for line in content) + 2
    width = max(width, 54)

    out = ["┌" + "─" * width + "┐"]
    for line in head:
        out.append("│ " + pad(line, width - 1) + "│")
    out.append("├" + "─" * width + "┤")
    for line in body:
        out.append("│ " + pad(line, width - 1) + "│")
    if warnings:
        out.append("├" + "─" * width + "┤")
        for line in warnings:
            out.append("│ " + pad(line, width - 1) + "│")
    out.append("└" + "─" * width + "┘")
    return "\n".join(out)


def _fmt_lifecycle(entry: dict) -> str:
    lifecycle = dig(entry, "lifecycle")
    note = dig(entry, "lifecycle_note")
    base = fmt(lifecycle)
    if isinstance(note, str) and note:
        return f"{base}（{note}）"
    legacy = dig(entry, "legacy_ids")
    if isinstance(legacy, list) and legacy:
        ids = [str(x.get("id")) for x in legacy if isinstance(x, dict) and x.get("id")]
        if ids:
            return f"{base}（含 legacy id: {'、'.join(ids)}）"
    return base


def _fmt_budget(tb):
    if tb is _MISSING:
        return MISSING_TEXT
    if tb is None:
        return NULL_TEXT
    if isinstance(tb, dict):
        parts = []
        if tb.get("min") is not None:
            parts.append(f"min={tb['min']}")
        if tb.get("max") is not None:
            parts.append(f"max={tb['max']}")
        if tb.get("less_than_max_tokens") is True:
            parts.append("< max_tokens")
        return "、".join(parts) if parts else "已文档化（无具体数值）"
    return fmt(tb)


# --------------------------------------------------------------------------
# emit: opencode / pi （主要输出）
# --------------------------------------------------------------------------

def best_effort(entry: dict):
    """有文档的 effort 里挑一个最合理的；无法确定返回 None。"""
    reasoning = dig(entry, "reasoning")
    if not isinstance(reasoning, dict):
        return None
    efforts = reasoning.get("effort_values")
    if not isinstance(efforts, list) or not efforts:
        return None
    default = reasoning.get("default_effort")
    if default in efforts:
        return default
    for candidate in ("high", "medium", "low", "xhigh", "max", "minimal", "none"):
        if candidate in efforts:
            return candidate
    return efforts[0]


def build_opencode(entry: dict, key: str, name: str) -> str:
    reasoning = as_dict(dig(entry, "reasoning"))
    tools = as_dict(dig(entry, "tools"))
    sampling = as_dict(dig(entry, "sampling"))
    temp = as_dict(sampling.get("temperature"))

    payload = {
        "attachment": val_or_none(entry, "vision"),
        "limit": {
            "context": val_or_none(entry, "context_window"),
            "output": val_or_none(entry, "max_output_tokens"),
        },
        "name": name,
        "reasoning": reasoning.get("supported"),
        "temperature": temp.get("supported"),
        "tool_call": tools.get("function_calling"),
    }

    efforts = reasoning.get("effort_values")
    if isinstance(efforts, list) and efforts:
        payload["variants"] = {e: {"reasoningEffort": e} for e in efforts}

    return json.dumps({key: payload}, ensure_ascii=False, indent=2, sort_keys=True)


def build_pi(entry: dict, key: str, name: str) -> str:
    reasoning = as_dict(dig(entry, "reasoning"))
    supported = reasoning.get("supported")
    efforts = reasoning.get("effort_values")
    efforts = efforts if isinstance(efforts, list) else []

    level_map = {lvl: (lvl if (supported and lvl in efforts) else None) for lvl in PI_LEVELS}

    inputs = ["text", "image"] if dig(entry, "vision") is True else ["text"]

    payload = {
        "id": key,
        "name": name,
        "reasoning": supported,
        "input": inputs,
        "contextWindow": val_or_none(entry, "context_window"),
        "maxTokens": val_or_none(entry, "max_output_tokens"),
        "thinkingLevelMap": level_map,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------
# emit: 次要目标（best-effort）
# --------------------------------------------------------------------------

def build_codex(entry: dict, key: str, name: str) -> str:
    effort = best_effort(entry)
    lines = [f'model = "{key}"']
    if effort:
        lines.append(f'model_reasoning_effort = "{effort}"')
    else:
        lines.append('# model_reasoning_effort = 未知，需确认（该模型未文档化 reasoning effort 档位）')
    return "\n".join(lines)


def build_claude_env(entry: dict, key: str, name: str) -> str:
    reasoning = as_dict(dig(entry, "reasoning"))
    lines = [f"ANTHROPIC_MODEL={key}"]

    tb = reasoning.get("thinking_budget", _MISSING)
    if isinstance(tb, dict) and tb.get("min") is not None:
        lines.append(f"MAX_THINKING_TOKENS={tb['min']}")
    else:
        lines.append("# MAX_THINKING_TOKENS=未知，需确认（该模型未文档化 thinking budget）")

    if reasoning.get("supported") is False:
        lines.append("# CLAUDE_CODE_EFFORT_LEVEL=不适用（该模型不支持推理）")
    else:
        effort = best_effort(entry)
        if effort:
            lines.append(f"CLAUDE_CODE_EFFORT_LEVEL={effort}")
        else:
            lines.append("# CLAUDE_CODE_EFFORT_LEVEL=未知，需确认（该模型未文档化 effort 档位）")
    return "\n".join(lines)


BASE_URL_ENV = {
    "anthropic_messages": ("ANTHROPIC_BASE_URL", "/v1/messages"),
    "responses": ("OPENAI_BASE_URL", "/v1/responses"),
    "chat_completions": ("OPENAI_BASE_URL", "/v1/chat/completions"),
    "gemini": ("GEMINI_BASE_URL", "/v1beta/models/{model}:generateContent"),
    "native": ("BASE_URL", "/v1/complete"),
}


def build_curl(entry: dict, key: str, name: str) -> str:
    protocol = dig(entry, "api_protocol")
    protocol = protocol if isinstance(protocol, str) else "chat_completions"
    env, path = BASE_URL_ENV.get(protocol, ("BASE_URL", "/v1/chat/completions"))
    path = path.format(model=key)

    if protocol == "anthropic_messages":
        max_tokens = val_or_none(entry, "max_output_tokens")
        if isinstance(max_tokens, int):
            head = [f"MAX_TOKENS={max_tokens}  # 官网 max_output_tokens"]
            body = '{"model":"%s","max_tokens":${MAX_TOKENS},"messages":[{"role":"user","content":"hi"}]}' % key
        else:
            head = ["MAX_TOKENS=4096  # 未知，需确认：官方未文档化 max_output_tokens，请填入实际值"]
            body = '{"model":"%s","max_tokens":${MAX_TOKENS},"messages":[{"role":"user","content":"hi"}]}' % key
        escaped = body.replace('"', '\\"')
        return "\n".join(head + [
            f'curl -sS "${env}{path}" \\',
            '  -H "x-api-key: $ANTHROPIC_API_KEY" \\',
            '  -H "anthropic-version: 2023-06-01" \\',
            '  -H "content-type: application/json" \\',
            f'  -d "{escaped}"',
        ])

    if protocol == "gemini":
        return "\n".join([
            f'curl -sS "${env}{path}?key=$GEMINI_API_KEY" \\',
            '  -H "content-type: application/json" \\',
            "  -d '{\"contents\":[{\"parts\":[{\"text\":\"hi\"}]}]}'",
        ])

    # chat_completions / responses / native
    effort = best_effort(entry)
    if protocol == "responses":
        extra = f',"reasoning":{{"effort":"{effort}"}}' if effort else ""
        payload = f'{{"model":"{key}","input":"hi"{extra}}}'
    else:
        extra = f',"reasoning_effort":"{effort}"' if effort else ""
        payload = f'{{"model":"{key}","messages":[{{"role":"user","content":"hi"}}]{extra}}}'
    return "\n".join([
        f'curl -sS "${env}{path}" \\',
        '  -H "Authorization: Bearer $OPENAI_API_KEY" \\',
        '  -H "content-type: application/json" \\',
        f"  -d '{payload}'",
    ])


def build_sdk(entry: dict, key: str, name: str) -> str:
    protocol = dig(entry, "api_protocol")
    protocol = protocol if isinstance(protocol, str) else "chat_completions"
    effort = best_effort(entry)
    max_tokens = dig(entry, "max_output_tokens")
    max_note = "" if isinstance(max_tokens, int) else "  # 未知，需确认（官方未文档化 max_output_tokens）"
    max_value = max_tokens if isinstance(max_tokens, int) else 4096

    if protocol == "anthropic_messages":
        lines = [
            "# pip install anthropic",
            "from anthropic import Anthropic",
            "",
            "client = Anthropic()",
            "resp = client.messages.create(",
            f'    model="{key}",',
            f"    max_tokens={max_value},{max_note}",
            '    messages=[{"role": "user", "content": "hi"}],',
        ]
        if effort:
            lines.append(f'    # effort: "{effort}"（官方档位）')
        lines.append(")")
        lines.append("print(resp.content)")
        return "\n".join(lines)

    if protocol == "gemini":
        return "\n".join([
            "# pip install google-genai",
            "from google import genai",
            "",
            "client = genai.Client()",
            "resp = client.models.generate_content(",
            f'    model="{key}",',
            '    contents="hi",',
            ")",
            "print(resp.text)",
        ])

    if protocol == "responses":
        lines = [
            "# pip install openai",
            "from openai import OpenAI",
            "",
            "client = OpenAI()",
            "resp = client.responses.create(",
            f'    model="{key}",',
            '    input="hi",',
        ]
        if effort:
            lines.append(f'    reasoning={{"effort": "{effort}"}},')
        else:
            lines.append("    # reasoning=未知，需确认（官方未文档化 effort 档位）")
        lines.append(")")
        lines.append("print(resp.output_text)")
        return "\n".join(lines)

    lines = [
        "# pip install openai",
        "from openai import OpenAI",
        "",
        "client = OpenAI()  # 中转需设置 base_url",
        "resp = client.chat.completions.create(",
        f'    model="{key}",',
        '    messages=[{"role": "user", "content": "hi"}],',
    ]
    if effort:
        lines.append(f'    extra_body={{"reasoning_effort": "{effort}"}},')
    lines.append(")")
    lines.append("print(resp.choices[0].message.content)")
    return "\n".join(lines)


EMITTERS = {
    "opencode": build_opencode,
    "pi": build_pi,
    "codex": build_codex,
    "claude-env": build_claude_env,
    "curl": build_curl,
    "sdk": build_sdk,
}


# --------------------------------------------------------------------------
# --list / --match
# --------------------------------------------------------------------------

def cmd_list(models) -> str:
    by_vendor = {}
    for entry in models:
        by_vendor.setdefault(entry.get("vendor") or "unknown", []).append(entry)
    lines = []
    for vendor in sorted(by_vendor):
        lines.append(f"{vendor}")
        for entry in sorted(by_vendor[vendor], key=lambda e: e.get("id", "")):
            lifecycle = entry.get("lifecycle")
            if lifecycle == "retired":
                mark = "(retired)"
            elif lifecycle == "unreleased":
                mark = "(unreleased)"
            elif lifecycle == "legacy":
                mark = "(legacy)"
            else:
                mark = ""
            family = entry.get("family") or "?"
            ctx = entry.get("context_window")
            ctx_text = f"{ctx:,}" if isinstance(ctx, int) else "?"
            verified = "已核验" if entry.get("verified") is True else "未核验"
            marks = " ".join(x for x in (verified, mark) if x)
            lines.append(f"  {pad(entry.get('id', '?'), 28)} {pad(family, 18)} ctx={pad(ctx_text, 10)} {marks}")
    return "\n".join(lines)


def cmd_match(path: str, models):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw_lines = fh.read().splitlines()
    except OSError as exc:
        print(f"[x] 无法读取文件: {exc}", file=sys.stderr)
        return 2

    labels = {"exact": "[OK]", "alias": "[A]", "legacy": "[L]", "normalized": "[~]"}
    out = []
    unknown = 0
    for line in raw_lines:
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        res = match(text, models)
        if res.ok:
            label = labels.get(res.kind or "", "[OK]")
            if res.kind == "legacy":
                out.append(f"{label} {pad(text, 40)} -> {res.canonical_id}（旧版/退役 id）")
            elif res.kind == "normalized":
                detail = "；".join(res.ops) if res.ops else "归一化解析"
                out.append(f"{label} {pad(text, 40)} -> {res.canonical_id}（{detail}）")
            elif res.kind == "alias":
                out.append(f"{label} {pad(text, 40)} -> {res.canonical_id}（别名解析）")
            else:
                out.append(f"{label} {pad(text, 40)} -> {res.canonical_id}")
            lifecycle = dig(res.entry, "lifecycle")
            if lifecycle == "retired":
                out.append(f"     [!] {res.canonical_id} 官方已退役；第三方可能仍提供")
            elif lifecycle == "unreleased":
                out.append(f"     [!] {res.canonical_id} 官方尚未发布")
        else:
            unknown += 1
            base = "未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）"
            if res.suggestion:
                out.append(f"[?] {pad(text, 40)} -> {base} 最接近: {res.suggestion}")
            else:
                out.append(f"[?] {pad(text, 40)} -> {base}")
    print("\n".join(out))
    if unknown:
        print(f"[x] {unknown} 行未收录", file=sys.stderr)
        return 1
    return 0


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="apifix",
        description="查询模型官网参数规格，并生成 opencode / pi 等配置片段（纯本地，无网络请求）",
    )
    parser.add_argument("model_id", nargs="?", help="模型 id，可带厂商前缀/relay 后缀")
    parser.add_argument("--json", action="store_true", help="输出匹配到的 catalog 原始条目 JSON")
    parser.add_argument("--card", action="store_true", help="输出 box-drawing 规格卡片")
    parser.add_argument("--emit", choices=sorted(EMITTERS), help="输出配置片段（默认 opencode）")
    parser.add_argument("--name", metavar="DISPLAY", help="覆盖输出片段中的展示名 name")
    parser.add_argument("--canonical-id", action="store_true",
                        help="输出片段的 key/id 使用官网规范 id（默认沿用输入 id）")
    parser.add_argument("--list", action="store_true", help="列出 catalog 全部 id（按 vendor 分组）")
    parser.add_argument("--match", metavar="FILE", help="逐行读取模型 id 文件，打印匹配状态")
    parser.add_argument("--catalog", metavar="PATH", default=CATALOG_PATH, help="指定 catalog.json 路径")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    try:
        data = load_catalog(args.catalog)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[x] 读取 catalog 失败: {exc}", file=sys.stderr)
        return 2

    models = data["models"]

    if args.list:
        print(cmd_list(models))
        return 0

    if args.match:
        return cmd_match(args.match, models)

    if not args.model_id:
        build_parser().print_help(sys.stderr)
        return 2

    res = match(args.model_id, models)
    if not res.ok:
        base = "未收录（可能是旧版官方 id 或第三方专有命名，需人工确认）"
        if res.suggestion:
            print(f"[x] {args.model_id}: {base} 最接近: {res.suggestion}（score={res.score:.2f}）",
                  file=sys.stderr)
        else:
            print(f"[x] {args.model_id}: {base}", file=sys.stderr)
        return 1

    entry: dict = res.entry or {}
    notes = notes_for(res)
    for note in notes:
        print(note, file=sys.stderr)

    if args.json:
        print(json.dumps(entry, ensure_ascii=False, indent=2))
        return 0

    key: str = (res.canonical_id or args.model_id) if args.canonical_id else args.model_id.strip()
    default_name: str = (res.canonical_id or args.model_id) if args.canonical_id else args.model_id.strip()
    name: str = args.name or default_name

    emit = args.emit
    if args.card:
        print(render_card(entry, "\n".join(notes) or None))
        if emit:
            print()
    elif not emit:
        emit = "opencode"

    if emit:
        if dig(entry, "vision") is None and emit == "pi":
            print("[i] vision 未文档化，pi input 仅含 text（需人工确认）", file=sys.stderr)
        print(EMITTERS[emit](entry, key, name))
    return 0


if __name__ == "__main__":
    try:
        code = main()
        sys.stdout.flush()
        sys.exit(code)
    except BrokenPipeError:
        # 输出被 head 等提前关闭（目录变大后更常见）：
        # 把 stdout 指向 devnull，避免解释器退出时再次 flush 报错
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
