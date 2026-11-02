use serde_json::{Map, Value, json};

fn value_or_null(model: &Value, field: &str) -> Value {
    model.get(field).cloned().unwrap_or(Value::Null)
}

pub fn emit(model: &Value, target: &str, full: bool) -> Result<String, String> {
    emit_with_options(model, target, full, None, None)
}

pub fn emit_with_options(
    model: &Value,
    target: &str,
    full: bool,
    key_id: Option<&str>,
    display_name: Option<&str>,
) -> Result<String, String> {
    let id = model["id"].as_str().ok_or("model is missing id")?;
    let key = key_id.unwrap_or(id);
    let name = display_name.unwrap_or(key);
    match target {
        "opencode" => emit_opencode(model, full, key, name),
        "pi" => emit_pi(model, full, key, name),
        "codex" | "claude-env" | "curl" | "sdk" => {
            crate::extra::emit(model, target, full, key, name)
        }
        _ => Err(format!("unknown emitter: {target}")),
    }
}

fn emit_opencode(model: &Value, full: bool, key: &str, name: &str) -> Result<String, String> {
    let reasoning = &model["reasoning"];
    let sampling = &model["sampling"]["temperature"];
    let tools = &model["tools"];
    let mut payload = Map::new();
    payload.insert("attachment".into(), value_or_null(model, "vision"));
    payload.insert(
        "limit".into(),
        json!({
            "context": value_or_null(model, "context_window"),
            "output": value_or_null(model, "max_output_tokens")
        }),
    );
    payload.insert("name".into(), json!(name));
    payload.insert("reasoning".into(), value_or_null(reasoning, "supported"));
    payload.insert("temperature".into(), value_or_null(sampling, "supported"));
    payload.insert("tool_call".into(), value_or_null(tools, "function_calling"));
    if let Some(efforts) = reasoning["effort_values"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        let mut variants = Map::new();
        let mut values: Vec<&str> = efforts.iter().filter_map(Value::as_str).collect();
        values.sort_unstable();
        for effort in values {
            variants.insert(effort.to_owned(), json!({"reasoningEffort": effort}));
        }
        payload.insert("variants".into(), Value::Object(variants));
    }
    if full {
        if model["family"].is_string() {
            payload.insert("family".into(), model["family"].clone());
        }
        let status = match model["lifecycle"].as_str() {
            Some("current") => Some("active"),
            Some("legacy" | "retired") => Some("deprecated"),
            Some("unreleased") => Some("beta"),
            _ => None,
        };
        if let Some(status) = status {
            payload.insert("status".into(), json!(status));
        }
        let mut input = vec![json!("text")];
        if model["vision"] == true {
            input.push(json!("image"));
        }
        if model["pdf"] == true {
            input.push(json!("pdf"));
        }
        payload.insert(
            "modalities".into(),
            json!({"input": input, "output": ["text"]}),
        );
        if let Some(cost) = opencode_cost(model) {
            payload.insert("cost".into(), cost);
        }
    }
    let mut wrapped = Map::new();
    wrapped.insert(key.to_owned(), Value::Object(sort_object(payload)));
    serde_json::to_string_pretty(&Value::Object(sort_object(wrapped)))
        .map_err(|error| error.to_string())
}

fn opencode_cost(model: &Value) -> Option<Value> {
    let cost = &model["cost"];
    let mut result = Map::new();
    if cost["input"].as_f64().is_none() || cost["output"].as_f64().is_none() {
        return None;
    }
    result.insert("input".into(), cost["input"].clone());
    result.insert("output".into(), cost["output"].clone());
    for field in ["cache_read", "cache_write"] {
        if cost[field].as_f64().is_some() {
            result.insert(field.into(), cost[field].clone());
        }
    }
    if let Some(over) = cost["context_over_200k"].as_object()
        && over.get("input").and_then(Value::as_f64).is_some()
        && over.get("output").and_then(Value::as_f64).is_some()
    {
        let mut values = Map::new();
        values.insert("input".into(), over["input"].clone());
        values.insert("output".into(), over["output"].clone());
        for field in ["cache_read", "cache_write"] {
            if over.get(field).and_then(Value::as_f64).is_some()
                && let Some(value) = over.get(field)
            {
                values.insert(field.into(), value.clone());
            }
        }
        result.insert("context_over_200k".into(), Value::Object(values));
    }
    Some(Value::Object(result))
}

