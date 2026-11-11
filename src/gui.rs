// 桌面 GUI：GPUI（gpui-kit）实现，功能与原 Slint 版 1:1 对齐：
//   单条查询（搜索 / 厂商 / 状态 / 仅已核验 / 模型列表 / 规格详情 / 配置片段）
//   批量解析（每行一个 id，解析结果可复制）
//
// catalog 加载、match_model、render::card、render::emit 全部复用 apifix 共享库，
// 保证 GUI 输出与 CLI 逐字节一致。GPU 不可用时窗口创建失败，由 main 打印 CLI 兜底提示。

use apifix::{
    catalog,
    matching::{MatchKind, match_model},
    model_label, render,
};
use gpui_kit::component::button::Button;
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::searchable_list::SearchableVec;
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, ClipboardItem, Context, Entity, IntoElement, Render, Subscription, Window,
    WindowOptions, div, px,
};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

const EMITTERS: [&str; 6] = ["opencode", "pi", "codex", "claude-env", "curl", "sdk"];
const ALL_VENDORS: &str = "所有厂商";
const ALL_LIFECYCLE: &str = "所有状态";

// ---------- 状态 ----------

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

// ---------- 主视图 ----------

struct AppView {
    catalog: Rc<catalog::Catalog>,
    state: Rc<RefCell<ViewState>>,
    search: Entity<InputState>,
    vendor_select: Entity<SelectState<SearchableVec<String>>>,
    lifecycle_select: Entity<SelectState<SearchableVec<String>>>,
    emitter_select: Entity<SelectState<SearchableVec<String>>>,
    batch_input: Entity<TextareaState>,
    batch_output: String,
    batch_view: bool,
    catalog_status: String,
    _subscriptions: Vec<Subscription>,
}

impl AppView {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let catalog = Rc::new(
            catalog::load_bundled().unwrap_or_else(|_| catalog::Catalog {
                models: Vec::new(),
                updated_at: None,
            }),
        );

        let state: Rc<RefCell<ViewState>> = Rc::new(RefCell::new(ViewState::default()));
        if let Some(model) = catalog
            .models
            .iter()
            .find(|m| m["id"] == "gpt-6.1-sol")
            .or_else(|| catalog.models.first())
        {
            state.borrow_mut().selected_id = model["id"].as_str().unwrap_or("").to_owned();
        }

        // 厂商选项：所有厂商 + 目录内厂商（BTreeSet 保证确定性）
        let mut vendors = BTreeSet::new();
        for model in &catalog.models {
            if let Some(vendor) = model["vendor"].as_str() {
                vendors.insert(vendor.to_owned());
            }
        }
        let mut vendor_options = vec![ALL_VENDORS.to_owned()];
        vendor_options.extend(vendors);

        let lifecycle_options: Vec<String> =
            [ALL_LIFECYCLE, "current", "legacy", "retired", "unreleased"]
                .into_iter()
                .map(str::to_owned)
                .collect();
        let emitter_options: Vec<String> = EMITTERS.iter().map(|s| (*s).to_owned()).collect();

