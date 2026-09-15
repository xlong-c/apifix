# apifix

[中文](README.md) | [English](README.en.md)

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![dependencies](https://img.shields.io/badge/dependencies-0-success.svg)
![models](https://img.shields.io/badge/models-325-informational.svg)

Give it a model ID — usually a legacy name a relay kept alive — and get back the **official spec** plus a
paste-ready config snippet for opencode or pi.

Zero dependencies, zero network requests, and it never reads your local config.

## Why you need this

- **Relays don't invent new IDs — they keep old ones.** When a vendor renames or retires a model, relays keep
  serving it under the old name. That's how names like `deepseek-v4.1-flash` spread, even though it was never
  a stable official ID.
- **The numbers in your config are usually wrong or stale.** Relays fill in context / max output themselves,
  those values drift as upstream changes, and nobody ever re-checks that one line in the client.
- **"Dumbing down" happens silently.** In thinking mode, `temperature` is simply ignored, `top_p` has a floor,
  and unsupported effort levels quietly collapse into other levels. Behavior changed — your config won't tell you.
- **Switching models means reading 22 vendors' docs.** Every vendor draws the lines differently for reasoning
  levels, sampling constraints, caching, and tool calling.
- **apifix does one thing**: lay out the official spec and generate a snippet. Undocumented values are `null`.
  It never guesses.

## A real example

A relay config for `deepseek-v4.1-flash`, against the official `deepseek-flash` spec:

| Field | Your config | Official spec |
| --- | --- | --- |
| context | 1,000,000 | 1,048,576 |
| max output | 384,000 | 393,216 |
| effort levels | low/high/max | none/low/high/max |

Three fields, three discrepancies. `deepseek-v4.1-flash` was never a stable official ID: the official V4.1
test ID was `deepseek-v4.1-flash-expires-on-0910` (expired by design), the production ID is `deepseek-flash`,
and the relay simply dropped the suffix and kept going.

The context and max-output gaps come from upstream revisions. The **missing `none`** effort level means that
under this config you cannot turn thinking off.

Now the "dumbing down" angle: DeepSeek **silently ignores** `temperature` in thinking mode, `top_p` effectively
floors at 0.95, and levels like `medium` / `xhigh` get quietly folded into `high`. All of this surfaces in
apifix's 注意事项 (gotchas) and in the generated snippets.

## Quick start

```bash
git clone <repo> && cd apifix          # no npm install needed: zero dependencies
node apifix.mjs deepseek-v4.1-flash    # opencode snippet by default (key stays the ID you typed)
npm start                              # = node apifix.mjs --ui, opens the local Web UI
```

Common commands:

```bash
node apifix.mjs <id>                   # opencode snippet; stdout is pure JSON, notes go to stderr
node apifix.mjs <id> --emit pi         # pi snippet; also codex|claude-env|curl|sdk
node apifix.mjs <id> -f                # full mode: adds family/status/modalities/cost, etc.
node apifix.mjs <id> --card            # box card: full spec table + gotchas + sources
node apifix.mjs <id> --json            # raw catalog entry (every field)
node apifix.mjs <id> --name MCGDS      # override the display name in the snippet
node apifix.mjs <id> --canonical-id    # key uses the canonical ID (e.g. deepseek-flash)
node apifix.mjs --list                 # all IDs grouped by vendor; --list --json for scripts
node apifix.mjs --match ids.txt        # batch-match a file, one verdict per line
node apifix.mjs --version | --help
```

Exit codes: `0` success, `1` unmatched, `2` usage or file error.

### Protocol overview (`protocols`)

One command to see **which protocol every provider in every tool config actually speaks**, checked
against each model's native protocol:

```bash
node apifix.mjs protocols            # auto-scans ~/.config/opencode, ~/.pi, ~/.claude, ~/.codex
node apifix.mjs protocols --json     # machine-readable; --no-defaults scans only --file paths
```

A protocol mismatch means the relay must translate, so parameters like `thinking`/`temperature` can
be silently dropped ("dumbed down"). The report marks each row `✓ match` / `⚠ native X (translation
required)` / `? protocol uncertain` and summarizes mismatching providers at the end.
Supports opencode (`npm` + `baseURL` inference), pi (`api` field), claude-code
(`ANTHROPIC_BASE_URL`), and codex (`wire_api` in `config.toml`); multi-protocol pipe values (e.g.
`chat_completions|responses|anthropic_messages`) count as a match for any listed protocol.

## Web UI

```bash
node apifix.mjs --ui                   # defaults to http://127.0.0.1:7788/
node apifix.mjs --ui --port 8000 --no-open
```

![apifix Web UI](docs/ui.png)

- **Single lookup**: three panes — filters by vendor / lifecycle on the left, a result list with match cards in
  the middle, and details on the right (spec table, gotchas, opencode / pi snippet tabs with a
  **minimal / full** toggle).
- **Batch parse**: paste a list of IDs and get a match verdict plus the resolved entry for each line.

![Batch parse](docs/batch.png)

It binds `127.0.0.1` only and serves just `/`, `/ui/*`, `/lib/*`, and `/catalog.json`. If the port is taken it
retries at +1 (up to +10).

The UI is **fully static** (`ui/` + `lib/core.mjs` + `catalog.json`), so publishing the repo root as a site root
is enough to run it on GitHub Pages: the root `index.html` redirects to `/ui/`.

## Coverage

325 entries across 22 vendors:

| vendor | count | vendor | count | vendor | count |
| --- | ---: | --- | ---: | --- | ---: |
| openai | 63 | anthropic | 24 | alibaba | 42 |
| zhipu | 21 | moonshot | 20 | baidu | 17 |
| google | 17 | cohere | 15 | mistral | 12 |
| tencent | 11 | volcengine | 11 | deepseek | 10 |
| nvidia | 8 | amazon | 7 | iflytek | 7 |
| microsoft | 7 | meta | 7 | xai | 16 |
| minimax | 5 | 01ai | 3 | ai21 / writer | 1 each |

Lifecycle: `current` 148, `legacy` 92, `retired` 82, `unreleased` 2. 315 entries are verified against official docs.

**Pricing**: 229 models carry official USD pricing (per 1M tokens). Non-USD prices are converted at merge time
using a fixed reference rate of 1 USD = 7.2 CNY, with the original values kept in `cost.note`. That rate is a
reference, not a live quote.

## Matching rules

Tried in order: **canonical ID → aliases → legacy_ids** → strip vendor prefix (`openai/`, `anthropic/`, `meta/`,
`google/`, `x-ai/`, `deepseek/`, `moonshotai/`, `z-ai/`, `qwen/`, `minimax/`, and more) → strip relay suffix
(`-free`, `-preview`, `-exp`, `-latest`, `-build`, `-contributor`, `-vision-exp`, `-expires-on-*`, `-ga-*`,
`-YYYYMMDD`, `-vN`) → separator-insensitive (`-`, `.`, `_` are equivalent, so `glm-5-3-flash` hits
`glm-5.3-flash`) → fuzzy fallback (similarity ≥ 0.75, suggestion only).

`--match` labels: `[OK]` exact, `[A]` alias, `[L]` legacy, `[~]` normalized, `[?]` unmatched.
Notes go to **stderr** only, so stdout stays paste-ready:

```
[i] deepseek-v4.1-flash 是旧版/退役 id，对应 deepseek-flash；中转仍在沿用，值按官网当前规格输出
```

Note: `-free` is a **third-party / relay convention** (OpenCode Zen, AIHubMix, and others; OpenRouter uses the
colon form `:free`). It is **not** a vendor naming convention — official free tiers get their own model names
(such as `GLM-4.7-Flash`).

## Full mode (`-f`)

By default only 7 core fields are emitted. `-f` adds every derivable field the catalog can supply: `opencode`
gains `family`, `status` (`current`→active / `legacy`/`retired`→deprecated / `unreleased`→beta), `modalities`
(input derived from `vision`/`pdf`), and `cost` (when official pricing exists); `pi` gains `api`
(`anthropic_messages`→anthropic-messages, `responses`→openai-responses, `chat_completions`→openai-completions;
`native`/`gemini`/null are omitted).

`cost` is always **USD per 1M tokens** (`input`/`output`/`cache_read`/`cache_write`/`context_over_200k`, with
null keys omitted; if either `input` or `output` is missing, `cost` is omitted entirely). Fields the catalog has
no official data for (opencode's release_date/interleaved/experimental/options/headers, pi's
provider/baseUrl/compat/cost) are **omitted**, with a single `[i]` note on stderr — that note is dynamic, so
`cost` drops out of the list once it is emitted.

`-f` applies only to `--emit opencode|pi` (other targets print a notice and ignore it);
`--card`/`--json`/`--list`/`--match` already show complete data.

```bash
node apifix.mjs deepseek-flash -f              # full opencode mode (with cost)
node apifix.mjs gpt-5.6-sol --emit pi -f       # full pi mode
```

## Data provenance and trust

- **Only vendor-official docs** (model pages, API docs, pricing pages). Aggregators, relay dashboards, and
  forums are not sources.
- **`null` means "not documented"**, not zero; it renders as `未知/not documented`. Better empty than invented.
- **`verified`**: `true` means every field was checked against official docs (315/325); `false` means the source
  is indirect or pending, and the card says so explicitly.
- **`confidence`** (`high`/`medium`/`low`) works together with `sources`, so every value is traceable.
- Lifecycle and `legacy_ids` record retirements and relay-reused IDs; **retired models show their pre-retirement spec**.

Known limitations: the catalog is a static snapshot and does not auto-update; fuzzy matching only suggests, it
never auto-corrects; `ark-code-latest` is a routing alias whose real spec depends on the console selection; keys
in `curl`/`sdk` snippets need environment variables you set yourself.

## Project layout

```
apifix/
├── apifix.mjs        CLI + local UI server (zero dependencies)
├── lib/core.mjs      Shared core (pure ESM, importable in the browser)
├── ui/               Web UI (fully static)
├── catalog.json      Official specs for 325 models (the data source)
├── tools/            Merge + validate scripts (used by CI)
├── incoming/         Raw research batches (traceable provenance)
├── legacy-python/    Original Python implementation (reference only)
└── skills/           Companion AI skills (model-spec-lookup / catalog-maintain)
```

## FAQ

**Where does the data come from?**
Entirely from vendor-official docs, each entry carrying `sources` links. The raw research batches live in
`incoming/` for traceability.

**Why is my ID unmatched?**
It may be neither an official ID nor a known alias or legacy ID (relay-invented names, for example). Run
`--match` over a file: unmatched lines get the closest candidate. If it's a real model, add it per
[CONTRIBUTING.md](CONTRIBUTING.md).

**Is the pricing accurate?**
Prices come from official pricing pages, are stamped with `as_of`, and carry a `confidence` rating. They are a
**static snapshot**, not real-time; for frequently repriced models, trust your vendor invoice. Non-USD prices are
converted at a 1 USD = 7.2 CNY reference rate, with originals preserved in `cost.note`.

**Does it read or upload my config?**
No. apifix never touches `opencode.json` / `models.json` and makes zero network requests. It only does
"input ID → official spec → snippet".

**How does it relate to cc-switch?**
It doesn't — no dependency either way. The generated snippets paste straight into your relay config, so the two
can be used together.

**How do I add or fix a model?**
See [CONTRIBUTING.md](CONTRIBUTING.md): drop research into `incoming/`, run `npm run merge`, then
`npm run validate` (CI runs it on every push/PR).

## Contributing

New models and corrections to stale specs are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — the one
rule that matters most: **cite only official docs, and write `null` for anything undocumented.**

## License

[MIT](LICENSE)
