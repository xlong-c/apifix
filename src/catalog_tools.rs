//! catalog/ ↔ catalog.json 的构建与校验。
//!
//! 这是原 `tools/build-catalog.mjs` 与 `tools/validate-catalog.mjs` 的 Rust 移植，
//! 行为（顺序、字节输出、报错文案、退出码）与原脚本保持一致：
//!
//! * `catalog/` 是唯一数据源（一厂商一文件，人工编辑这里）；
//! * `catalog.json` 是生成物，由 `catalog build` 打包；
//! * `catalog validate` 校验厂商文件结构、条目 schema、全局 id 唯一、来源白名单，
//!   并确认 `catalog.json` 与 `catalog/` 完全一致。
//!
//! 顺序由 `catalog/.order.json` 固定（缺失时从现有 `catalog.json` 推导，再把
//! 未出现的文件按字典序追加到末尾）。

use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const CATALOG_VERSION: u64 = 2;
pub const ORDER_FILE: &str = ".order.json";

// ---------------------------------------------------------------------------
// schema 词表（对应 tools/schema.mjs）
// ---------------------------------------------------------------------------

/// catalog 条目必需的顶层键（顺序即 canonical 顺序）。
pub const REQUIRED_TOP: [&str; 21] = [
    "id",
    "vendor",
    "family",
    "api_protocol",
    "verified",
    "lifecycle",
    "lifecycle_note",
    "context_window",
    "max_output_tokens",
    "reasoning",
    "sampling",
    "tools",
    "structured_output",
    "vision",
    "pdf",
    "caching",
    "aliases",
    "legacy_ids",
    "gotchas",
    "sources",
    "confidence",
];

pub const REQUIRED_REASONING: [&str; 6] = [
    "supported",
    "effort_values",
    "default_effort",
    "summary_values",
    "can_disable",
    "thinking_budget",
];
pub const REQUIRED_SAMPLING: [&str; 3] = ["temperature", "top_p", "top_k"];
pub const REQUIRED_TOOLS: [&str; 4] = ["function_calling", "parallel", "strict", "choice_modes"];
pub const REQUIRED_CACHING: [&str; 3] = ["mode", "min_tokens", "ttl_options"];

pub const LIFECYCLE_VALUES: [&str; 4] = ["current", "legacy", "retired", "unreleased"];
pub const CONFIDENCES: [&str; 3] = ["high", "medium", "low"];

// ---------------------------------------------------------------------------
// 来源白名单（对应 tools/source-whitelist.mjs）
// ---------------------------------------------------------------------------

const OFFICIAL_DOMAINS: &[(&str, &[&str])] = &[
    ("openai", &["openai.com"]),
    ("anthropic", &["claude.com", "anthropic.com"]),
    ("google", &["google.dev", "google.com", "googleapis.com"]),
    ("deepseek", &["deepseek.com"]),
    (
        "alibaba",
        &[
            "aliyun.com",
            "alibabacloud.com",
            "aliyuncs.com",
            "qwencloud.com",
            "qianwenai.com",
        ],
    ),
    ("zhipu", &["z.ai", "bigmodel.cn"]),
    (
        "moonshot",
        &["kimi.ai", "kimi.com", "moonshot.cn", "moonshot.ai"],
    ),
    ("baidu", &["baidu.com"]),
    ("xai", &["x.ai"]),
    ("meta", &["meta.ai", "meta.com"]),
    ("mistral", &["mistral.ai"]),
    ("cohere", &["cohere.com"]),
    (
        "tencent",
        &["tencent.com", "tencent.cn", "tencentcloud.com"],
    ),
    (
        "volcengine",
        &["volcengine.com", "bytedance.com", "seed.bytedance.com"],
    ),
    ("nvidia", &["nvidia.com"]),
    ("microsoft", &["microsoft.com", "azure.com"]),
    ("amazon", &["aws.amazon.com", "amazon.com"]),
    ("minimax", &["minimax.io", "minimaxi.com", "minimax.cn"]),
    ("iflytek", &["xfyun.cn", "xf-yun.com"]),
    ("01ai", &["lingyiwanwu.com"]),
    ("ai21", &["ai21.com"]),
    ("stepfun", &["stepfun.com"]),
    ("writer", &["writer.com"]),
    ("unisound", &["unisound.com"]),
];

/// 通用托管平台：host 命中还不够，路径前缀也必须命中（vendor 必须匹配）。
const SOURCE_PATH_RULES: &[(&str, &str, &str)] = &[("alibaba", "github.com", "/QwenLM/")];

/// 拆出 host（去 www.）与 path；非法 URL 返回 None。
fn source_host(url: &str) -> Option<(String, String)> {
    // 极简 URL 解析：只接受 scheme://host[:port]/path 形态，够本规则使用。
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    // 去掉 userinfo 与端口
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    if host.is_empty() {
        return None;
    }
    let mut host = host.to_ascii_lowercase();
    if let Some(stripped) = host.strip_prefix("www.") {
        host = stripped.to_owned();
    }
    Some((host, path.to_owned()))
}

