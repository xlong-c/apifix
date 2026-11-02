use serde_json::{Map, Value, json};

const BASE_URL: &str = "https://YOUR_BASE_URL/v1";

pub fn emit(
    model: &Value,
    target: &str,
    full: bool,
    key: &str,
    name: &str,
) -> Result<String, String> {
    match target {
        "codex" => emit_codex(model, full, key, name),
        "claude-env" => emit_claude(model, full, key),
        "curl" => emit_curl(model, key),
        "sdk" => emit_sdk(model, key),
        _ => Err(format!("unknown emitter: {target}")),
    }
}

fn best_effort(model: &Value) -> Option<&str> {
    let efforts = model["reasoning"]["effort_values"].as_array()?;
    if let Some(default) = model["reasoning"]["default_effort"].as_str()
        && efforts.iter().any(|value| value.as_str() == Some(default))
    {
        return Some(default);
    }
    ["high", "medium", "low", "xhigh", "max", "minimal", "none"]
        .into_iter()
        .find(|wanted| efforts.iter().any(|value| value.as_str() == Some(wanted)))
        .or_else(|| efforts.first().and_then(Value::as_str))
}

fn quote_toml(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
    )
}

fn toml_key(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        value.into()
    } else {
        quote_toml(value)
    }
}

fn emit_codex(model: &Value, full: bool, key: &str, name: &str) -> Result<String, String> {
    let mut lines = vec![format!("model = {}", quote_toml(key))];
    if let Some(effort) = best_effort(model) {
        lines.push(format!("model_reasoning_effort = {}", quote_toml(effort)));
    } else {
        lines.push(
            "# model_reasoning_effort = 未知，需确认（该模型未文档化 reasoning effort 档位）"
                .into(),
        );
    }
    if full {
        lines.push(format!("model_provider = {}", quote_toml(key)));
        lines.push(String::new());
        lines.push(format!("[model_providers.{}]", toml_key(key)));
        lines.push(format!("name = {}", quote_toml(name)));
        lines.push(format!(
            "base_url = \"{BASE_URL}\"  # 占位符：替换为你的网关/中转地址"
        ));
        let wire = model["api_protocol"]
            .as_str()
            .and_then(|protocol| protocol.split('|').next())
            .map(str::trim)
            .and_then(|protocol| match protocol {
                "chat_completions" => Some("chat"),
                "responses" => Some("responses"),
                _ => None,
            });
        if let Some(wire) = wire {
            lines.push(format!("wire_api = {}", quote_toml(wire)));
        } else {
            lines.push(format!(
                "# wire_api 无法映射（api_protocol={}；codex 仅支持 responses / chat）",
                display(&model["api_protocol"])
            ));
        }
        lines.push(
            "# env_key = \"YOUR_API_KEY_ENV\"  # 可选：API key 所处的环境变量名（占位，需自行设置）"
                .into(),
        );
    }
    Ok(lines.join("\n"))
}

fn emit_claude(model: &Value, full: bool, key: &str) -> Result<String, String> {
    let reasoning = &model["reasoning"];
    let mut lines = vec![format!("ANTHROPIC_MODEL={key}")];
    let budget = reasoning["thinking_budget"]["min"].as_u64();
    match budget {
        Some(value) => lines.push(format!("MAX_THINKING_TOKENS={value}")),
        None => lines
            .push("# MAX_THINKING_TOKENS=未知，需确认（该模型未文档化 thinking budget）".into()),
    }
    let effort = best_effort(model);
    if reasoning["supported"] == false {
        lines.push("# CLAUDE_CODE_EFFORT_LEVEL=不适用（该模型不支持推理）".into());
    } else if let Some(effort) = effort {
        lines.push(format!("CLAUDE_CODE_EFFORT_LEVEL={effort}"));
    } else {
        lines.push("# CLAUDE_CODE_EFFORT_LEVEL=未知，需确认（该模型未文档化 effort 档位）".into());
    }
    if !full {
        return Ok(lines.join("\n"));
    }

    let mut env = Map::new();
    env.insert("ANTHROPIC_BASE_URL".into(), json!("https://YOUR_BASE_URL"));
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!("YOUR_API_KEY"));
    env.insert("ANTHROPIC_MODEL".into(), json!(key));
    if let Some(value) = budget {
        env.insert("MAX_THINKING_TOKENS".into(), json!(value.to_string()));
    }
    if let Some(effort) = effort {
        env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), json!(effort));
    }
    serde_json::to_string_pretty(&json!({"env": env})).map_err(|error| error.to_string())
}