fn emit_pi(model: &Value, full: bool, id: &str, name: &str) -> Result<String, String> {
    let reasoning = &model["reasoning"];
    let efforts: Vec<String> = reasoning["effort_values"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut levels = Map::new();
    for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
        let mapped = if reasoning["supported"] == true {
            if level == "off" && efforts.iter().any(|effort| effort == "none") {
                Some("none")
            } else if efforts.iter().any(|effort| effort == level) {
                Some(level)
            } else {
                None
            }
        } else {
            None
        };
        levels.insert(
            level.into(),
            mapped.map(|s| json!(s)).unwrap_or(Value::Null),
        );
    }
    let input = if model["vision"] == true {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    let mut result = json!({
        "id": id,
        "name": name,
        "reasoning": value_or_null(reasoning, "supported"),
        "input": input,
        "contextWindow": value_or_null(model, "context_window"),
        "maxTokens": value_or_null(model, "max_output_tokens"),
        "thinkingLevelMap": Value::Object(levels)
    });
    if full && let Some(object) = result.as_object_mut() {
        let api = match model["api_protocol"]
            .as_str()
            .unwrap_or("")
            .split('|')
            .next()
            .unwrap_or("")
        {
            "chat_completions" => Some("openai-completions"),
            "responses" => Some("openai-responses"),
            "anthropic_messages" => Some("anthropic-messages"),
            _ => None,
        };
        if let Some(api) = api {
            object.insert("api".into(), json!(api));
        }
    }
    serde_json::to_string_pretty(&result).map_err(|error| error.to_string())
}

fn sort_object(object: Map<String, Value>) -> Map<String, Value> {
    let mut keys: Vec<_> = object.keys().cloned().collect();
    keys.sort_unstable();
    let mut sorted = Map::new();
    for key in keys {
        if let Some(value) = object.get(&key) {
            sorted.insert(key, value.clone());
        }
    }
    sorted
}

pub fn card(model: &Value) -> String {
    let reasoning = &model["reasoning"];
    let sampling = &model["sampling"];
    let tools = &model["tools"];
    let cost = &model["cost"];
    let mut lines = vec![
        format!(
            "{}  ({})  [{}]",
            model["id"].as_str().unwrap_or("unknown"),
            model["vendor"].as_str().unwrap_or("unknown"),
            model["lifecycle"].as_str().unwrap_or("unknown")
        ),
        format!(
            "verified: {}  ·  confidence: {}",
            display(model.get("verified")),
            display(model.get("confidence"))
        ),
        format!("family: {}", display(model.get("family"))),
        format!(
            "protocol: {}",
            model["api_protocol"].as_str().unwrap_or("unknown")
        ),
        format!("context: {}", display(model.get("context_window"))),
        format!("max output: {}", display(model.get("max_output_tokens"))),
        format!(
            "reasoning: {}  ·  efforts: {}  ·  default: {}",
            display(reasoning.get("supported")),
            display_array(reasoning.get("effort_values")),
            display(reasoning.get("default_effort"))
        ),
        format!(
            "sampling: temperature={}  top_p={}  top_k={}",
            display(sampling.pointer("/temperature/supported")),
            display(sampling.pointer("/top_p/supported")),
            display(sampling.pointer("/top_k/supported"))
        ),
        format!(
            "tools: functions={}  parallel={}  strict={}",
            display(tools.get("function_calling")),
            display(tools.get("parallel")),
            display(tools.get("strict"))
        ),
        format!(
            "structured output: {}  ·  vision: {}  ·  PDF: {}",
            display(model.pointer("/structured_output/supported")),
            display(model.get("vision")),
            display(model.get("pdf"))
        ),
        format!(
            "cache: {}  ·  minimum tokens: {}",
            display(model.pointer("/caching/mode")),
            display(model.pointer("/caching/min_tokens"))
        ),
    ];
    if cost.is_object() {
        lines.push(format!(
            "price / 1M tokens: input={}  output={}  cache read={}  cache write={}",
            display(cost.get("input")),
            display(cost.get("output")),
            display(cost.get("cache_read")),
            display(cost.get("cache_write"))
        ));
    }
    if let Some(note) = model["lifecycle_note"]
        .as_str()
        .filter(|note| !note.is_empty())
    {
        lines.push(format!("lifecycle note: {note}"));
    }
    if let Some(gotchas) = model["gotchas"].as_array()
        && !gotchas.is_empty()
    {
        lines.push(String::new());
        lines.push("Notes".into());
        lines.extend(
            gotchas
                .iter()
                .filter_map(Value::as_str)
                .map(|note| format!("- {note}")),
        );
    }
    if let Some(sources) = model["sources"].as_array()
        && !sources.is_empty()
    {
        lines.push(String::new());
        lines.push("Sources".into());
        lines.extend(
            sources
                .iter()
                .filter_map(Value::as_str)
                .map(|source| format!("- {source}")),
        );
    }
    lines.join("\n")
}

fn display_array(value: Option<&Value>) -> String {
    match value.and_then(Value::as_array) {
        Some(values) if !values.is_empty() => values
            .iter()
            .map(display_value)
            .collect::<Vec<_>>()
            .join(", "),
        _ => "unknown / not documented".into(),
    }
}

fn display_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn display(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "unknown / not documented".into(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
    }
}
