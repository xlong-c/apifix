pub mod catalog;
pub mod config;
pub mod extra;
pub mod matching;
pub mod render;

use serde_json::Value;

pub fn model_label(model: &Value) -> String {
    let id = model.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let vendor = model
        .get("vendor")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let family = model.get("family").and_then(Value::as_str).unwrap_or("");
    if family.is_empty() {
        format!("{vendor}  ·  {id}")
    } else {
        format!("{vendor}  ·  {id}  ·  {family}")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn loads_bundled_catalog() {
        let catalog = crate::catalog::load_bundled().unwrap();
        assert!(!catalog.models.is_empty());
        assert!(
            catalog
                .models
                .iter()
                .any(|model| model["id"] == "step-5-preview")
        );
        for id in [
            "gpt-6.1-sol",
            "gpt-6.1-terra",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "kimi-k3.1-pro",
            "kimi-k3.1-pro-highspeed",
            "step-3.5-flash",
            "step-3.5-flash-2603",
            "step-3.7-flash",
        ] {
            assert!(
                catalog.models.iter().any(|model| model["id"] == id),
                "missing model: {id}"
            );
        }
    }
}
