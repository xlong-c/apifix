use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum MatchKind {
    Exact,
    Alias,
    Legacy,
    Normalized,
    Fuzzy,
    None,
}

#[derive(Clone, Debug)]
pub struct MatchResult<'a> {
    pub kind: MatchKind,
    pub model: Option<&'a Value>,
    pub suggestion: Option<String>,
    pub suggestion_kind: Option<String>,
    pub score: f64,
}

fn entries<'a>(model: &'a Value, field: &str) -> impl Iterator<Item = String> + 'a {
    model[field]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
}

fn normalized(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, '-' | '.' | '_'))
        .collect()
}

fn known_vendor_prefix(models: &[Value], prefix: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "openai",
        "anthropic",
        "meta",
        "google",
        "x-ai",
        "xai",
        "deepseek",
        "moonshotai",
        "moonshot",
        "z-ai",
        "zhipu",
        "qwen",
        "dashscope",
        "minimax",
        "minimaxai",
        "volcengine",
        "volcengine-plan",
        "doubao",
        "tencent",
        "alibaba",
        "ark",
        "stepfun",
        "mistral",
        "mistralai",
        "cohere",
        "nvidia",
        "microsoft",
        "azure",
        "amazon",
        "bedrock",
        "baidu",
        "qianfan",
        "iflytek",
        "xfyun",
        "01ai",
        "lingyiwanwu",
        "ai21",
        "writer",
        "aliyun",
        "bigmodel",
    ];
    PREFIXES
        .iter()
        .any(|known| prefix.eq_ignore_ascii_case(known))
        || models.iter().any(|model| {
            model["vendor"]
                .as_str()
                .is_some_and(|vendor| prefix.eq_ignore_ascii_case(vendor))
        })
}

fn direct<'a>(models: &'a [Value], input: &str) -> Option<(&'a Value, MatchKind)> {
    for (field, kind) in [("id", MatchKind::Exact), ("aliases", MatchKind::Alias)] {
        for model in models {
            let keys = if field == "id" {
                model["id"]
                    .as_str()
                    .map(|id| vec![id.to_owned()])
                    .unwrap_or_default()
            } else {
                entries(model, field).collect()
            };
            if keys.iter().any(|key| key.eq_ignore_ascii_case(input)) {
                return Some((model, kind.clone()));
            }
        }
    }
    for model in models {
        if model["legacy_ids"].as_array().is_some_and(|ids| {
            ids.iter().any(|item| {
                item.as_str()
                    .is_some_and(|id| id.eq_ignore_ascii_case(input))
                    || item["id"]
                        .as_str()
                        .is_some_and(|id| id.eq_ignore_ascii_case(input))
            })
        }) {
            return Some((model, MatchKind::Legacy));
        }
    }
    None
}

fn normalized_lookup<'a>(models: &'a [Value], input: &str) -> Option<(&'a Value, MatchKind)> {
    let wanted = normalized(input);
    for model in models {
        if model["id"]
            .as_str()
            .is_some_and(|id| normalized(id) == wanted)
        {
            return Some((model, MatchKind::Normalized));
        }
        if entries(model, "aliases").any(|alias| normalized(&alias) == wanted) {
            return Some((model, MatchKind::Normalized));
        }
        if model["legacy_ids"].as_array().is_some_and(|ids| {
            ids.iter().any(|item| {
                item.as_str().is_some_and(|id| normalized(id) == wanted)
                    || item["id"]
                        .as_str()
                        .is_some_and(|id| normalized(id) == wanted)
            })
        }) {
            return Some((model, MatchKind::Legacy));
        }
    }
    None
}

