use crate::matching::{MatchKind, match_model};
use serde_json::{Map, Value, json};

#[derive(Clone, Debug)]
struct Entry {
    input: String,
    provider: Option<String>,
    values: Map<String, Value>,
}

fn number(value: &Value) -> Option<Value> {
    match value {
        Value::Number(_) => Some(value.clone()),
        Value::String(text) => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number),
        _ => None,
    }
}

fn boolean(value: &Value) -> Option<Value> {
    match value {
        Value::Bool(_) => Some(value.clone()),
        Value::String(text) if text.eq_ignore_ascii_case("true") => Some(Value::Bool(true)),
        Value::String(text) if text.eq_ignore_ascii_case("false") => Some(Value::Bool(false)),
        _ => None,
    }
}

fn string_array(value: &Value) -> Option<Value> {
    value.as_array().map(|items| {
        Value::Array(
            items
                .iter()
                .filter_map(|item| item.as_str().map(|s| Value::String(s.to_owned())))
                .collect(),
        )
    })
}

fn insert_num(values: &mut Map<String, Value>, key: &str, value: &Value) {
    if let Some(value) = number(value) {
        values.insert(key.into(), value);
    }
}

fn insert_bool(values: &mut Map<String, Value>, key: &str, value: &Value) {
    if let Some(value) = boolean(value) {
        values.insert(key.into(), value);
    }
}

fn detect_format(config: &Value) -> Option<&'static str> {
    let object = config.as_object()?;
    if object.get("provider").is_some_and(Value::is_object) {
        return Some("opencode");
    }
    if object
        .get("providers")
        .and_then(Value::as_object)
        .is_some_and(|providers| {
            providers
                .values()
                .any(|provider| provider["models"].is_array())
        })
    {
        return Some("pi");
    }
    if object.get("models").is_some_and(Value::is_array) || config.is_array() {
        return Some("generic");
    }
    if let Some(env) = object.get("env").and_then(Value::as_object)
        && env.keys().any(|key| {
            matches!(
                key.as_str(),
                "ANTHROPIC_MODEL"
                    | "ANTHROPIC_DEFAULT_OPUS_MODEL"
                    | "ANTHROPIC_DEFAULT_SONNET_MODEL"
                    | "ANTHROPIC_DEFAULT_HAIKU_MODEL"
            )
        })
    {
        return Some("claude");
    }
    None
}

fn parse_codex_toml(text: &str) -> Value {
    let mut root = Map::new();
    let mut providers = Map::new();
    let mut active_provider = None::<String>;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let section = &line[1..line.len() - 1];
            active_provider = section
                .strip_prefix("model_providers.")
                .map(|name| name.trim_matches(['"', '\'']).to_owned());
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let raw = raw.trim();
        let mut quoted = false;
        let mut escaped = false;
        let mut end = raw.len();
        for (index, ch) in raw.char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' && quoted {
                escaped = true;
            } else if ch == '"' {
                quoted = !quoted;
            } else if ch == '#' && !quoted {
                end = index;
                break;
            }
        }
        let raw = raw[..end].trim();
        let value = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            raw[1..raw.len() - 1].to_owned()
        } else {
            raw.split_once('#')
                .map_or(raw, |(head, _)| head)
                .trim()
                .to_owned()
        };
        if let Some(provider) = &active_provider {
            if matches!(key, "name" | "wire_api" | "base_url") {
                providers
                    .entry(provider.clone())
                    .or_insert_with(|| Value::Object(Map::new()))[key] = json!(value);
            }
        } else if matches!(key, "model" | "model_provider" | "model_reasoning_effort") {
            root.insert(key.to_owned(), json!(value));
        }
    }
    root.insert("providers".into(), Value::Object(providers));
    Value::Object(root)
}