        let search = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_placeholder("搜索模型 ID、厂商或别名", window, cx);
            input
        });
        let vendor_select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(vendor_options),
                Some(gpui_kit::component::IndexPath::default().row(0)),
                window,
                cx,
            )
        });
        let lifecycle_select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(lifecycle_options),
                Some(gpui_kit::component::IndexPath::default().row(0)),
                window,
                cx,
            )
        });
        let emitter_select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(emitter_options),
                Some(gpui_kit::component::IndexPath::default().row(0)),
                window,
                cx,
            )
        });
        let batch_input = cx.new(|cx| {
            let mut input = TextareaState::new(window, cx);
            input.set_placeholder("每行一个模型 ID", window, cx);
            input
        });

        let catalog_status = format!(
            "{} models · updated {}",
            catalog.models.len(),
            catalog.updated_at.as_deref().unwrap_or("unknown")
        );

        // 事件接线：输入框打字 / 三个下拉选择变化
        let view_id = cx.entity().entity_id();

        let mut subscriptions = Vec::new();

        subscriptions.push(cx.subscribe_in(
            &search,
            window,
            |this: &mut Self, _input, event: &InputEvent, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.state.borrow_mut().query = this.search.read(cx).value().to_string();
                    cx.notify();
                }
            },
        ));

        subscriptions.push(cx.subscribe_in(
            &vendor_select,
            window,
            |this: &mut Self, _select, event: &SelectEvent<SearchableVec<String>>, _window, cx| {
                if let SelectEvent::Confirm(Some(value)) = event {
                    let mut state = this.state.borrow_mut();
                    state.vendor = (value != ALL_VENDORS).then(|| value.clone());
                    drop(state);
                    cx.notify();
                }
            },
        ));

        subscriptions.push(cx.subscribe_in(
            &lifecycle_select,
            window,
            |this: &mut Self, _select, event: &SelectEvent<SearchableVec<String>>, _window, cx| {
                if let SelectEvent::Confirm(Some(value)) = event {
                    let mut state = this.state.borrow_mut();
                    state.lifecycle = (value != ALL_LIFECYCLE).then(|| value.clone());
                    drop(state);
                    cx.notify();
                }
            },
        ));

        subscriptions.push(cx.subscribe_in(
            &emitter_select,
            window,
            |this: &mut Self, _select, event: &SelectEvent<SearchableVec<String>>, _window, cx| {
                if let SelectEvent::Confirm(Some(value)) = event {
                    this.state.borrow_mut().emitter = value.clone();
                    cx.notify();
                }
            },
        ));

        let _ = view_id;
        Self {
            catalog,
            state,
            search,
            vendor_select,
            lifecycle_select,
            emitter_select,
            batch_input,
            batch_output: String::new(),
            batch_view: false,
            catalog_status,
            _subscriptions: subscriptions,
        }
    }

    /// 当前选中模型要展示的（详情, 配置片段）。
    fn current_texts(&self) -> (String, String) {
        let state = self.state.borrow().clone();
        let matched = match_model(&self.catalog.models, &state.selected_id, false);
        if let Some(model) = matched.model {
            (
                render::card(model),
                render::emit(model, &state.emitter, state.full).unwrap_or_else(|error| error),
            )
        } else if let Some(suggestion) = matched.suggestion {
            (format!("未收录\n最接近的模型：{suggestion}"), String::new())
        } else {
            ("未收录".to_owned(), String::new())
        }
    }

    /// 按当前筛选条件得到的模型行。
    fn filtered_rows(&self) -> Vec<String> {
        let state = self.state.borrow().clone();
        self.catalog
            .filtered(
                &state.query,
                state.vendor.as_deref(),
                state.verified_only,
                state.lifecycle.as_deref(),
            )
            .iter()
            .map(|model| model_label(model))
            .collect()
    }

    fn run_batch(&mut self, cx: &mut Context<Self>) {
        let input = self.batch_input.read(cx).value().to_string();
        let mut lines = Vec::new();
        for id in input.lines().map(str::trim).filter(|id| !id.is_empty()) {
            let result = match_model(&self.catalog.models, id, false);
            if let Some(model) = result.model {
                let kind = match result.kind {
                    MatchKind::Exact => "精确",
                    MatchKind::Alias => "别名",
                    MatchKind::Legacy => "旧版 ID",
                    MatchKind::Normalized => "归一化",
                    MatchKind::Fuzzy | MatchKind::None => "未收录",
                };
                lines.push(format!("[OK] {id} → {}（{kind}）", model["id"]));
            } else if let Some(suggestion) = result.suggestion {
                lines.push(format!("[?] {id} → 最接近：{suggestion}"));
            } else {
                lines.push(format!("[?] {id} → 未收录"));
            }
        }
        self.batch_output = lines.join("\n");
        cx.notify();
    }

    fn copy_output(&self, cx: &mut App) {
        let text = if self.batch_view {
            self.batch_output.clone()
        } else {
            self.current_texts().1
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    // ---------- 渲染 ----------

    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let batch_view = self.batch_view;
        let status = self.catalog_status.clone();

        h_flex()
            .h(px(68.))
            .px_5()
            .gap_4()
            .items_center()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .text_xl()
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .child("apifix"),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("模型官网参数"),
            )
            .child(
                Button::new("toggle-batch")
                    .label(if batch_view {
                        "单条查询"
                    } else {
                        "批量解析"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_batch(cx))),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(status),
            )
            .into_any_element()
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let rows = self.filtered_rows();
        let state = self.state.clone();
        let id = cx.entity().entity_id();

        v_flex()
            .w_full()
            .flex_1()
            .min_h_0()
            .gap_1()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child(format!("模型目录（{}）", rows.len())),
            )
            .child(
                div()
                    .id("model-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(rows.into_iter().enumerate().map(move |(index, label)| {
                        // label 形如 "vendor  ·  id  ·  family"，取 id 段
                        let model_id = label.split("  ·  ").nth(1).unwrap_or_default().to_owned();
                        let state = state.clone();
                        let id = id;
                        Button::new(("row", index))
                            .label(label)
                            .on_click(move |_, _, app: &mut App| {
                                state.borrow_mut().selected_id = model_id.clone();
                                app.notify(id);
                            })
                            .into_any_element()
                    })),
            )
            .into_any_element()
    }

    fn render_detail(&self, cx: &mut Context<Self>) -> AnyElement {
        let (detail, output) = self.current_texts();
        let state = self.state.clone();
        let id = cx.entity().entity_id();
        let full = self.state.borrow().full;

        v_flex()
            .flex_1()
            .min_w(px(0.))
            .min_h_0()
            .h_full()
            .gap_2()
            .child(
                h_flex().gap_2().items_center().child(
                    div()
                        .text_base()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child("规格详情"),
                ),
            )
            .child(
                div()
                    .id("detail-scroll")
                    .w_full()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .text_sm()
                    .child(detail),
            )
            .child(div().h(px(1.)).w_full().bg(cx.theme().border))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child("配置片段"),
                    )
                    .child(Select::new(&self.emitter_select).menu_width(px(180.)))
                    .child({
                        let state = state.clone();
                        Checkbox::new("full-mode")
                            .label("完整模式")
                            .checked(full)
                            .on_change(move |checked, _, app: &mut App| {
                                state.borrow_mut().full = *checked;
                                app.notify(id);
                            })
                    })
                    .child(div().flex_1())
                    .child(
                        Button::new("copy")
                            .label("复制")
                            .on_click(cx.listener(|this, _, _, cx| this.copy_output(cx))),
                    ),
            )
            .child(
                div()
                    .id("output-scroll")
                    .w_full()
                    .h(px(220.))
                    .overflow_y_scroll()
                    .text_sm()
                    .child(output),
            )
            .into_any_element()
    }

    fn render_single(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = self.state.clone();
        let id = cx.entity().entity_id();
        let verified = self.state.borrow().verified_only;

        h_flex()
            .flex_1()
            .min_h_0()
            .items_start()
            .p_3()
            .gap_3()
            .child(
                v_flex()
                    .w(px(300.))
                    .h_full()
                    .min_h_0()
                    .gap_2()
                    .child(Input::new(&self.search))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().text_sm().child("厂商"))
                            .child(div().flex_1().child(Select::new(&self.vendor_select))),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().text_sm().child("状态"))
                            .child(div().flex_1().child(Select::new(&self.lifecycle_select))),
                    )
                    .child({
                        let state = state.clone();
                        Checkbox::new("verified-only")
                            .label("仅已核验")
                            .checked(verified)
                            .on_change(move |checked, _, app: &mut App| {
                                state.borrow_mut().verified_only = *checked;
                                app.notify(id);
                            })
                    })
                    .child(self.render_list(cx)),
            )
            .child(self.render_detail(cx))
            .into_any_element()
    }

    fn render_batch(&self, cx: &mut Context<Self>) -> AnyElement {
        let output = if self.batch_output.is_empty() {
            "（解析结果会显示在这里）".to_owned()
        } else {
            self.batch_output.clone()
        };

        v_flex()
            .flex_1()
            .min_h_0()
            .p_4()
            .gap_2()
            .child(
                div()
                    .text_lg()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child("批量解析"),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("左侧每行一个模型 ID，点「解析」后在右侧查看匹配结论"),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h_0()
                            .child(Textarea::new(&self.batch_input).h_full()),
                    )
                    .child(
                        v_flex().flex_1().min_w(px(0.)).min_h_0().child(
                            div()
                                .id("batch-output-scroll")
                                .size_full()
                                .overflow_y_scroll()
                                .text_sm()
                                .child(output),
                        ),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("run-batch")
                            .label("解析")
                            .on_click(cx.listener(|this, _, _, cx| this.run_batch(cx))),
                    )
                    .child(
                        Button::new("copy-batch")
                            .label("复制结果")
                            .on_click(cx.listener(|this, _, _, cx| this.copy_output(cx))),
                    ),
            )
            .into_any_element()
    }
}