pub fn match_model<'a>(models: &'a [Value], input: &str, strict: bool) -> MatchResult<'a> {
    let input = input.trim();
    if let Some((model, kind)) = direct(models, input) {
        return MatchResult {
            kind,
            model: Some(model),
            suggestion: None,
            suggestion_kind: None,
            score: 1.0,
        };
    }

    let mut candidates = vec![input.to_owned()];
    if let Some((prefix, tail)) = input.split_once('/')
        && known_vendor_prefix(models, prefix)
    {
        candidates.push(tail.to_owned());
    }
    for stage in 0..candidates.len() {
        let mut current = candidates[stage].clone();
        for suffix in [
            "-vision-exp",
            "-experimental",
            "-contributor",
            "-preview",
            "-free",
            "-latest",
            "-build",
            "-exp",
        ] {
            if let Some(trimmed) = current
                .get(..current.len().saturating_sub(suffix.len()))
                .filter(|_| current.to_ascii_lowercase().ends_with(suffix))
            {
                current = trimmed.to_owned();
                candidates.push(current.clone());
            }
        }
    }
    for candidate in &candidates {
        if let Some((model, kind)) = normalized_lookup(models, candidate) {
            let id = model["id"].as_str().map(str::to_owned);
            return MatchResult {
                kind: if strict {
                    MatchKind::None
                } else if kind == MatchKind::Legacy {
                    MatchKind::Legacy
                } else {
                    MatchKind::Normalized
                },
                model: (!strict).then_some(model),
                suggestion: strict.then_some(id).flatten(),
                suggestion_kind: strict.then(|| "normalized".into()),
                score: 1.0,
            };
        }
    }

    let mut best: Option<(&Value, f64)> = None;
    for model in models {
        if let Some(id) = model["id"].as_str() {
            let score = strsim::normalized_levenshtein(&normalized(input), &normalized(id));
            if score >= 0.75 && best.is_none_or(|(_, previous)| score > previous) {
                best = Some((model, score));
            }
        }
    }
    if let Some((model, score)) = best {
        return MatchResult {
            kind: MatchKind::Fuzzy,
            model: None,
            suggestion: model["id"].as_str().map(str::to_owned),
            suggestion_kind: None,
            score,
        };
    }
    let compact = |text: &str| {
        normalized(text)
            .chars()
            .filter(|ch| *ch != '/')
            .collect::<String>()
    };
    let probe = compact(input);
    if probe.chars().count() >= 3 {
        let mut hits: Vec<&str> = models
            .iter()
            .filter_map(|model| model["id"].as_str())
            .filter(|id| compact(id).starts_with(&probe))
            .collect();
        hits.sort_unstable();
        hits.dedup();
        if !hits.is_empty() && hits.len() <= 5 {
            return MatchResult {
                kind: MatchKind::None,
                model: None,
                suggestion: Some(hits[0].to_owned()),
                suggestion_kind: Some("prefix".into()),
                score: 0.0,
            };
        }
    }
    MatchResult {
        kind: MatchKind::None,
        model: None,
        suggestion: None,
        suggestion_kind: None,
        score: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;

    #[test]
    fn matches_catalog_ids_and_relay_prefixes() {
        let catalog = catalog::load_bundled().unwrap();
        assert_eq!(
            match_model(&catalog.models, "step-5-preview", false).kind,
            MatchKind::Exact
        );
        let result = match_model(&catalog.models, "stepfun/step-5-preview", false);
        assert_eq!(result.kind, MatchKind::Alias);
        assert_eq!(result.model.unwrap()["id"], "step-5-preview");
    }

    #[test]
    fn strict_matching_only_suggests_normalized_ids() {
        let catalog = catalog::load_bundled().unwrap();
        let result = match_model(&catalog.models, "deepseek/deepseek-v4-pro", true);
        assert_eq!(result.kind, MatchKind::None);
        assert_eq!(result.suggestion.as_deref(), Some("deepseek-v4-pro"));
        assert_eq!(result.suggestion_kind.as_deref(), Some("normalized"));
        assert!(result.model.is_none());
    }

    #[test]
    fn unknown_vendor_prefix_is_not_removed_and_aliases_normalize() {
        let catalog = catalog::load_bundled().unwrap();
        let unknown = match_model(&catalog.models, "relay/step-5-preview", false);
        assert!(unknown.model.is_none());
        let relay_alias = match_model(&catalog.models, "muse-spark-1.3-contributor-free", false);
        assert_eq!(
            relay_alias.model.unwrap()["id"],
            "muse-spark-1.3-contributor"
        );
    }

    #[test]
    fn short_model_prefix_is_only_a_suggestion() {
        let catalog = catalog::load_bundled().unwrap();
        let result = match_model(&catalog.models, "step5", false);
        assert_eq!(result.kind, MatchKind::None);
        assert_eq!(result.suggestion.as_deref(), Some("step-5-preview"));
        assert_eq!(result.suggestion_kind.as_deref(), Some("prefix"));
        assert!(result.model.is_none());
    }
}