/// 该 URL 是否为 vendor 的官方来源？
pub fn is_official_source(url: &str, vendor: &str) -> bool {
    let Some((host, path)) = source_host(url) else {
        return false;
    };

    for (rule_vendor, rule_host, prefix) in SOURCE_PATH_RULES {
        if *rule_vendor != vendor {
            continue;
        }
        if (host == *rule_host || host.ends_with(&format!(".{rule_host}")))
            && path.starts_with(prefix)
        {
            return true;
        }
    }

    let Some((_, suffixes)) = OFFICIAL_DOMAINS.iter().find(|(name, _)| *name == vendor) else {
        return false;
    };
    suffixes
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

// ---------------------------------------------------------------------------
// 值辅助（对应脚本里的 isDict / isPosInt / pyRepr 等）
// ---------------------------------------------------------------------------

fn is_dict(value: &Value) -> bool {
    value.is_object()
}

/// JS `Number.isInteger(v) && typeof v !== "boolean" && v > 0`
fn is_pos_int(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return int > 0;
            }
            if let Some(uint) = number.as_u64() {
                return uint > 0;
            }
            match number.as_f64() {
                Some(float) => float.is_finite() && float > 0.0 && float.fract() == 0.0,
                None => false,
            }
        }
        _ => false,
    }
}

/// JS `typeof v === "number" && Number.isFinite(v)`
fn is_num(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        _ => false,
    }
}