fn extract(config: &Value, format: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    match format {
        "opencode" => {
            if let Some(providers) = config["provider"].as_object() {
                for (provider_name, provider) in providers {
                    if let Some(models) = provider["models"].as_object() {
                        for (model_id, raw) in models {
                            let mut values = Map::new();
                            insert_num(&mut values, "context", &raw["limit"]["context"]);
                            insert_num(&mut values, "output", &raw["limit"]["output"]);
                            insert_bool(&mut values, "reasoning", &raw["reasoning"]);
                            insert_bool(&mut values, "temperature", &raw["temperature"]);
                            insert_bool(&mut values, "tool_call", &raw["tool_call"]);
                            insert_bool(&mut values, "attachment", &raw["attachment"]);
                            if let Some(variants) = raw["variants"].as_object() {
                                let efforts = variants
                                    .values()
                                    .filter_map(|v| v["reasoningEffort"].as_str())
                                    .collect::<Vec<_>>();
                                if !efforts.is_empty() {
                                    let mut efforts = efforts;
                                    efforts.sort_unstable();
                                    values.insert("efforts".into(), json!(efforts));
                                }
                            }
                            out.push(Entry {
                                input: model_id.clone(),
                                provider: Some(provider_name.clone()),
                                values,
                            });
                        }
                    }
                }
            }
        }
        "pi" => {
            if let Some(providers) = config["providers"].as_object() {
                for (provider_name, provider) in providers {
                    if let Some(models) = provider["models"].as_array() {
                        for raw in models {
                            let Some(model_id) = raw["id"].as_str().filter(|s| !s.is_empty())
                            else {
                                continue;
                            };
                            let mut values = Map::new();
                            insert_num(&mut values, "context", &raw["contextWindow"]);
                            insert_num(&mut values, "output", &raw["maxTokens"]);
                            insert_bool(&mut values, "reasoning", &raw["reasoning"]);
                            if let Some(input) = string_array(&raw["input"]) {
                                values.insert("input".into(), input);
                            }
                            if let Some(map) = raw["thinkingLevelMap"].as_object() {
                                let mut efforts =
                                    map.values().filter_map(Value::as_str).collect::<Vec<_>>();
                                efforts.sort_unstable();
                                efforts.dedup();
                                if !efforts.is_empty() {
                                    values.insert("efforts".into(), json!(efforts));
                                }
                            }
                            out.push(Entry {
                                input: model_id.into(),
                                provider: Some(provider_name.clone()),
                                values,
                            });
                        }
                    }
                }
            }
        }
        "claude" => {
            if let Some(env) = config["env"].as_object() {
                let effort = env.get("CLAUDE_CODE_EFFORT_LEVEL").and_then(Value::as_str);
                let budget = env.get("MAX_THINKING_TOKENS").and_then(number);
                for key in [
                    "ANTHROPIC_MODEL",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                ] {
                    if let Some(model_id) = env
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        let mut values = Map::new();
                        if key == "ANTHROPIC_MODEL" {
                            if let Some(value) = effort {
                                values.insert("effort".into(), json!(value));
                            }
                            if let Some(value) = &budget {
                                values.insert("budget".into(), value.clone());
                            }
                        }
                        out.push(Entry {
                            input: model_id.into(),
                            provider: Some(key.into()),
                            values,
                        });
                    }
                }
            }
        }
        "codex" => {
            if let Some(model_id) = config["model"].as_str().filter(|id| !id.is_empty()) {
                let provider = config["model_provider"].as_str().map(str::to_owned);
                let mut values = Map::new();
                if let Some(effort) = config["model_reasoning_effort"].as_str() {
                    values.insert("effort".into(), json!(effort));
                }
                if let Some(wire) = provider
                    .as_ref()
                    .and_then(|name| config["providers"][name]["wire_api"].as_str())
                {
                    values.insert("wire_api".into(), json!(wire));
                }
                out.push(Entry {
                    input: model_id.into(),
                    provider,
                    values,
                });
            }
        }
        "generic" => {
            let items = config.as_array().or_else(|| config["models"].as_array());
            if let Some(items) = items {
                for item in items {
                    let id = item.as_str().or_else(|| item["id"].as_str());
                    if let Some(id) = id.filter(|s| !s.trim().is_empty()) {
                        out.push(Entry {
                            input: id.trim().into(),
                            provider: None,
                            values: Map::new(),
                        });
                    }
                }
            } else if let Some(text) = config.as_str() {
                for line in text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                {
                    out.push(Entry {
                        input: line.into(),
                        provider: None,
                        values: Map::new(),
                    });
                }
            }
        }
        _ => {}
    }
    out
}

