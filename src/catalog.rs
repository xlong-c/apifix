use serde_json::Value;
use std::{fs, path::Path};

#[derive(Clone, Debug)]
pub struct Catalog {
    pub models: Vec<Value>,
    pub updated_at: Option<String>,
}

impl Catalog {
    pub fn filtered(
        &self,
        query: &str,
        vendor: Option<&str>,
        verified_only: bool,
        lifecycle: Option<&str>,
    ) -> Vec<&Value> {
        let query = query.trim().to_lowercase();
        let vendor = vendor.map(str::to_lowercase);
        self.models
            .iter()
            .filter(|model| {
                if verified_only && model["verified"] != true {
                    return false;
                }
                if lifecycle.is_some_and(|wanted| model["lifecycle"].as_str() != Some(wanted)) {
                    return false;
                }
                if vendor.as_ref().is_some_and(|want| {
                    model["vendor"].as_str().unwrap_or("").to_lowercase() != *want
                }) {
                    return false;
                }
                if query.is_empty() {
                    return true;
                }
                ["id", "vendor", "family", "lifecycle"].iter().any(|field| {
                    model[*field]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
                }) || model["aliases"].as_array().is_some_and(|aliases| {
                    aliases
                        .iter()
                        .any(|alias| alias.as_str().unwrap_or("").to_lowercase().contains(&query))
                })
            })
            .collect()
    }
}

pub fn load_from_path(path: impl AsRef<Path>) -> Result<Catalog, String> {
    let text = fs::read_to_string(path.as_ref())
        .map_err(|error| format!("cannot read {}: {error}", path.as_ref().display()))?;
    parse(&text)
}

pub fn load_bundled() -> Result<Catalog, String> {
    parse(include_str!("../catalog.json"))
}

pub fn parse(text: &str) -> Result<Catalog, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("invalid catalog: {error}"))?;
    let models = value["models"]
        .as_array()
        .ok_or_else(|| "catalog is missing models[]".to_owned())?
        .clone();
    let updated_at = value["updated_at"].as_str().map(str::to_owned);
    Ok(Catalog { models, updated_at })
}
