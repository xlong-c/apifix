mod gui;

use apifix::{
    catalog,
    matching::{MatchKind, match_model},
    render,
};
use clap::{Parser, Subcommand};
use std::{fs, io::Read};

#[derive(Parser)]
#[command(name = "apifix", version, about = "模型官方参数速查与配置片段生成器")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long)]
    list: bool,
    #[arg(long)]
    card: bool,
    #[arg(short = 'f', long)]
    full: bool,
    #[arg(long, value_parser = ["opencode", "pi", "codex", "claude-env", "curl", "sdk"])]
    emit: Option<String>,
    #[arg(long = "match")]
    match_file: Option<String>,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    canonical_id: bool,
    #[arg(long)]
    ui: bool,
    #[arg(long)]
    catalog: Option<String>,
    id: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    Search {
        query: Option<String>,
    },
    Compare {
        ids: Vec<String>,
    },
    Audit {
        file: String,
        #[arg(long, default_value = "auto", value_parser = ["auto", "opencode", "pi", "codex", "claude", "generic"])]
        format: String,
        #[arg(long)]
        json: bool,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("apifix: error: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse();
    if args.ui
        || (args.command.is_none() && !args.list && args.match_file.is_none() && args.id.is_none())
    {
        return gui::run();
    }
    let catalog = if let Some(path) = args.catalog {
        catalog::load_from_path(path)?
    } else {
        catalog::load_bundled()?
    };
    match args.command {
        Some(Command::Audit { file, format, json }) => {
            let text = if file == "-" {
                let mut text = String::new();
                std::io::stdin()
                    .read_to_string(&mut text)
                    .map_err(|e| e.to_string())?;
                text
            } else {
                fs::read_to_string(&file)
                    .map_err(|_| format!("cannot read configuration: {file}"))?
            };
            let body = text.trim_start_matches('\u{feff}');
            let toml_input = format == "codex"
                || (format == "auto"
                    && (file.to_ascii_lowercase().ends_with(".toml")
                        || body.lines().any(|line| {
                            let line = line.trim_start();
                            line.starts_with("model =") || line.starts_with("[model_providers.")
                        })));
            let parsed = if toml_input {
                serde_json::Value::String(body.to_owned())
            } else {
                match serde_json::from_str::<serde_json::Value>(body) {
                    Ok(value) => value,
                    Err(_)
                        if format == "generic"
                            || (format == "auto" && !body.trim_start().starts_with(['{', '['])) =>
                    {
                        serde_json::Value::String(body.to_owned())
                    }
                    Err(_) => return Err("invalid configuration JSON".into()),
                }
            };
            let report = apifix::config::audit(&catalog.models, &parsed, &format)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "file": file,
                        "format": report["format"],
                        "entries": report["entries"],
                        "summary": report["summary"]
                    }))
                    .map_err(|e| e.to_string())?
                );
            } else {
                println!(
                    "{}: {} entries, {} unmatched, {} with differences",
                    report["format"],
                    report["summary"]["total"],
                    report["summary"]["unmatched"],
                    report["summary"]["with_diffs"]
                );
                for entry in report["entries"].as_array().into_iter().flatten() {
                    println!(
                        "{} -> {}",
                        entry["input"].as_str().unwrap_or(""),
                        entry["matchedId"].as_str().unwrap_or("未匹配")
                    );
                    for diff in entry["diffs"].as_array().into_iter().flatten() {
                        println!(
                            "  {}: {} ({})",
                            diff["field"],
                            diff["status"],
                            diff["note"].as_str().unwrap_or("")
                        );
                    }
                }
            }
            if report["summary"]["with_diffs"].as_u64().unwrap_or(0) > 0 {
                std::process::exit(1);
            }
        }
        Some(Command::Search { query }) => {
            let models = catalog.filtered(query.as_deref().unwrap_or(""), None, false, None);
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&models).map_err(|e| e.to_string())?
                );
            } else {
                for model in models {
                    println!("{}", apifix::model_label(model));
                }
            }
        }
        Some(Command::Compare { ids }) => {
            for id in ids {
                let matched = match_model(&catalog.models, &id, false);
                if let Some(model) = matched.model {
                    println!(
                        "{}\t{}\tcontext={}\toutput={}",
                        id, model["id"], model["context_window"], model["max_output_tokens"]
                    );
                } else {
                    println!("{}\tunknown", id);
                }
            }
        }
        None if args.list => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&catalog.models).map_err(|e| e.to_string())?
                );
            } else {
                for model in &catalog.models {
                    println!("{}", apifix::model_label(model));
                }
            }
        }
        None if args.match_file.is_some() => {
            let file = args.match_file.as_deref().unwrap_or_default();
            let text = if file == "-" {
                let mut text = String::new();
                std::io::stdin()
                    .read_to_string(&mut text)
                    .map_err(|e| e.to_string())?;
                text
            } else {
                fs::read_to_string(file).map_err(|e| format!("cannot read {file}: {e}"))?
            };
            let mut results = Vec::new();
            let mut missed = false;
            for raw in text.lines() {
                let id = raw.trim();
                if id.is_empty() {
                    continue;
                }
                let result = match_model(&catalog.models, id, false);
                let model_id = result.model.and_then(|model| model["id"].as_str());
                if model_id.is_none() {
                    missed = true;
                }
                results.push(serde_json::json!({
                    "input": id,
                    "kind": format!("{:?}", result.kind).to_lowercase(),
                    "matched_id": model_id,
                    "suggestion": result.suggestion.clone(),
                    "suggestion_kind": result.suggestion_kind,
                    "score": result.score
                }));
                if !args.json {
                    if let Some(model_id) = model_id {
                        println!("[OK] {id} -> {model_id}");
                    } else if let Some(suggestion) = result.suggestion {
                        let note = if result.suggestion_kind.as_deref() == Some("prefix") {
                            "前缀匹配"
                        } else {
                            "最接近"
                        };
                        println!("[?] {id} -> {note}: {suggestion}");
                    } else {
                        println!("[?] {id} -> not found");
                    }
                }
            }
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&results).map_err(|e| e.to_string())?
                );
            }
            if missed {
                std::process::exit(1);
            }
        }
        None => {
            let id = args.id.ok_or("model id is required")?;
            let matched = match_model(&catalog.models, &id, false);
            let Some(model) = matched.model else {
                if let Some(suggestion) = matched.suggestion {
                    if matched.suggestion_kind.as_deref() == Some("prefix") {
                        eprintln!("apifix: not found: {id}; 最接近: {suggestion}（前缀匹配）");
                    } else {
                        eprintln!("apifix: not found: {id}; 最接近: {suggestion}");
                    }
                } else {
                    eprintln!("apifix: not found: {id}");
                }
                std::process::exit(1);
            };
            match matched.kind {
                MatchKind::Alias | MatchKind::Legacy | MatchKind::Normalized => {
                    eprintln!("[i] {id} -> {} ({:?})", model["id"], matched.kind);
                }
                _ => {}
            }
            if args.card {
                println!("{}", render::card(model));
            } else if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(model).map_err(|e| e.to_string())?
                );
            } else {
                let key = if args.canonical_id {
                    model["id"].as_str().unwrap_or(&id)
                } else {
                    &id
                };
                println!(
                    "{}",
                    render::emit_with_options(
                        model,
                        args.emit.as_deref().unwrap_or("opencode"),
                        args.full,
                        Some(key),
                        args.name.as_deref(),
                    )?
                );
            }
        }
    }
    Ok(())
}
