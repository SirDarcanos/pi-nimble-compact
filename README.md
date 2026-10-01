# pi-nimble-compact

Automatic [Bespoke Nimble](https://github.com/bespokelabsai/nimble) context clearing for [Pi](https://pi.dev). Keep the conversation, prune stale tool output, and retrieve originals without rerunning commands.

This package combines copied and adapted code from [Nour Helmi's pi-jev-compaction](https://github.com/nourhelmi/pi-jev-compaction) and [tamaratran's original fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Both are MIT-licensed; their original notices are preserved in [`licenses/`](licenses/) and the imported revisions are recorded in [`NOTICE.md`](NOTICE.md).

## Install

Requires Node.js **22.19+**, Pi (tested with **0.99.2**), and [Ollama **0.35 or later**](https://ollama.com/download). Ollama's [Nimble decision model](https://ollama.com/library/nimble) provides `/v1/systemone` directly: no Python build, custom bridge, TypeSafe key, or Ollama npm library is needed.

1. Install or update Ollama, then check `ollama --version` is at least `0.35`.
2. Start the Ollama app/service. If you run it manually, keep `ollama serve` running in a separate terminal; do not start a second server if one already owns port 11434.
3. Download Nimble and install the Pi extension:

```sh
ollama pull nimble
pi install git:github.com/SirDarcanos/pi-nimble-compact
pi
```

The plugin defaults to **`http://127.0.0.1:11434/v1/systemone`**, model **`nimble`**, without a key. Ollama is a separately installed system service, not an npm dependency. The plugin does not install Ollama, download model weights, start a server, or change your Ollama configuration automatically. Model inference uses local hardware; downloading the weights requires internet access and sufficient disk space/RAM.

### Check Ollama before starting Pi

Use the decision API, not `ollama run nimble` or the ordinary chat/generate endpoints:

```sh
curl --fail-with-body --max-time 120 http://127.0.0.1:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"nimble","state":"A newer complete test run supersedes an older identical successful run.","questions":{"keep":{"type":"noul","instructions":"Does the older run still need to stay verbatim?"}}}'
```

A successful response contains `answers.keep.noul`, a probability between 0 and 1. This also warms the model before Pi's shorter request deadline applies. A connection error means Ollama is not reachable; a missing-model error means you need `ollama pull nimble`; a missing endpoint can mean your Ollama version is too old. On failure, the plugin applies no new clearing decisions and Pi's normal compaction remains enabled.

To try this checkout before installing it:

```sh
pi -e ./extensions/nimble.ts
```

Environment overrides take precedence. If you used an earlier setup pointing at port 8000, unset `PI_NIMBLE_URL` and `PI_NIMBLE_MODEL` to use the new Ollama defaults. Set `PI_NIMBLE_URL=""` explicitly to disable clearing. Restart Pi after changing shell environment variables; `/reload` alone does not import newly exported variables from another shell.

### Alternative: a non-Ollama Nimble server

Ollama is the recommended local setup. If you prefer the upstream Python/SGLang deployment, follow [Nimble's serving guide](https://github.com/bespokelabsai/nimble/blob/main/docs/MODAL_SERVING.md), prepare the model and start its server separately, then override both endpoint and model:

```sh
export PI_NIMBLE_URL="http://127.0.0.1:8000/v1/systemone"
export PI_NIMBLE_MODEL="nimble-latest"
# Only if your deployment requires bearer authentication:
# export NIMBLE_API_KEY="your-key"
pi
```

Use the **complete endpoint URL**, not just its origin. Remote endpoints must use HTTPS; HTTP is accepted only for loopback hosts. URLs containing credentials, query parameters, or fragments are rejected. The plugin supports optional bearer authentication, not Modal proxy-key headers. The hosted demo described in upstream documentation returned **401: proxy auth required** during our smoke check; use an endpoint you control or have access to.

A sleeping or busy service can return `503` or `529`. The plugin leaves new clearing decisions unapplied; it does not wait through a cold start or retry in a loop. It never uses `TYPESAFE_API_KEY`, contacts Jev, or falls back to another classifier.

## How clearing works

1. At model/tool boundaries, start an evaluation when context reaches **120k estimated tokens or 45% of the model's window**, whichever is smaller. Scoring runs concurrently with the next model request.
2. Protect the latest **12k estimated tokens**, including complete parallel tool batches.
3. Identify safely superseded outputs locally: complete reads of the same path, identical successful test commands, repeated diagnostics, and supported checkpoint/list tools.
4. Use the original `fast-jev-compaction` history fitter to prepare conversation history, tool inputs, and result-length notes. It reduces the scoring state in stages to **2k estimated tokens**. Add bounded candidate output excerpts and ask Nimble whether each result contains unique evidence still needed verbatim.
5. Consider up to **16** successful text outputs of at least **2,000 characters** per evaluation. Propose marker-only clearing for superseded outputs or scored results below the **0.25** keep threshold. For results explicitly retained by scoring, propose shortening when their text exceeds **4,000 characters**.
6. Apply the cache-rewrite payback gate to the combined batch. Persist branch-local decisions: stale outputs become retrieval markers; retained long outputs keep their first **300** and last **300** characters with a retrieval marker between them. Original session messages are unchanged. Recent and protected results remain intact.

```text
[pi-nimble: older tool output cleared from context; original retained in this session.
Retrieve with nimble_read({"ref":"…"}). Do not rerun a side-effecting command to recover its output.]
```

Truncation is **per-output clipping, not a semantic summary or whole-conversation summarization**. It preserves headings and tails such as test counts, but can hide contracts, errors, or constraints in the middle. The truncation marker instructs the model to retrieve omitted evidence, especially before editing. A high keep probability does not mean the retained head/tail contains everything important. Outputs excluded from the scoring request budget are not shortened; API failure leaves both new tiers unapplied. Stale outputs deferred by the payback gate stay intact rather than being shortened as a fallback.

The model can retrieve the original of either a cleared or truncated result with `nimble_read({"ref":"…"})`. `offset` and `limit` are character counts; pages default to 8,000 characters and are capped at 16,000. Retrieval reads stored evidence on the active session branch, even after normal Pi compaction. It does not reread a changed file, rerun a command, or search another session.

### What stays intact

User and assistant text, tool calls, thinking/signatures, message order, and summaries stay intact in the model-facing projection. Failed outputs, images, ambiguous call/result pairs, credential-file reads, `AGENTS.md`/`SKILL.md` reads, deferred-tool loading results, retrieval responses, and protected coordination tools are excluded from clearing. Sensitive inputs and obvious secret-bearing outputs are excluded from scoring.

The Pi adapter uses **result-only clearing**, rather than the original Claude Code engine's deletion of call/result pairs. The complete adapted TypeScript engine is retained in `src/engine/`; Pi directly uses its pairing, history-fitting, and estimation functions. Its standalone deletion helpers are not used to project Pi context. Claude Code-specific hooks and manifests are intentionally omitted.

## Commands and status

- `/nimble-status`: configuration, last evaluation, branch-local cleared/truncated counts, and cumulative estimated context removed.
- `/nimble-reset`: release both clearing and truncation on the active branch without deleting history or original outputs.
- `nimble_read`: model tool for reading original masked output.

Interactive Pi displays `Nimble ready`, `checking…`, `paused`, `dormant`, or `error`, plus estimated context saved. The counter sums persisted clearing decisions; it is not a measurement of billing savings. Branch navigation, reloads, and resets retain the cumulative counter.

Keep `nimble_read` active. If a tool allowlist disables it, existing masks stop applying and new clearing pauses. Avoid co-loading another general-purpose context-pruning extension. Provider-native Codex checkpoints pause clearing on their branch; retrieval remains available.

## Configuration

Variables are read when the extension loads. Invalid numeric values use defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_NIMBLE_URL` | `http://127.0.0.1:11434/v1/systemone` | Full System One endpoint; explicitly empty disables clearing |
| `NIMBLE_API_KEY` | unset | Optional bearer token; not needed by local Ollama |
| `PI_NIMBLE_MODEL` | `nimble` | Ollama model/tag or alternate server's checkpoint ID |
| `PI_NIMBLE_THRESHOLD` | `0.45` | Context fraction trigger; `0.1`–`0.95` |
| `PI_NIMBLE_TRIGGER_TOKENS` | `120000` | Absolute trigger; `8000`–`2000000` |
| `PI_NIMBLE_KEEP_THRESHOLD` | `0.25` | Retain probabilities at or above this; `0`–`1` |
| `PI_NIMBLE_KEEP_RECENT_TOKENS` | `12000` | Protected recent token window; `2000`–`100000` |
| `PI_NIMBLE_MAX_PAYBACK_TURNS` | `20` | Maximum estimated cache-rewrite payback; `1`–`1000` |
| `PI_NIMBLE_TIMEOUT_MS` | `30000` | Request deadline; `100`–`180000` |
| `PI_NIMBLE_TRUNCATE_MIN_CHARS` | `4000` | Shorten explicitly retained outputs longer than this; `0` disables new truncation, maximum `2000000` |

Truncation retains 600 characters plus its marker. Set `PI_NIMBLE_TRUNCATE_MIN_CHARS=0` to stop new truncation; existing truncation decisions persist until `/nimble-reset`. Legacy clearing entries still work. A later supersession or low keep score can upgrade a truncated result to marker-only clearing; the payback calculation counts only the additional reduction.

The payback gate retains the Pi upstream's Anthropic-style cache assumptions: writes at 1.25× input cost and reads at 0.1×. Those assumptions are not a cost guarantee for other providers. Clearing old evidence changes the cached prefix; fewer context tokens need not mean a cheaper session.

## Privacy, limits, and failures

By default, scoring runs locally through Ollama. Only the configured Nimble endpoint receives scoring requests. Requests contain fitted user/assistant prose and summaries, screened tool names and inputs, output lengths, and candidate head/tail excerpts. Thinking, signatures, images, custom messages, and result metadata are not uploaded. Full tool outputs remain in the local Pi session.

Requests are capped at **24,000 UTF-8 bytes and 6,000 estimated tokens**; responses at **64,000 bytes**. The estimator comes from the original Jev project and is not a Nimble tokenizer. Nimble's documented 8,192-token per-field limit remains authoritative. Oversized history, invalid answers, timeouts, authentication errors, busy responses, and transport errors leave new clearing decisions unapplied. Redirects are refused, and keys and response bodies are not logged.

Common secret patterns are redacted from uploaded excerpts; this is heuristic protection, not a complete secret scanner. Choose a trusted endpoint and keep credentials out of ordinary conversation and tool output. A public endpoint means your excerpts leave your machine.

Pi's normal manual, threshold, and overflow compaction remain enabled. Evaluation results apply only at a later request boundary; they cannot change a request already in flight. Branch changes, new user tasks, and compaction invalidate in-flight decisions. Clearing is probabilistic and can misjudge relevance; use retrieval to recover evidence. Nimble's probabilities differ from Jev's, so tune the keep threshold against your own tasks rather than assuming identical quality.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
# Optional live check: local Ollama 0.35+ with nimble already pulled
npm run smoke:ollama
```

The Pi 0.99.2 development dependency tree pins `brace-expansion` 5.0.9 in its published shrinkwrap. `npm audit` reports a high-severity denial-of-service advisory that `npm audit fix` cannot currently resolve. This package has no bundled runtime dependencies; `npm audit --omit=dev` reports no vulnerabilities.

Tests cover the copied engine, Pi lifecycle/protocol preservation, branch-local clearing/truncation persistence and retrieval, incremental upgrades, SDK integration, package loading, Ollama defaults and System One responses, request limits, and failure handling. The normal suite uses synthetic sessions and mocked responses, including a local HTTP server. The opt-in `smoke:ollama` check sends only a canned fixture to local Ollama through the plugin's actual scoring transport. Neither test mode measures relevance quality across real tasks or billing savings.

### Fixed-snapshot task-quality trials

From a repository checkout, `npm run quality:run -- --trials 2` makes main-agent requests using **openai-codex / gpt-6.1-sol** (existing Pi credentials). Override with `--provider` and `--model`; unavailable models fail rather than falling back. For a single-arm smoke run, add `--task contract --arm two-tier --trials 1`.

The harness captures one synthetic starting state per task/trial and clones it into independent baseline, marker-only, and two-tier workspaces and SDK sessions. Tasks cover a buried API contract, historical receipt recovery after its file changes, and actual historical test counts with instruction-like diagnostic content. Bounded workspace tools allow solution edits and real test runs; production `nimble_read` retrieves original session evidence. Independent evaluation checks behavior, current tests, final JSON reporting, and repeated receipt side effects. Passing requires that the agent also run current tests.

Masks are **predeclared stress cases**, not classifier predictions: marker-only clears old diagnostics and, for the recovery task, historical receipt evidence; two-tier additionally clips retained contract/test output using production projection. Normal Pi compaction is enabled equally in every arm and recorded separately. This isolates fixed-mask recovery, not live scoring, triggers, payback, or persistence quality. It uses bounded custom tools rather than the full coding toolset, and is not an OS security sandbox. Model-written JavaScript executes locally; use only controlled synthetic tasks.

Ignored `local-data/quality/` contains per-trial sessions, completed-message events, configuration, evaluations, retrieval pages, test-run counts, elapsed time, SDK usage/cache fields, and aggregate reports. Estimated context footprints are not cumulative savings; SDK cost estimates are not measured bills. Classifier overhead is explicitly zero because scoring does not run. Repeated trials of these three templates are not new independent tasks, and passing them cannot establish general task-quality parity. Trial outputs are not packaged or committed.

## License and credits

MIT. Adapted by [SirDarcanos](https://github.com/SirDarcanos), with copied source from **Nour Helmi** and **tamaratran**. See [`NOTICE.md`](NOTICE.md) and the original MIT license texts shipped in [`licenses/`](licenses/). Nimble is an external model/service from **Bespoke Labs**; its weights and server code are not bundled or relicensed by this plugin.
