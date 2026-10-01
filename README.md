# pi-nimble-compact

Automatic tool-output pruning for [Pi](https://pi.dev), powered by [Bespoke Nimble](https://github.com/bespokelabsai/nimble). Replace stale outputs with retrieval markers, shorten retained long outputs, and recover originals from session history without rerunning commands.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands-and-retrieval) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Development](#development)

- **Local scoring by default:** Nimble runs through Ollama; the plugin does not replace your main coding model.
- **Original evidence preserved:** pruning changes the model-facing projection, not the saved tool output.
- **Branch-local decisions:** pruning survives reopening a session and can be released with `/nimble-reset`.
- **Normal Pi compaction stays enabled:** scoring runs asynchronously and applies at a later model-request boundary.

Adapted from [Nour Helmi's pi-jev-compaction](https://github.com/nourhelmi/pi-jev-compaction) and [tamaratran's fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Import revisions and attribution are recorded in [NOTICE.md](NOTICE.md).

> [!IMPORTANT]
> Truncation keeps the first and last 300 characters; it is not semantic summarization. Evidence in the middle may require retrieval. Smaller context does not guarantee lower token usage or cost.

## Quick start

### Requirements

- [Node.js](https://nodejs.org/) **22.19+**.
- [Pi](https://pi.dev), tested with **0.99.2**, and a configured main model.
- [Ollama](https://ollama.com/download) **0.35+**, running locally, with enough memory for [Nimble](https://ollama.com/library/nimble).

Check `ollama --version`, then start the Ollama app or service. If you run the service manually, use `ollama serve` in another terminal; do not start a second instance on port 11434.

```sh
ollama pull nimble
pi install git:github.com/SirDarcanos/pi-nimble-compact
pi
```

Inside Pi, run `/nimble-status` to inspect configuration and pruning activity. Clearing starts when context reaches the configured trigger, not immediately after installation.

The default endpoint is `http://127.0.0.1:11434/v1/systemone`, model `nimble`, with no API key. Ollama and its model weights are installed separately; the plugin does not download weights, launch a server, or change Ollama settings. No Python bridge is required.

To try a repository checkout without installing the package:

```sh
npm ci
pi -e ./extensions/nimble.ts
```

## How it works

1. **Wait for context pressure.** Evaluate at the lesser of 120,000 tokens or 45% of the model's context window, protecting the most recent 12,000 estimated tokens and complete parallel tool batches.
2. **Select eligible outputs.** Consider up to 16 successful text outputs of at least 2,000 characters. Complete rereads, identical successful test reruns, and supported diagnostics or checkpoint tools can supersede older evidence.
3. **Score uncertain evidence.** Fit conversation history into a 2,000-estimated-token scoring state, add bounded output excerpts, and ask Nimble whether each result needs to remain verbatim.
4. **Apply two tiers.** Superseded results or scores below the default 0.25 keep threshold become retrieval markers. Explicitly retained results longer than 4,000 characters can become head/tail excerpts with a marker between them.
5. **Check cache payback.** Apply a combined clearing/truncation batch only when its estimated reduction passes the cache-rewrite payback gate; deferred outputs stay intact.

User and assistant prose, tool calls, thinking/signatures, message order, and summaries are preserved by this plugin. Failed outputs, images, ambiguous call/result pairs, credential-file reads, `AGENTS.md`/`SKILL.md` reads, tool-loading results, retrieval responses, and protected coordination tools are excluded. Sensitive inputs and obvious secret-bearing output are screened out of scoring.

Results apply only at a later request boundary. Branch changes, new user tasks, or compaction invalidate in-flight scoring. If scoring fails, no new clearing or truncation decisions are applied.

### What is stored

Complete originals remain in Pi's on-disk session history. Closing Pi, starting `/new`, or normal compaction does not delete old session files. Retrieval belongs to the original session's active branch; it does not search other sessions. Deleting the session files deletes the saved originals.

## Commands and retrieval

| Command or tool | Purpose |
| --- | --- |
| `/nimble-status` | Show configuration, the last evaluation, branch-local mask counts, and cumulative estimated context removed. |
| `/nimble-reset` | Release clearing and truncation on the active branch without deleting originals. |
| `nimble_read` | Let the model retrieve original cleared or truncated tool output using the reference in its marker. |

A cleared result looks like this:

```text
[pi-nimble: older tool output cleared from context; original retained in this session.
Retrieve with nimble_read({"ref":"…"}). Do not rerun a side-effecting command to recover its output.]
```

For both tiers, the model uses the marker's actual `ref`. Optional `offset` and `limit` are **character counts**: offset starts at 0, pages default to 8,000 characters, and each page is capped at 16,000. Retrieval reads the saved output even if the source file has since changed.

Interactive Pi shows `ready`, `checking…`, `paused`, `dormant`, or `error` alongside estimated context saved. This cumulative estimate is not a billing-savings counter and is not reset by branch navigation, reloads, or `/nimble-reset`.

> [!WARNING]
> Keep `nimble_read` enabled in tool allowlists. Disabling it restores full projected outputs and pauses new pruning. Avoid loading another general-purpose context-pruning extension alongside this one. Provider-native Codex checkpoints also pause pruning on their branch; retrieval remains available.

## Releases

The npm package is named `pi-nimble-compact`. See [the release guide](https://github.com/SirDarcanos/pi-nimble-compact/blob/main/docs/releasing.md) for first-publish setup, version preparation, and GitHub Actions trusted publishing.

## Configuration

Environment variables are read when the extension loads. Invalid numeric values fall back to defaults. Restart Pi after changing shell variables; `/reload` cannot import exports made in another shell.

| Variable | Default | Meaning / accepted range |
| --- | --- | --- |
| `PI_NIMBLE_URL` | `http://127.0.0.1:11434/v1/systemone` | Full decision endpoint; an explicitly empty value disables pruning. |
| `PI_NIMBLE_MODEL` | `nimble` | Advanced override: Nimble model tag or checkpoint ID; other model families are not supported. |
| `NIMBLE_API_KEY` | unset | Optional bearer token; not required for local Ollama. |
| `PI_NIMBLE_THRESHOLD` | `0.45` | Context-window fraction trigger; `0.1`–`0.95`. |
| `PI_NIMBLE_TRIGGER_TOKENS` | `120000` | Absolute token trigger; `8000`–`2000000`. |
| `PI_NIMBLE_KEEP_THRESHOLD` | `0.25` | Retain scores at or above this value; `0`–`1`. |
| `PI_NIMBLE_KEEP_RECENT_TOKENS` | `12000` | Protected recent token window; `2000`–`100000`. |
| `PI_NIMBLE_MAX_PAYBACK_TURNS` | `20` | Maximum estimated cache-rewrite payback horizon; `1`–`1000`. |
| `PI_NIMBLE_TIMEOUT_MS` | `30000` | Scoring deadline in milliseconds; `100`–`180000`. |
| `PI_NIMBLE_TRUNCATE_MIN_CHARS` | `4000` | Shorten explicitly retained outputs above this length; `0` disables new truncation, maximum `2000000`. |

Leave `PI_NIMBLE_MODEL` unset for the default `ollama pull nimble` setup. Override it only to select another Nimble tag (such as `nimble:q8_0`) or a checkpoint ID used by your Nimble server.

To stop new truncation, set `PI_NIMBLE_TRUNCATE_MIN_CHARS=0`. Existing truncation decisions persist until `/nimble-reset`. To disable pruning entirely on the next launch:

```sh
PI_NIMBLE_URL="" pi
```

### Alternate Nimble server

For a separately deployed server, follow [Nimble's serving guide](https://github.com/bespokelabsai/nimble/blob/main/docs/MODAL_SERVING.md) and set its endpoint and Nimble checkpoint ID:

```sh
export PI_NIMBLE_URL="http://127.0.0.1:8000/v1/systemone"
export PI_NIMBLE_MODEL="nimble-latest"
pi
```

Remote endpoints require HTTPS; HTTP is allowed only on loopback hosts. URLs containing credentials, query parameters, or fragments are rejected. Only optional bearer authentication is supported, not Modal proxy-key headers. Set `NIMBLE_API_KEY` separately if your server requires it. The plugin does not contact Jev, use `TYPESAFE_API_KEY`, or fall back to another classifier.

## Privacy and limitations

Scoring requests go only to the configured Nimble endpoint, locally by default. They contain fitted user/assistant prose and summaries, screened tool names and inputs, output lengths, and bounded head/tail excerpts. Thinking, signatures, images, custom messages, and result metadata are omitted; complete tool outputs stay in the session.

Requests are limited to 24,000 UTF-8 bytes and 6,000 estimated tokens; responses to 64,000 bytes. The estimator is not a Nimble tokenizer. Redirects are refused, and keys and response bodies are not logged. Common secret patterns are redacted, but this is heuristic screening rather than a complete secret scanner. Use a trusted endpoint and keep credentials out of ordinary tool output; a remote endpoint receives the scoring content.

Pruning can misjudge relevance, and head/tail clipping can omit unique constraints. Retrieve originals before relying on omitted evidence. Outputs dropped from the scoring request budget are not shortened.

The payback gate uses inherited Anthropic-style cache assumptions: writes at 1.25× input cost and reads at 0.1×. These are not pricing guarantees for your provider. Retrieval adds tool calls, output, and model turns, which can outweigh context reduction in short tasks.

## Troubleshooting

### Check the decision endpoint

Use `/v1/systemone`, not `ollama run nimble` or the ordinary chat/generate APIs:

```sh
curl --fail-with-body --max-time 120 http://127.0.0.1:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"nimble","state":"A newer complete test run supersedes an older identical successful run.","questions":{"keep":{"type":"noul","instructions":"Does the older run still need to stay verbatim?"}}}'
```

A successful response contains `answers.keep.noul`, a probability between 0 and 1. This also warms the model before the plugin's shorter scoring deadline.

| Symptom | Check |
| --- | --- |
| Connection refused | Start Ollama and confirm the configured endpoint and port. |
| Model missing | Run `ollama pull nimble`. |
| `/v1/systemone` missing | Update Ollama to 0.35 or later. |
| Unexpected endpoint or model | Unset old `PI_NIMBLE_URL` / `PI_NIMBLE_MODEL` overrides and restart Pi. |
| `dormant` | Check whether `PI_NIMBLE_URL` was explicitly set to an empty value. |
| `paused` | Check the `nimble_read` allowlist and provider-native Codex checkpoint status. |
| No outputs pruned | Inspect `/nimble-status`: context may be below the trigger, outputs may be protected, or the payback gate may defer the batch. |
| Timeout, `503`, or `529` | Warm or check the scoring service; the plugin applies no new decisions and does not retry in a loop. |
| Remote `401` | Verify your endpoint's authentication; Modal proxy authentication is unsupported. |

Pi's normal manual, threshold, and overflow compaction remain available when Nimble is unavailable.

## Development

From a repository checkout:

```sh
npm ci
npm run check
npm pack --dry-run
# Optional: sends a canned fixture to local Ollama with Nimble installed
npm run smoke:ollama
```

The default suite uses synthetic sessions and mocked scoring responses. It covers projection, persistence/reset, branch safety, paging, SDK integration, package loading, transport limits, and failure handling. The Pi 0.99.2 development dependency tree has a documented `brace-expansion` advisory pinned by its shrinkwrap; this project does not claim to resolve existing dependency alerts.

### Task-quality trials

```sh
# Three tasks × three conditions × two repeats: makes main-model requests
npm run quality:run -- --trials 2

# Single-task, single-arm smoke trial
npm run quality:run -- --trials 1 --task contract --arm two-tier
```

The default main agent is **openai-codex / gpt-6.1-sol**, using existing Pi credentials. Override with `--provider` and `--model`; unavailable models fail without substitution. Tasks cover a buried contract, historical receipt recovery after its file changes, and accurate historical test counts with instruction-like diagnostic content.

Each condition receives an exact clone of the captured starting state in a fresh workspace and SDK session. Independent checks evaluate behavior, current tests, final JSON reporting, and repeated side effects. Reports under ignored `local-data/quality/` include usage/cache fields, retrieval requests, test runs, timing, and compaction activity. SDK cost estimates are not measured bills.

> [!NOTE]
> These are fixed stress masks, not Nimble predictions or a live extension-lifecycle benchmark. The initial 18 trials passed, but both compacted conditions used more aggregate tokens than baseline. Three repeated templates do not establish general task-quality parity or savings. The harness executes model-written JavaScript locally and is not an OS security sandbox; use controlled synthetic tasks only. See [PR #3](https://github.com/SirDarcanos/pi-nimble-compact/pull/3) for the initial findings.

### Repository map

| Path | Contents |
| --- | --- |
| [`extensions/nimble.ts`](extensions/nimble.ts) | Pi lifecycle, persistence, status, reset, and retrieval tool. |
| [`src/pruning.ts`](src/pruning.ts) | Candidate selection, scoring, projection, and cache-payback policy. |
| [`src/engine/`](src/engine/) | Adapted tool pairing, history fitting, and token estimation. |
| [`tests/`](tests/) | Offline regression tests and opt-in live checks. |
| [`scripts/quality/`](scripts/quality/) | Executable paired task-quality harness. |
| [`compaction_samples.py`](compaction_samples.py) | Data Designer synthetic snapshot generator; its header documents preview setup. |
| [`scripts/`](scripts/) | Diagnostic replay and excerpt/batching/payback experiments; usage is in each script's header. |

Snapshot fixtures and replay estimates measure construction, projection, and evidence visibility rather than task success. Generated datasets, session artifacts, local inference outputs, and `.pi/` logs stay ignored and are not shipped in the package. Nimble weights and server code are also not bundled.