fn emit_curl(model: &Value, key: &str) -> Result<String, String> {
    let protocol = model["api_protocol"].as_str().unwrap_or("chat_completions");
    let effort = best_effort(model);
    if protocol == "anthropic_messages" {
        let max_tokens = model["max_output_tokens"].as_u64();
        let tokens = max_tokens.unwrap_or(4096);
        let header = if max_tokens.is_some() {
            format!("MAX_TOKENS={tokens}  # 官网 max_output_tokens")
        } else {
            "MAX_TOKENS=4096  # 未知，需确认：官方未文档化 max_output_tokens，请填入实际值".into()
        };
        let data = format!(
            "{{\"model\":\"{key}\",\"max_tokens\":${{MAX_TOKENS}},\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}]}}"
        )
        .replace('"', "\\\"");
        return Ok(format!(
            "{header}\ncurl -sS \"$ANTHROPIC_BASE_URL/v1/messages\" \\\n  -H \"x-api-key: $ANTHROPIC_API_KEY\" \\\n  -H \"anthropic-version: 2023-06-01\" \\\n  -H \"content-type: application/json\" \\\n  -d \"{data}\""
        ));
    }
    if protocol == "gemini" {
        return Ok(format!(
            "curl -sS \"$GEMINI_BASE_URL/v1beta/models/{key}:generateContent?key=$GEMINI_API_KEY\" \\\n  -H \"content-type: application/json\" \\\n  -d '{{\"contents\":[{{\"parts\":[{{\"text\":\"hi\"}}]}}]}}'"
        ));
    }

    let (env, path, data) = if protocol == "responses" {
        let effort = effort
            .map(|value| format!(",\"reasoning\":{{\"effort\":\"{value}\"}}"))
            .unwrap_or_default();
        (
            "OPENAI_BASE_URL",
            "/v1/responses",
            format!("{{\"model\":\"{key}\",\"input\":\"hi\"{effort}}}"),
        )
    } else {
        let effort = effort
            .map(|value| format!(",\"reasoning_effort\":\"{value}\""))
            .unwrap_or_default();
        let (env, path) = match protocol {
            "chat_completions" => ("OPENAI_BASE_URL", "/v1/chat/completions"),
            "native" => ("BASE_URL", "/v1/complete"),
            _ => ("BASE_URL", "/v1/chat/completions"),
        };
        (
            env,
            path,
            format!(
                "{{\"model\":\"{key}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}]{effort}}}"
            ),
        )
    };
    Ok(format!(
        "curl -sS \"${env}{path}\" \\\n  -H \"Authorization: Bearer $OPENAI_API_KEY\" \\\n  -H \"content-type: application/json\" \\\n  -d '{data}'"
    ))
}

fn emit_sdk(model: &Value, key: &str) -> Result<String, String> {
    let effort = best_effort(model);
    let protocol = model["api_protocol"].as_str().unwrap_or("chat_completions");
    let result = match protocol {
        "anthropic_messages" => {
            let max = model["max_output_tokens"].as_u64().unwrap_or(4096);
            let effort_note = effort
                .map(|value| format!("    # effort: \"{value}\"（官方档位）\n"))
                .unwrap_or_default();
            format!(
                "# pip install anthropic\nfrom anthropic import Anthropic\n\nclient = Anthropic()\nresp = client.messages.create(\n    model=\"{key}\",\n    max_tokens={max},\n    messages=[{{\"role\": \"user\", \"content\": \"hi\"}}],\n{effort_note})\nprint(resp.content)"
            )
        }
        "gemini" => format!(
            "# pip install google-genai\nfrom google import genai\n\nclient = genai.Client()\nresp = client.models.generate_content(\n    model=\"{key}\",\n    contents=\"hi\",\n)\nprint(resp.text)"
        ),
        "responses" => {
            let reasoning = effort
                .map(|value| format!("    reasoning={{\"effort\": \"{value}\"}},\n"))
                .unwrap_or_else(|| {
                    "    # reasoning=未知，需确认（官方未文档化 effort 档位）\n".into()
                });
            format!(
                "# pip install openai\nfrom openai import OpenAI\n\nclient = OpenAI()\nresp = client.responses.create(\n    model=\"{key}\",\n    input=\"hi\",\n{reasoning})\nprint(resp.output_text)"
            )
        }
        _ => {
            let reasoning = effort
                .map(|value| format!("    extra_body={{\"reasoning_effort\": \"{value}\"}},\n"))
                .unwrap_or_default();
            format!(
                "# pip install openai\nfrom openai import OpenAI\n\nclient = OpenAI()  # 中转需设置 base_url\nresp = client.chat.completions.create(\n    model=\"{key}\",\n    messages=[{{\"role\": \"user\", \"content\": \"hi\"}}],\n{reasoning})\nprint(resp.choices[0].message.content)"
            )
        }
    };
    Ok(result)
}

fn display(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