impl Render for AppView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = self.render_header(cx);
        let body = if self.batch_view {
            self.render_batch(cx)
        } else {
            self.render_single(cx)
        };

        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(header)
            .child(body)
    }
}

// toggle-batch 按钮需要改 batch_view，而按钮回调只给 &mut App，
// 因此用 App 上的实体通知 + 一个“切换”标记。
impl AppView {
    fn toggle_batch(&mut self, cx: &mut Context<Self>) {
        self.batch_view = !self.batch_view;
        cx.notify();
    }
}

// ---------- 入口 ----------

pub fn run() -> Result<(), String> {
    let failure: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let failure_in = failure.clone();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);

        let options = WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some("apifix · 模型规格速查".into()),
                ..Default::default()
            }),
            window_bounds: Some(gpui_kit::WindowBounds::Windowed(
                gpui_kit::Bounds::centered(None, gpui_kit::size(px(1220.), px(800.)), cx),
            )),
            ..Default::default()
        };

        let opened = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| AppView::new(window, cx))
        });

        if let Err(error) = opened {
            *failure_in.borrow_mut() = Some(format!(
                "GPU 不可用或窗口创建失败：{error}\n\
                 请改用 CLI：cargo run -- <model-id>"
            ));
        }
    });

    let error = failure.borrow_mut().take();
    match error {
        Some(message) => Err(message),
        None => Ok(()),
    }
}