fn compare(field: &str, configured: Option<&Value>, official: &Value) -> Option<Value> {
    let Some(configured) = configured else {
        if official.is_null() || official.as_array().is_some_and(Vec::is_empty) {
            return None;
        }
        return Some(
            json!({"field": field, "config": null, "official": official, "status": "missing", "note": "缺失（配置未声明）"}),
        );
    };
    if official.is_null() {
        return Some(
            json!({"field": field, "config": configured, "official": null, "status": "unknown", "note": "官网未文档化"}),
        );
    }
    let equal = if configured.is_number() && official.is_number() {
        configured.as_f64() == official.as_f64()
    } else if let (Some(configured), Some(official)) = (configured.as_array(), official.as_array())
    {
        let mut configured = configured.clone();
        let mut official = official.clone();
        configured.sort_by_key(Value::to_string);
        official.sort_by_key(Value::to_string);
        configured == official
    } else {
        configured == official
    };
    if equal {
        Some(
            json!({"field": field, "config": configured, "official": official, "status": "match", "note": null}),
        )
    } else {
        Some(
            json!({"field": field, "config": configured, "official": official, "status": "diff", "note": "与官网规格不一致"}),
        )
    }
}

fn compare_member(field: &str, configured: Option<&Value>, official: &Value) -> Option<Value> {
    let Some(configured) = configured else {
        return compare(field, None, official);
    };
    if official.is_null() {
        return compare(field, Some(configured), official);
    }
    let accepted = official
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value == configured));
    Some(
        json!({"field":field, "config":configured, "official":official, "status":if accepted {"match"} else {"diff"}, "note":if accepted {Value::Null} else {json!("不在官方档位")}}),
    )
}

fn compare_budget(configured: Option<&Value>, official: &Value) -> Option<Value> {
    let Some(configured) = configured else {
        if official["min"].is_number() || official["max"].is_number() {
            return Some(
                json!({"field":"budget", "config":null, "official":official, "status":"missing", "note":"缺失（配置未声明）"}),
            );
        }
        return None;
    };
    let (Some(value), Some(bounds)) = (
        number(configured).and_then(|v| v.as_f64()),
        official.as_object(),
    ) else {
        return Some(
            json!({"field":"budget", "config":configured, "official":official, "status":"unknown", "note":"官网未文档化"}),
        );
    };
    let min = bounds.get("min").and_then(Value::as_f64);
    let max = bounds.get("max").and_then(Value::as_f64);
    if min.is_none() && max.is_none() {
        return Some(
            json!({"field":"budget", "config":configured, "official":null, "status":"unknown", "note":"官网未文档化"}),
        );
    }
    let matches = min.is_none_or(|min| value >= min) && max.is_none_or(|max| value <= max);
    Some(
        json!({"field":"budget", "config":configured, "official":official, "status":if matches {"match"} else {"diff"}, "note":if matches {Value::Null} else {json!("超出官方 thinking budget 区间")}}),
    )
}

