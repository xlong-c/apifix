use apifix::{
    catalog,
    matching::{MatchKind, match_model},
    model_label, render,
};
use slint::{ModelRc, SharedString, VecModel};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

slint::include_modules!();

#[derive(Clone)]
struct ViewState {
    selected_id: String,
    full: bool,
    emitter: String,
    query: String,
    vendor: Option<String>,
    verified_only: bool,
    lifecycle: Option<String>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            selected_id: String::new(),
            full: false,
            emitter: "opencode".into(),
            query: String::new(),
            vendor: None,
            verified_only: false,
            lifecycle: None,
        }
    }
}

type SharedState = Rc<RefCell<ViewState>>;

fn refresh(window: &MainWindow, catalog: &catalog::Catalog, state: &SharedState) {
    let state = state.borrow();
    let rows = catalog.filtered(
        &state.query,
        state.vendor.as_deref(),
        state.verified_only,
        state.lifecycle.as_deref(),
    );
    let labels: Vec<SharedString> = rows
        .iter()
        .map(|model| SharedString::from(model_label(model)))
        .collect();
    window.set_model_rows(ModelRc::new(VecModel::from(labels)));
    window.set_catalog_status(SharedString::from(format!(
        "{} models · updated {}",
        catalog.models.len(),
        catalog.updated_at.as_deref().unwrap_or("unknown")
    )));

    let matched = match_model(&catalog.models, &state.selected_id, false);
    if let Some(model) = matched.model {
        window.set_detail_text(SharedString::from(render::card(model)));
        let output = render::emit(model, &state.emitter, state.full).unwrap_or_else(|error| error);
        window.set_output_text(SharedString::from(output));
    } else if let Some(suggestion) = matched.suggestion {
        window.set_detail_text(SharedString::from(format!(
            "未收录\n最接近的模型：{suggestion}"
        )));
        window.set_output_text(SharedString::default());
    }
}

pub fn run() -> Result<(), String> {
    let catalog = Rc::new(catalog::load_bundled()?);
    let window = MainWindow::new().map_err(|error| error.to_string())?;
    let state: SharedState = Rc::new(RefCell::new(ViewState::default()));
    if let Some(model) = catalog
        .models
        .iter()
        .find(|model| model["id"] == "gpt-6.1-sol")
        .or_else(|| catalog.models.first())
    {
        state.borrow_mut().selected_id = model["id"].as_str().unwrap_or("").to_owned();
    }
    let mut vendors = BTreeSet::new();
    for model in &catalog.models {
        if let Some(vendor) = model["vendor"].as_str() {
            vendors.insert(vendor.to_owned());
        }
    }
    let mut vendor_options = vec![SharedString::from("所有厂商")];
    vendor_options.extend(vendors.into_iter().map(SharedString::from));
    window.set_vendor_options(ModelRc::new(VecModel::from(vendor_options)));
    window.set_lifecycle_options(ModelRc::new(VecModel::from(
        ["所有状态", "current", "legacy", "retired", "unreleased"]
            .into_iter()
            .map(SharedString::from)
            .collect::<Vec<_>>(),
    )));
    refresh(&window, &catalog, &state);

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_search_changed(move |query| {
        callback_state.borrow_mut().query = query.to_string();
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_vendor_changed(move |vendor| {
        let value = vendor.to_string();
        callback_state.borrow_mut().vendor = (value != "所有厂商").then_some(value);
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_lifecycle_changed(move |lifecycle| {
        let value = lifecycle.to_string();
        callback_state.borrow_mut().lifecycle = (value != "所有状态").then_some(value);
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_verified_changed(move |verified| {
        callback_state.borrow_mut().verified_only = verified;
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_select_model(move |label| {
        let id = label
            .split("  ·  ")
            .nth(1)
            .unwrap_or("")
            .split("  ·  ")
            .next()
            .unwrap_or("")
            .to_owned();
        callback_state.borrow_mut().selected_id = id;
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    let callback_catalog = catalog.clone();
    let callback_state = state.clone();
    window.on_emit_changed(move |_id, full, emitter| {
        {
            let mut state = callback_state.borrow_mut();
            state.full = full;
            state.emitter = emitter.to_string();
        }
        if let Some(window) = weak.upgrade() {
            refresh(&window, &callback_catalog, &callback_state);
        }
    });

    let weak = window.as_weak();
    window.on_toggle_batch(move || {
        if let Some(window) = weak.upgrade() {
            window.set_batch_view(!window.get_batch_view());
        }
    });

    let weak = window.as_weak();
    let batch_catalog = catalog.clone();
    window.on_run_batch(move |input| {
        let mut rows = Vec::new();
        for id in input.lines().map(str::trim).filter(|id| !id.is_empty()) {
            let result = match_model(&batch_catalog.models, id, false);
            if let Some(model) = result.model {
                let kind = match result.kind {
                    MatchKind::Exact => "精确",
                    MatchKind::Alias => "别名",
                    MatchKind::Legacy => "旧版 ID",
                    MatchKind::Normalized => "归一化",
                    MatchKind::Fuzzy => "未收录",
                    MatchKind::None => "未收录",
                };
                rows.push(format!("[OK] {id} → {}（{kind}）", model["id"]));
            } else if let Some(suggestion) = result.suggestion {
                rows.push(format!("[?] {id} → 最接近：{suggestion}"));
            } else {
                rows.push(format!("[?] {id} → 未收录"));
            }
        }
        if let Some(window) = weak.upgrade() {
            window.set_batch_output(SharedString::from(rows.join("\n")));
        }
    });

    let weak = window.as_weak();
    window.on_copy_output(move || {
        if let Some(window) = weak.upgrade() {
            let text = if window.get_batch_view() {
                window.get_batch_output().to_string()
            } else {
                window.get_output_text().to_string()
            };
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(text);
            }
        }
    });

    window.run().map_err(|error| error.to_string())
}