fn as_f64(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

/// 数字按 JS `String(number)` 的形态输出（整数不带小数点）。
fn number_repr(number: &serde_json::Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(uint) = number.as_u64() {
        return uint.to_string();
    }
    match number.as_f64() {
        Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => {
            format!("{}", float as i64)
        }
        Some(float) => {
            let mut text = format!("{float}");
            if text.ends_with(".0") {
                text.truncate(text.len() - 2);
            }
            text
        }
        None => number.to_string(),
    }
}

/// 复刻脚本里的 `pyRepr`（仅用于报错文案）。
fn py_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::String(text) => {
            let has_single = text.contains('\'');
            let has_double = text.contains('"');
            let quote = if has_single && !has_double { '"' } else { '\'' };
            let mut out = String::new();
            out.push(quote);
            out.push_str(text);
            out.push(quote);
            out
        }
        Value::Number(number) => number_repr(number),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(py_repr).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        py_repr(&Value::String(key.clone())),
                        py_repr(value)
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

fn py_sorted_keys(keys: &[String]) -> String {
    let parts: Vec<String> = keys
        .iter()
        .map(|key| py_repr(&Value::String(key.clone())))
        .collect();
    format!("[{}]", parts.join(", "))
}

// ---------------------------------------------------------------------------
// 读取 / 排序（对应 build-catalog.mjs）
// ---------------------------------------------------------------------------

pub fn catalog_dir(root: &Path) -> PathBuf {
    root.join("catalog")
}

pub fn bundle_path(root: &Path) -> PathBuf {
    root.join("catalog.json")
}

/// catalog/ 下的厂商文件名（不含 .order.json），按文件名字典序。
pub fn list_vendor_files(dir: &Path) -> Result<Vec<String>, String> {
    let entries =
        fs::read_dir(dir).map_err(|error| format!("无法读取目录 {}: {error}", dir.display()))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取目录 {}: {error}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") && name != ORDER_FILE {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

struct VendorFile {
    vendor: String,
    updated_at: Option<String>,
    models: Vec<Value>,
}

fn read_vendor_file(dir: &Path, name: &str) -> Result<VendorFile, String> {
    let path = dir.join(name);
    let text = fs::read_to_string(&path).map_err(|error| format!("{name}: 解析失败（{error}）"))?;
    let data: Value =
        serde_json::from_str(&text).map_err(|error| format!("{name}: 解析失败（{error}）"))?;
    if !is_dict(&data) {
        return Err(format!("{name}: 顶层必须是对象"));
    }
    let vendor = match data.get("vendor") {
        Some(Value::String(vendor)) if !vendor.is_empty() => vendor.clone(),
        _ => return Err(format!("{name}: 缺少非空字符串 vendor")),
    };
    let models = match data.get("models") {
        Some(Value::Array(models)) => models.clone(),
        _ => return Err(format!("{name}: 缺少 models 数组")),
    };

    let mut mismatched = Vec::new();
    for model in &models {
        if !is_dict(model) {
            continue;
        }
        let entry_vendor = model.get("vendor").cloned().unwrap_or(Value::Null);
        if entry_vendor != Value::String(vendor.clone()) {
            let id = model.get("id").cloned().unwrap_or(Value::Null);
            let id_text = match &id {
                Value::Null => "(无 id)".to_owned(),
                other => py_repr(other),
            };
            mismatched.push(format!("{id_text}(vendor={})", py_repr(&entry_vendor)));
        }
    }
    if !mismatched.is_empty() {
        return Err(format!(
            "{name}: 条目 vendor 与文件 vendor={} 不一致：{}",
            py_repr(&Value::String(vendor.clone())),
            mismatched.join("、")
        ));
    }

    let updated_at = match data.get("updated_at") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    Ok(VendorFile {
        vendor,
        updated_at,
        models,
    })
}

fn read_order(dir: &Path) -> Option<Vec<String>> {
    let path = dir.join(ORDER_FILE);
    let text = fs::read_to_string(path).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    let order = data.get("order")?.as_array()?;
    Some(
        order
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
    )
}

/// 由现有 catalog.json 的全局顺序推导 vendor 文件顺序（首次运行用）。
fn derive_order_from_bundle(dir: &Path, root: &Path, files: &[String]) -> Option<Vec<String>> {
    let text = fs::read_to_string(bundle_path(root)).ok()?;
    let bundle: Value = serde_json::from_str(&text).ok()?;
    if !is_dict(&bundle) {
        return None;
    }
    let models = bundle.get("models")?.as_array()?;

    let mut vendor_to_file: HashMap<String, String> = HashMap::new();
    for name in files {
        if let Ok(file) = read_vendor_file(dir, name) {
            vendor_to_file.insert(file.vendor, name.clone());
        }
    }

    let mut order = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for model in models {
        if !is_dict(model) {
            continue;
        }
        let Some(Value::String(vendor)) = model.get("vendor") else {
            continue;
        };
        let Some(name) = vendor_to_file.get(vendor) else {
            continue;
        };
        if !seen.insert(name.clone()) {
            continue;
        }
        order.push(name.clone());
    }
    for name in files {
        if !seen.contains(name) {
            order.push(name.clone());
        }
    }
    Some(order)
}

/// 规范顺序：.order.json 优先（缺失则从 catalog.json 推导），未知文件追加到末尾。
fn resolve_order(dir: &Path, root: &Path, files: &[String]) -> Vec<String> {
    let order = match read_order(dir) {
        Some(order) if !order.is_empty() => order,
        _ => derive_order_from_bundle(dir, root, files).unwrap_or_else(|| files.to_vec()),
    };
    let known: HashSet<&String> = files.iter().collect();
    let mut out: Vec<String> = order
        .into_iter()
        .filter(|name| known.contains(name))
        .collect();
    for name in files {
        if !out.iter().any(|existing| existing == name) {
            out.push(name.clone());
        }
    }
    out
}

pub struct Bundle {
    pub files: Vec<String>,
    pub models: Vec<Value>,
    pub updated_at: Option<String>,
}

/// 读取 catalog/ 并按规范顺序拼出完整模型列表。
pub fn load_bundle(dir: &Path, root: &Path) -> Result<Bundle, String> {
    let files = list_vendor_files(dir)?;
    if files.is_empty() {
        return Err(format!("{} 下没有厂商文件（*.json）", dir.display()));
    }
    let order = resolve_order(dir, root, &files);
    let mut models = Vec::new();
    let mut updated_at: Option<String> = None;
    for name in &order {
        let vendor_file = read_vendor_file(dir, name)?;
        models.extend(vendor_file.models);
        if let Some(stamp) = &vendor_file.updated_at {
            // 与脚本一致：按字符串比较取最大
            updated_at = match updated_at {
                Some(current) if current >= *stamp => Some(current),
                _ => Some(stamp.clone()),
            };
        }
    }
    Ok(Bundle {
        files: order,
        models,
        updated_at,
    })
}

/// 把模型列表序列化成 catalog.json 的字节内容（2 空格缩进 + 末尾换行）。
pub fn serialize_bundle(models: &[Value], updated_at: Option<&str>) -> String {
    let mut top = Map::new();
    top.insert("version".to_owned(), Value::from(CATALOG_VERSION));
    top.insert(
        "updated_at".to_owned(),
        match updated_at {
            Some(text) => Value::String(text.to_owned()),
            None => Value::Null,
        },
    );
    top.insert("models".to_owned(), Value::Array(models.to_vec()));
    let mut text = serde_json::to_string_pretty(&Value::Object(top))
        .expect("serializing the catalog bundle cannot fail");
    text.push('\n');
    text
}

pub struct Built {
    pub content: String,
    pub models: Vec<Value>,
    pub files: Vec<String>,
    pub updated_at: Option<String>,
}

pub fn build(root: &Path) -> Result<Built, String> {
    let dir = catalog_dir(root);
    let bundle = load_bundle(&dir, root)?;
    let content = serialize_bundle(&bundle.models, bundle.updated_at.as_deref());
    Ok(Built {
        content,
        models: bundle.models,
        files: bundle.files,
        updated_at: bundle.updated_at,
    })
}

/// 原子写入（tmp + rename），避免半截文件。
fn write_bundle(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_file_name(format!(".catalog.{}.tmp", std::process::id()));
    fs::write(&tmp, content).map_err(|error| format!("写入 {} 失败: {error}", tmp.display()))?;
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入 {} 失败: {error}", path.display()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 校验（对应 validate-catalog.mjs）
// ---------------------------------------------------------------------------

struct Report {
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl Report {
    fn new() -> Self {
        Self {
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn error(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }

    fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }
}

fn check_str_list(report: &mut Report, label: &str, value: &Value) {
    if value.is_null() {
        return;
    }
    let ok = match value.as_array() {
        Some(items) => items
            .iter()
            .all(|item| item.as_str().is_some_and(|text| !text.is_empty())),
        None => false,
    };
    if !ok {
        report.error(format!(
            "{label}: 必须是字符串数组或 null，实际 {}",
            py_repr(value)
        ));
    }
}

fn check_range(report: &mut Report, label: &str, value: &Value) {
    if value.is_null() {
        return;
    }
    let items = value.as_array().filter(|items| items.len() == 2);
    let Some(items) = items.filter(|items| items.iter().all(is_num)) else {
        report.error(format!(
            "{label}: range 必须是长度 2 的数值数组或 null，实际 {}",
            py_repr(value)
        ));
        return;
    };
    if as_f64(&items[0]) > as_f64(&items[1]) {
        report.error(format!("{label}: range 下限大于上限 {}", py_repr(value)));
    }
}

fn check_cost(report: &mut Report, where_: &str, cost: &Value) {
    if cost.is_null() {
        return;
    }
    if !is_dict(cost) {
        report.error(format!(
            "{where_}.cost 必须是对象或 null，实际 {}",
            py_repr(cost)
        ));
        return;
    }

    let currency = cost.get("currency").cloned().unwrap_or(Value::Null);
    match currency.as_str() {
        Some(text) if !text.is_empty() => {
            if text != "USD" {
                report.error(format!(
                    "{where_}.cost.currency 必须是 USD（定价统一以美元记录），实际 {}",
                    py_repr(&currency)
                ));
            }
        }
        _ => report.error(format!(
            "{where_}.cost.currency 必须是非空字符串，实际 {}",
            py_repr(&currency)
        )),
    }

    let unit = cost.get("unit").cloned().unwrap_or(Value::Null);
    if unit.as_str() != Some("per_1m_tokens") {
        report.error(format!(
            "{where_}.cost.unit 必须是 \"per_1m_tokens\"，实际 {}",
            py_repr(&unit)
        ));
    }

    for key in ["input", "output", "cache_read", "cache_write"] {
        let value = cost.get(key).cloned().unwrap_or(Value::Null);
        if value.is_null() {
            continue;
        }
        if !is_num(&value) || as_f64(&value) < 0.0 {
            report.error(format!(
                "{where_}.cost.{key} 必须是非负数值或 null，实际 {}",
                py_repr(&value)
            ));
        }
    }

    let over = cost
        .get("context_over_200k")
        .cloned()
        .unwrap_or(Value::Null);
    if !over.is_null() {
        if !is_dict(&over) {
            report.error(format!(
                "{where_}.cost.context_over_200k 必须是对象或 null，实际 {}",
                py_repr(&over)
            ));
        } else {
            for key in ["input", "output"] {
                let value = over.get(key).cloned().unwrap_or(Value::Null);
                if !is_num(&value) {
                    report.error(format!(
                        "{where_}.cost.context_over_200k.{key} 必须是数值，实际 {}",
                        py_repr(&value)
                    ));
                }
            }
            for key in ["cache_read", "cache_write"] {
                let value = over.get(key).cloned().unwrap_or(Value::Null);
                if value.is_null() {
                    continue;
                }
                if !is_num(&value) || as_f64(&value) < 0.0 {
                    report.error(format!(
                        "{where_}.cost.context_over_200k.{key} 必须是非负数值或 null，实际 {}",
                        py_repr(&value)
                    ));
                }
            }
        }
    }

    let tiers = cost.get("tiers").cloned().unwrap_or(Value::Null);
    if !tiers.is_null() {
        match tiers.as_array() {
            None => report.error(format!(
                "{where_}.cost.tiers 必须是数组或 null，实际 {}",
                py_repr(&tiers)
            )),
            Some(tiers) => {
                for (index, tier) in tiers.iter().enumerate() {
                    if !is_dict(tier) {
                        report.error(format!(
                            "{where_}.cost.tiers[{index}] 必须是对象，实际 {}",
                            py_repr(tier)
                        ));
                        continue;
                    }
                    // 档位边界三种等价写法（恰好一个）
                    let has_max = tier.get("max_input").is_some_and(|value| !value.is_null());
                    let has_min = tier
                        .get("min_input_tokens")
                        .is_some_and(|value| !value.is_null());
                    let has_cond = tier.get("condition").is_some_and(|value| !value.is_null());
                    let count = usize::from(has_max) + usize::from(has_min) + usize::from(has_cond);
                    if count == 0 {
                        report.error(format!(
                            "{where_}.cost.tiers[{index}] 缺少档位边界（max_input / min_input_tokens / condition 三选一）"
                        ));
                    } else if count > 1 {
                        report.error(format!(
                            "{where_}.cost.tiers[{index}] 档位边界只能给一个（max_input / min_input_tokens / condition 三选一）"
                        ));
                    } else if has_max {
                        let value = tier.get("max_input").cloned().unwrap_or(Value::Null);
                        if !is_num(&value) || as_f64(&value) <= 0.0 {
                            report.error(format!(
                                "{where_}.cost.tiers[{index}].max_input 必须是正数值，实际 {}",
                                py_repr(&value)
                            ));
                        }
                    } else if has_min {
                        let value = tier.get("min_input_tokens").cloned().unwrap_or(Value::Null);
                        if !is_num(&value) || as_f64(&value) <= 0.0 {
                            report.error(format!(
                                "{where_}.cost.tiers[{index}].min_input_tokens 必须是正数值，实际 {}",
                                py_repr(&value)
                            ));
                        }
                    } else {
                        let value = tier.get("condition").cloned().unwrap_or(Value::Null);
                        let ok = value.as_str().is_some_and(|text| !text.trim().is_empty());
                        if !ok {
                            report.error(format!(
                                "{where_}.cost.tiers[{index}].condition 必须是非空字符串，实际 {}",
                                py_repr(&value)
                            ));
                        }
                    }
                    for key in ["input", "output"] {
                        let value = tier.get(key).cloned().unwrap_or(Value::Null);
                        if !is_num(&value) {
                            report.error(format!(
                                "{where_}.cost.tiers[{index}].{key} 必须是数值，实际 {}",
                                py_repr(&value)
                            ));
                        }
                    }
                    for key in ["cache_read", "cache_write"] {
                        let value = tier.get(key).cloned().unwrap_or(Value::Null);
                        if value.is_null() {
                            continue;
                        }
                        if !is_num(&value) || as_f64(&value) < 0.0 {
                            report.error(format!(
                                "{where_}.cost.tiers[{index}].{key} 必须是非负数值或 null，实际 {}",
                                py_repr(&value)
                            ));
                        }
                    }
                }
            }
        }
    }

    let as_of = cost.get("as_of").cloned().unwrap_or(Value::Null);
    if !as_of.is_null() && as_of.as_str().is_none() {
        report.error(format!(
            "{where_}.cost.as_of 必须是字符串或 null，实际 {}",
            py_repr(&as_of)
        ));
    }

    let sources = cost.get("sources").cloned().unwrap_or(Value::Null);
    check_str_list(report, &format!("{where_}.cost.sources"), &sources);

    let confidence = cost.get("confidence").cloned().unwrap_or(Value::Null);
    if !confidence.is_null() {
        let ok = confidence
            .as_str()
            .is_some_and(|text| CONFIDENCES.contains(&text));
        if !ok {
            report.error(format!(
                "{where_}.cost.confidence 非法 {}",
                py_repr(&confidence)
            ));
        }
    }
}

fn check_sources(report: &mut Report, model_id: &Value, vendor: &Value, sources: &Value) {
    let Some(items) = sources.as_array() else {
        return;
    };
    let (Some(model_id), Some(vendor)) = (model_id.as_str(), vendor.as_str()) else {
        return;
    };
    for source in items {
        let Some(url) = source.as_str() else {
            continue;
        };
        if !is_official_source(url, vendor) {
            report.error(format!(
                "{model_id}: sources 含非官方来源 {url}（vendor={vendor}）"
            ));
        }
    }
}

fn check_entry(report: &mut Report, entry: &Value, index: usize) {
    let mut where_ = format!("models[{index}]");
    if !is_dict(entry) {
        report.error(format!("{where_}: 条目必须是对象"));
        return;
    }
    if let Some(Value::String(model_id)) = entry.get("id") {
        where_ = format!("models[{index}] ({model_id})");
    }

    for key in REQUIRED_TOP {
        if entry.get(key).is_none() {
            report.error(format!(
                "{where_}: 缺少必需键 {}",
                py_repr(&Value::String(key.to_owned()))
            ));
        }
    }

    let model_id = entry.get("id").cloned().unwrap_or(Value::Null);
    match model_id.as_str() {
        None => report.error(format!("{where_}: id 必须是非空字符串")),
        Some(text) => {
            if text.is_empty() {
                report.error(format!("{where_}: id 必须是非空字符串"));
            } else if !is_valid_model_id(text) {
                report.error(format!("{where_}: id 含可疑字符 {}", py_repr(&model_id)));
            }
        }
    }

    let vendor = entry.get("vendor").cloned().unwrap_or(Value::Null);
    if vendor.as_str().is_none_or(str::is_empty) {
        report.error(format!("{where_}: vendor 必须是非空字符串"));
    }

    for key in ["context_window", "max_output_tokens"] {
        let value = entry.get(key).cloned().unwrap_or(Value::Null);
        if !value.is_null() && !is_pos_int(&value) {
            report.error(format!(
                "{where_}: {key} 必须是正整数或 null，实际 {}",
                py_repr(&value)
            ));
        }
    }

    let verified = entry.get("verified").cloned().unwrap_or(Value::Null);
    if !verified.is_boolean() {
        report.error(format!(
            "{where_}: verified 必须是 bool，实际 {}",
            py_repr(&verified)
        ));
    }

    let lifecycle = entry.get("lifecycle").cloned().unwrap_or(Value::Null);
    if !lifecycle.is_null() {
        let ok = lifecycle
            .as_str()
            .is_some_and(|text| LIFECYCLE_VALUES.contains(&text));
        if !ok {
            report.error(format!(
                "{where_}: lifecycle 非法 {}（允许 current/legacy/retired/unreleased/null）",
                py_repr(&lifecycle)
            ));
        }
    }

    let confidence = entry.get("confidence").cloned().unwrap_or(Value::Null);
    if !confidence.is_null() {
        let ok = confidence
            .as_str()
            .is_some_and(|text| CONFIDENCES.contains(&text));
        if !ok {
            report.error(format!(
                "{where_}: confidence 非法 {}",
                py_repr(&confidence)
            ));
        }
    }

    for key in ["vision", "pdf"] {
        let value = entry.get(key).cloned().unwrap_or(Value::Null);
        if !value.is_null() && !value.is_boolean() {
            report.error(format!(
                "{where_}: {key} 必须是 bool 或 null，实际 {}",
                py_repr(&value)
            ));
        }
    }

    let reasoning = entry.get("reasoning").cloned().unwrap_or(Value::Null);
    if !is_dict(&reasoning) {
        report.error(format!("{where_}: reasoning 必须是对象"));
    } else {
        for key in REQUIRED_REASONING {
            if reasoning.get(key).is_none() {
                report.error(format!(
                    "{where_}.reasoning: 缺少键 {}",
                    py_repr(&Value::String(key.to_owned()))
                ));
            }
        }
        for key in ["supported", "can_disable"] {
            let value = reasoning.get(key).cloned().unwrap_or(Value::Null);
            if !value.is_null() && !value.is_boolean() {
                report.error(format!("{where_}.reasoning.{key} 必须是 bool 或 null"));
            }
        }
        for key in ["effort_values", "summary_values"] {
            let value = reasoning.get(key).cloned().unwrap_or(Value::Null);
            check_str_list(report, &format!("{where_}.reasoning.{key}"), &value);
        }
        let budget = reasoning
            .get("thinking_budget")
            .cloned()
            .unwrap_or(Value::Null);
        if !budget.is_null() && !is_dict(&budget) {
            report.error(format!(
                "{where_}.reasoning.thinking_budget 必须是对象或 null，实际 {}",
                py_repr(&budget)
            ));
        } else if is_dict(&budget) {
            let allowed: HashSet<&str> =
                ["min", "max", "less_than_max_tokens"].into_iter().collect();
            let mut unknown: Vec<String> = budget
                .as_object()
                .map(|map| {
                    map.keys()
                        .filter(|key| !allowed.contains(key.as_str()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if !unknown.is_empty() {
                unknown.sort();
                report.warn(format!(
                    "{where_}.reasoning.thinking_budget 含未知键 {}",
                    py_sorted_keys(&unknown)
                ));
            }
        }
    }

    let sampling = entry.get("sampling").cloned().unwrap_or(Value::Null);
    if !is_dict(&sampling) {
        report.error(format!("{where_}: sampling 必须是对象"));
    } else {
        for name in REQUIRED_SAMPLING {
            let param = sampling.get(name).cloned().unwrap_or(Value::Null);
            if !is_dict(&param) {
                report.error(format!("{where_}.sampling.{name} 必须是对象"));
                continue;
            }
            let supported = param.get("supported").cloned().unwrap_or(Value::Null);
            if !supported.is_null() && !supported.is_boolean() {
                report.error(format!(
                    "{where_}.sampling.{name}.supported 必须是 bool 或 null"
                ));
            }
            let range = param.get("range").cloned().unwrap_or(Value::Null);
            check_range(report, &format!("{where_}.sampling.{name}.range"), &range);
        }
    }

    let tools = entry.get("tools").cloned().unwrap_or(Value::Null);
    if !is_dict(&tools) {
        report.error(format!("{where_}: tools 必须是对象"));
    } else {
        for key in REQUIRED_TOOLS {
            if tools.get(key).is_none() {
                report.error(format!(
                    "{where_}.tools: 缺少键 {}",
                    py_repr(&Value::String(key.to_owned()))
                ));
            }
        }
        for key in ["function_calling", "parallel", "strict"] {
            let value = tools.get(key).cloned().unwrap_or(Value::Null);
            if !value.is_null() && !value.is_boolean() {
                report.error(format!("{where_}.tools.{key} 必须是 bool 或 null"));
            }
        }
        let modes = tools.get("choice_modes").cloned().unwrap_or(Value::Null);
        check_str_list(report, &format!("{where_}.tools.choice_modes"), &modes);
    }

    let structured = entry
        .get("structured_output")
        .cloned()
        .unwrap_or(Value::Null);
    if !is_dict(&structured) {
        report.error(format!("{where_}: structured_output 必须是对象"));
    } else {
        let supported = structured.get("supported").cloned().unwrap_or(Value::Null);
        if !supported.is_null() && !supported.is_boolean() {
            report.error(format!(
                "{where_}.structured_output.supported 必须是 bool 或 null"
            ));
        }
    }

    let caching = entry.get("caching").cloned().unwrap_or(Value::Null);
    if !is_dict(&caching) {
        report.error(format!("{where_}: caching 必须是对象"));
    } else {
        for key in REQUIRED_CACHING {
            if caching.get(key).is_none() {
                report.error(format!(
                    "{where_}.caching: 缺少键 {}",
                    py_repr(&Value::String(key.to_owned()))
                ));
            }
        }
        let min_tokens = caching.get("min_tokens").cloned().unwrap_or(Value::Null);
        if !min_tokens.is_null() && !is_pos_int(&min_tokens) {
            report.error(format!("{where_}.caching.min_tokens 必须是正整数或 null"));
        }
        let ttl = caching.get("ttl_options").cloned().unwrap_or(Value::Null);
        check_str_list(report, &format!("{where_}.caching.ttl_options"), &ttl);
    }

    let aliases = entry.get("aliases").cloned().unwrap_or(Value::Null);
    check_str_list(report, &format!("{where_}.aliases"), &aliases);
    if let Some(items) = aliases.as_array() {
        for alias in items {
            if alias.as_str() == model_id.as_str() && !model_id.is_null() {
                report.warn(format!(
                    "{where_}: aliases 含自身 id {}（匹配无影响）",
                    py_repr(alias)
                ));
            }
        }
    }

    let legacy = entry.get("legacy_ids").cloned().unwrap_or(Value::Null);
    match legacy.as_array() {
        None => {
            if !legacy.is_null() || entry.get("legacy_ids").is_none() {
                report.error(format!("{where_}.legacy_ids 必须是数组"));
            }
        }
        Some(items) => {
            for item in items {
                let valid = is_dict(item)
                    && item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty());
                if !valid {
                    report.error(format!(
                        "{where_}.legacy_ids: 每项必须是 {{'id': str, 'note': str|null}}，实际 {}",
                        py_repr(item)
                    ));
                    continue;
                }
                let note = item.get("note").cloned().unwrap_or(Value::Null);
                if !note.is_null() && note.as_str().is_none() {
                    report.error(format!(
                        "{where_}.legacy_ids[{}].note 必须是字符串或 null",
                        item.get("id").and_then(Value::as_str).unwrap_or("")
                    ));
                }
            }
        }
    }

    let gotchas = entry.get("gotchas").cloned().unwrap_or(Value::Null);
    check_str_list(report, &format!("{where_}.gotchas"), &gotchas);

    let cost = entry.get("cost").cloned().unwrap_or(Value::Null);
    check_cost(report, &where_, &cost);

    let sources = entry.get("sources").cloned().unwrap_or(Value::Null);
    check_str_list(report, &format!("{where_}.sources"), &sources);
    if let Some(items) = sources.as_array() {
        for source in items {
            let ok = source
                .as_str()
                .is_some_and(|text| text.starts_with("http://") || text.starts_with("https://"));
            if !ok {
                report.error(format!(
                    "{where_}.sources: 非 http(s) 链接 {}",
                    py_repr(source)
                ));
            }
        }
        check_sources(report, &model_id, &vendor, &sources);
    }

    if lifecycle.as_str() == Some("unreleased") {
        let context = entry.get("context_window").cloned().unwrap_or(Value::Null);
        if is_pos_int(&context) {
            report.warn(format!(
                "{where_}: lifecycle=unreleased 但已填 context_window={}，请确认",
                number_or_text(&context)
            ));
        }
    }
}

fn number_or_text(value: &Value) -> String {
    match value {
        Value::Number(number) => number_repr(number),
        other => py_repr(other),
    }
}

/// 模型 id 允许的字符形态（字母/数字开头，后接 .:/-_ 与字母数字）。
fn is_valid_model_id(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    text.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '/' | '-' | '_'))
}

struct VendorValidation {
    models: Vec<Value>,
    files: Vec<String>,
    vendors: BTreeSet<String>,
}

fn validate_vendor_files(dir: &Path, report: &mut Report) -> Result<VendorValidation, String> {
    let files =
        list_vendor_files(dir).map_err(|error| format!("无法读取 {}: {error}", dir.display()))?;
    if files.is_empty() {
        return Err(format!("{} 下没有厂商文件（*.json）", dir.display()));
    }

    let mut models: Vec<Value> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut index = 0usize;

    for name in &files {
        let path = dir.join(name);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                report.error(format!("catalog/{name}: 不是合法 JSON（{error}）"));
                continue;
            }
        };
        let data: Value = match serde_json::from_str(&text) {
            Ok(data) => data,
            Err(error) => {
                report.error(format!("catalog/{name}: 不是合法 JSON（{error}）"));
                continue;
            }
        };
        if !is_dict(&data) {
            report.error(format!("catalog/{name}: 顶层必须是对象"));
            continue;
        }
        let vendor = match data.get("vendor") {
            Some(Value::String(vendor)) if !vendor.is_empty() => vendor.clone(),
            _ => {
                report.error(format!("catalog/{name}: 缺少非空字符串 vendor"));
                continue;
            }
        };
        if data.get("updated_at").is_none_or(Value::is_null) {
            report.warn(format!("catalog/{name}: 缺少 updated_at"));
        }
        let Some(entries) = data.get("models").and_then(Value::as_array) else {
            report.error(format!("catalog/{name}: 缺少 models 数组"));
            continue;
        };
        if entries.is_empty() {
            report.warn(format!("catalog/{name}: models 为空数组"));
        }

        for entry in entries {
            let where_ = format!("catalog/{name}[{index}]");
            if is_dict(entry) {
                let entry_vendor = entry.get("vendor").cloned().unwrap_or(Value::Null);
                if entry_vendor != Value::String(vendor.clone()) {
                    let id = entry.get("id").cloned().unwrap_or(Value::Null);
                    report.error(format!(
                        "catalog/{name}: 条目 {} 的 vendor={} 与文件 vendor={} 不一致",
                        py_repr(&id),
                        py_repr(&entry_vendor),
                        py_repr(&Value::String(vendor.clone()))
                    ));
                }
            }
            check_entry(report, entry, index);
            if let Some(Value::String(id)) = entry.get("id") {
                let low = id.to_lowercase();
                if let Some(previous) = seen.get(&low) {
                    report.error(format!(
                        "id 重复（大小写不敏感，跨文件全局唯一）：{} 与 {previous}",
                        py_repr(&Value::String(id.clone()))
                    ));
                } else {
                    seen.insert(
                        low,
                        format!("{where_} 的 {}", py_repr(&Value::String(id.clone()))),
                    );
                }
            }
            models.push(entry.clone());
            index += 1;
        }
    }

    let vendors: BTreeSet<String> = models
        .iter()
        .filter(|entry| is_dict(entry))
        .filter_map(|entry| {
            entry
                .get("vendor")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();

    Ok(VendorValidation {
        models,
        files,
        vendors,
    })
}

fn check_bundle(root: &Path, report: &mut Report) {
    let built = match build(root) {
        Ok(built) => built,
        Err(error) => {
            report.error(format!("catalog/: 打包失败（{error}）"));
            return;
        }
    };
    let path = bundle_path(root);
    let current = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => {
            report.error("catalog.json: 无法读取（应由 `apifix catalog build` 生成）");
            return;
        }
    };
    if current != built.content {
        report.error("catalog.json 与 catalog/ 不一致，请运行 `apifix catalog build`");
    }
}

fn print_report(report: &Report) {
    for item in &report.warnings {
        println!("[!] {item}");
    }
    for item in &report.errors {
        println!("[x] {item}");
    }
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

/// `apifix catalog build [--check] [--dry-run]`
pub fn command_build(root: &Path, check: bool, dry_run: bool) -> i32 {
    let built = match build(root) {
        Ok(built) => built,
        Err(error) => {
            eprintln!("[x] {error}");
            return 2;
        }
    };
    let summary = format!(
        "{} 个厂商文件、{} 条模型",
        built.files.len(),
        built.models.len()
    );

    if check {
        let current = fs::read_to_string(bundle_path(root)).ok();
        if current.as_deref() == Some(built.content.as_str()) {
            println!("[i] catalog.json 与 catalog/ 一致（{summary}）");
            return 0;
        }
        eprintln!("[x] catalog.json 与 catalog/ 不一致，请运行 npm run build");
        eprintln!("[i] catalog/: {summary}");
        return 1;
    }

    if dry_run {
        println!("[i] --dry-run：未写入 catalog.json（{summary}）");
        return 0;
    }

    if let Err(error) = write_bundle(&bundle_path(root), &built.content) {
        eprintln!("[x] {error}");
        return 2;
    }
    println!(
        "[ok] 已写入 {}（version {CATALOG_VERSION}, updated_at {}, {summary}）",
        bundle_path(root).display(),
        built.updated_at.as_deref().unwrap_or("null")
    );
    0
}

/// `apifix catalog validate [FILE]`
pub fn command_validate(root: &Path, file: Option<&str>) -> i32 {
    let mut report = Report::new();

    let Some(file) = file else {
        let result = match validate_vendor_files(&catalog_dir(root), &mut report) {
            Ok(result) => result,
            Err(error) => {
                eprintln!("[x] {error}");
                return 1;
            }
        };
        check_bundle(root, &mut report);
        if result.vendors.is_empty() {
            report.error("没有任何 vendor");
        }
        print_report(&report);
        println!(
            "[i] catalog/: {} 个厂商文件，{} 条，{} 个 vendor，{} 个 error，{} 个 warning",
            result.files.len(),
            result.models.len(),
            result.vendors.len(),
            report.errors.len(),
            report.warnings.len()
        );
        return i32::from(!report.errors.is_empty());
    };

    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("[x] 无法读取 {file}: {error}");
            return 1;
        }
    };
    let data: Value = match serde_json::from_str(&text) {
        Ok(data) => data,
        Err(error) => {
            eprintln!("[x] {file} 不是合法 JSON: {error}");
            return 1;
        }
    };
    if !is_dict(&data) {
        eprintln!("[x] {file} 顶层必须是 {{version, updated_at, models: [...]}}");
        return 1;
    }
    let Some(models) = data.get("models").and_then(Value::as_array) else {
        eprintln!("[x] {file} 顶层必须是 {{version, updated_at, models: [...]}}");
        return 1;
    };
    if models.is_empty() {
        report.error("models 为空数组");
    }

    let mut seen: HashMap<String, usize> = HashMap::new();
    for (index, entry) in models.iter().enumerate() {
        check_entry(&mut report, entry, index);
        if let Some(Value::String(id)) = entry.get("id") {
            let low = id.to_lowercase();
            match seen.get(&low) {
                Some(previous) => {
                    let previous_id = models[*previous].get("id").cloned().unwrap_or(Value::Null);
                    report.error(format!(
                        "id 重复（大小写不敏感）：{} 与 models[{previous}] 的 {}",
                        py_repr(&Value::String(id.clone())),
                        py_repr(&previous_id)
                    ));
                }
                None => {
                    seen.insert(low, index);
                }
            }
        }
    }

    let vendors: BTreeSet<String> = models
        .iter()
        .filter(|entry| is_dict(entry))
        .filter_map(|entry| {
            entry
                .get("vendor")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    if vendors.is_empty() {
        report.error("没有任何 vendor");
    }
    if data.get("version").is_none_or(Value::is_null) {
        report.warn("顶层缺少 version");
    }
    if data.get("updated_at").is_none_or(Value::is_null) {
        report.warn("顶层缺少 updated_at");
    }

    print_report(&report);
    println!(
        "[i] {file}: {} 条，{} 个 vendor，{} 个 error，{} 个 warning",
        models.len(),
        vendors.len(),
        report.errors.len(),
        report.warnings.len()
    );
    i32::from(!report.errors.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn py_repr_matches_python_style() {
        assert_eq!(py_repr(&Value::Null), "None");
        assert_eq!(py_repr(&Value::Bool(true)), "True");
        assert_eq!(py_repr(&Value::String("abc".into())), "'abc'");
        assert_eq!(py_repr(&Value::String("it's".into())), "\"it's\"");
        assert_eq!(py_repr(&Value::from(12)), "12");
        assert_eq!(
            py_repr(&Value::Array(vec![Value::from(1), Value::from(2)])),
            "[1, 2]"
        );
    }

    #[test]
    fn official_source_rules() {
        assert!(is_official_source("https://openai.com/docs", "openai"));
        assert!(is_official_source("https://www.openai.com/docs", "openai"));
        assert!(is_official_source(
            "https://platform.openai.com/x",
            "openai"
        ));
        assert!(!is_official_source("https://example.com/x", "openai"));
        // 通用托管平台需要路径前缀
        assert!(!is_official_source("https://github.com/foo/bar", "alibaba"));
        assert!(is_official_source(
            "https://github.com/QwenLM/qwen",
            "alibaba"
        ));
    }

    #[test]
    fn model_id_shape() {
        assert!(is_valid_model_id("gpt-6.1-sol"));
        assert!(is_valid_model_id("stepfun/step-5-preview"));
        assert!(!is_valid_model_id("-bad"));
        assert!(!is_valid_model_id("bad id"));
    }
}