pub fn audit(models: &[Value], config: &Value, requested: &str) -> Result<Value, String> {
    let toml_input = requested == "codex"
        || (requested == "auto"
            && config.as_str().is_some_and(|text| {
                text.lines().any(|line| {
                    let line = line.trim_start();
                    line.starts_with("model =") || line.starts_with("[model_providers.")
                })
            }));
    let parsed_codex;
    let config = if toml_input {
        parsed_codex = parse_codex_toml(config.as_str().unwrap_or_default());
        &parsed_codex
    } else {
        config
    };
    let format = if toml_input {
        "codex"
    } else if requested == "auto" {
        detect_format(config).ok_or("无法识别配置格式")?
    } else {
        requested
    };
    let entries = extract(config, format);
    if entries.is_empty() {
        return Err("未从配置中提取到任何模型条目".into());
    }
    let mut rows = Vec::new();
    let mut seen = std::collections::HashMap::<String, usize>::new();
    let mut unmatched = 0;
    let mut with_diffs = 0;
    let mut diff_items = 0;
    for entry in entries {
        *seen.entry(entry.input.clone()).or_default() += 1;
        let matched = match_model(models, &entry.input, true);
        let mut diffs = Vec::new();
        if let Some(model) = matched.model {
            if format == "opencode" || format == "pi" {
                for (field, official) in [
                    ("context", &model["context_window"]),
                    ("output", &model["max_output_tokens"]),
                    ("reasoning", &model["reasoning"]["supported"]),
                ] {
                    if let Some(diff) = compare(field, entry.values.get(field), official) {
                        diffs.push(diff);
                    }
                }
                if let Some(diff) = compare(
                    "efforts",
                    entry.values.get("efforts"),
                    &model["reasoning"]["effort_values"],
                ) {
                    diffs.push(diff);
                }
            }
            if format == "opencode" {
                for (field, official) in [
                    (
                        "temperature",
                        &model["sampling"]["temperature"]["supported"],
                    ),
                    ("tool_call", &model["tools"]["function_calling"]),
                    ("attachment", &model["vision"]),
                ] {
                    if let Some(diff) = compare(field, entry.values.get(field), official) {
                        diffs.push(diff);
                    }
                }
            } else if format == "pi" {
                let mut input = vec![Value::String("text".into())];
                if model["vision"] == true {
                    input.push(Value::String("image".into()));
                }
                if let Some(diff) =
                    compare("input", entry.values.get("input"), &Value::Array(input))
                {
                    diffs.push(diff);
                }
            } else if format == "codex" {
                if let Some(diff) = compare_member(
                    "effort",
                    entry.values.get("effort"),
                    &model["reasoning"]["effort_values"],
                ) {
                    diffs.push(diff);
                }
                if let Some(wire) = entry.values.get("wire_api") {
                    let protocols = model["api_protocol"].as_str().unwrap_or("");
                    let expected = (wire == "responses"
                        && protocols.split('|').any(|p| p.trim() == "responses"))
                        || (wire == "chat"
                            && protocols.split('|').any(|p| p.trim() == "chat_completions"));
                    diffs.push(json!({"field":"wire_api", "config":wire, "official":protocols, "status":if expected {"match"} else {"diff"}, "note":if expected {Value::Null} else {json!("需使用与官网协议匹配的 wire_api")}}));
                }
            } else if format == "claude"
                && let Some(diff) = compare_member(
                    "effort",
                    entry.values.get("effort"),
                    &model["reasoning"]["effort_values"],
                )
            {
                diffs.push(diff);
            }
            if format == "claude"
                && let Some(diff) = compare_budget(
                    entry.values.get("budget"),
                    &model["reasoning"]["thinking_budget"],
                )
            {
                diffs.push(diff);
            }
        } else {
            unmatched += 1;
        }
        let matched_id = matched.model.and_then(|model| model["id"].as_str());
        let clean = matched_id.is_some() && diffs.iter().all(|diff| diff["status"] == "match");
        if !clean {
            with_diffs += 1;
            diff_items += if matched_id.is_some() {
                diffs
                    .iter()
                    .filter(|diff| diff["status"] != "match")
                    .count()
            } else {
                1
            };
        }
        let kind = match matched.kind {
            MatchKind::Exact => "exact",
            MatchKind::Alias => "alias",
            MatchKind::Legacy => "legacy",
            MatchKind::Normalized => "normalized",
            _ => "none",
        };
        rows.push(json!({"input": entry.input, "provider": entry.provider, "kind": kind, "matchedId": matched_id, "suggestion": if matched_id.is_none() { matched.suggestion } else { None }, "suggestionKind": matched.suggestion_kind, "diffs": diffs, "clean": clean}));
    }
    for row in &mut rows {
        row["duplicate"] = json!(
            seen.get(row["input"].as_str().unwrap_or_default())
                .copied()
                .unwrap_or_default()
                > 1
        );
    }
    let mut kinds = std::collections::HashMap::<String, u64>::new();
    for row in &rows {
        let kind = row["kind"].as_str().unwrap_or("none");
        if kind != "none" {
            *kinds.entry(kind.to_owned()).or_default() += 1;
        }
    }
    Ok(
        json!({"format": format, "entries": rows, "summary": {"total": rows.len(), "exact": kinds.get("exact").copied().unwrap_or(0), "alias": kinds.get("alias").copied().unwrap_or(0), "legacy": kinds.get("legacy").copied().unwrap_or(0), "normalized": kinds.get("normalized").copied().unwrap_or(0), "unmatched": unmatched, "with_diffs": with_diffs, "diff_items": diff_items, "clean": rows.iter().filter(|entry| entry["clean"] == true).count()}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_strictly_matches_and_never_copies_secrets() {
        let catalog = crate::catalog::load_bundled().unwrap();
        let config = json!({"provider": {"relay": {"options": {"apiKey": "sk-TEST-DO-NOT-OUTPUT"}, "models": {"gpt-6.1-sol": {"limit": {"context": 1050000}}}}}});
        let report = audit(&catalog.models, &config, "auto").unwrap();
        let text = report.to_string();
        assert!(!text.contains("sk-TEST-DO-NOT-OUTPUT"));
        assert_eq!(report["entries"][0]["kind"], "exact");
        assert_eq!(report["entries"][0]["diffs"][0]["status"], "match");
        assert_eq!(report["entries"][0]["diffs"][1]["status"], "missing");
    }

    #[test]
    fn normalized_ids_are_suggestions_not_matches() {
        let catalog = crate::catalog::load_bundled().unwrap();
        let report = audit(
            &catalog.models,
            &json!(["deepseek/deepseek-v4-pro"]),
            "generic",
        )
        .unwrap();
        assert_eq!(report["entries"][0]["kind"], "none");
        assert_eq!(report["entries"][0]["matchedId"], Value::Null);
        assert_eq!(report["entries"][0]["suggestion"], "deepseek-v4-pro");
    }

    #[test]
    fn codex_audit_detects_toml_and_reads_only_spec_fields() {
        let catalog = crate::catalog::load_bundled().unwrap();
        let input = "model = \"gpt-6.1-sol\"\r\nmodel_provider = \"openai\"\r\nmodel_reasoning_effort = \"high\"\r\n[model_providers.openai]\r\nwire_api = \"responses\" # active protocol\r\napi_key = \"sk-TEST-NEVER-OUTPUT\" # ignored secret\r\n";
        let report = audit(&catalog.models, &Value::String(input.into()), "auto").unwrap();
        let rendered = report.to_string();
        assert!(!rendered.contains("sk-TEST-NEVER-OUTPUT"));
        assert_eq!(report["format"], "codex");
        assert_eq!(report["entries"][0]["kind"], "exact");
        assert!(
            report["entries"][0]["diffs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diff| diff["field"] == "wire_api" && diff["status"] == "match")
        );
        assert_eq!(report["entries"][0]["diffs"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn audit_marks_duplicate_model_ids() {
        let catalog = crate::catalog::load_bundled().unwrap();
        let report = audit(
            &catalog.models,
            &json!(["gpt-6.1-sol", "gpt-6.1-sol"]),
            "generic",
        )
        .unwrap();
        assert_eq!(report["entries"][0]["duplicate"], true);
        assert_eq!(report["entries"][1]["duplicate"], true);
        assert_eq!(report["summary"]["exact"], 2);
    }
}
