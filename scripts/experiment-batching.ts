/** Repeated batching/history experiment; local synthetic data only.
 * node --import tsx scripts/experiment-batching.ts fixtures.json output.json
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { affordable, applyPruning, candidates, configuration, requestBody, score, superseded, type Candidate } from "../src/pruning.ts";
import { withoutOlderTestPair } from "./batching-controls.ts";

type Mode = "batched" | "individual";
type History = "original" | "older-test-pair-absent";
interface Fixture {
  fixture_id: string; snapshot_messages: string; domain: string; evidence_variant: string;
  annotations: { tool_call_id: string; label: string }[];
}
interface Cell { mode: Mode; history: History; }
interface Observation {
  trial: number; fixtureId: string; mode: Mode; history: History;
  candidateIds: string[]; probabilities: Record<string, number>; proposedIds: string[];
  latencyMs: number; inputTokens: number | null; error: string | null;
}
interface Classification {
  id: string; label: string; proposed: boolean; applied: boolean; estimatedTokens: number;
}
interface Result {
  trial: number; fixtureId: string; domain: string; variant: string;
  mode: Mode; history: History; complete: boolean; baselineEstimatedTokens: number;
  beforeGateTokensRemoved: number; afterGateTokensRemoved: number;
  scored: Classification[]; proposedIds: string[]; appliedIds: string[];
}
const [input, output] = process.argv.slice(2);
assert(input && output, "Usage: experiment-batching.ts fixtures.json output.json");
const raw = readFileSync(input);
const rows: Fixture[] = JSON.parse(raw.toString("utf8"));
assert(Array.isArray(rows) && rows.length > 0);
const config = { ...configuration({}), endpoint: "http://127.0.0.1:11434/v1/systemone",
  model: "nimble", apiKey: "", keepRecentTokens: 2000, timeoutMs: 180_000 };
const TRIALS = 3;
const cells: Cell[] = [
  { mode: "batched", history: "original" },
  { mode: "individual", history: "original" },
  { mode: "batched", history: "older-test-pair-absent" },
  { mode: "individual", history: "older-test-pair-absent" },
];
const observations: Observation[] = [];
const results: Result[] = [];
const tokens = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);
mkdirSync(dirname(output), { recursive: true });
function save() {
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, trials: TRIALS, config,
    inputSha256: createHash("sha256").update(raw).digest("hex"), observations, results,
    complete: results.length === TRIALS * rows.length * cells.length,
    limitations: ["Repeated trials of six templates are not independent real tasks",
      "History-only ablation removes older test call and result before state fitting; original replay remains unchanged",
      "Production omits full result bodies from history; this probes repeated-call/length-note effects, not raw duplicate text",
      "Ablation can alter history fitting as well as the duplicate cue; no causal proof from this small set",
      "No changes to production thresholds, excerpts, budgets or payback rules",
      "Trigger bypassed; recent window 2k and timeout 180s differ from defaults",
      "Scoring errors reported separately; whole condition fails closed",
      "Counterbalanced ordering; no inference seed or temperature control, not evidence of model randomness",
      "No task execution, retrieval, real cache usage or billing measurement"] }, null, 2) + "\n");
}
for (let trial = 1; trial <= TRIALS; trial++) {
  for (const [rowIndex, row] of rows.entries()) {
    const messages: AgentMessage[] = JSON.parse(row.snapshot_messages);
    const choices = candidates(messages, new Set(), config.keepRecentTokens);
    const automatic = superseded(messages, choices);
    const uncertain = choices.filter(c => !automatic.has(c.ref));
    assert.equal(uncertain.length, 4, "Expected four non-rule candidates in each fixture");
    const shifted: number = (trial - 1 + rowIndex) % cells.length;
    const order: Cell[] = [...cells.slice(shifted), ...cells.slice(0, shifted)];
    for (const cell of order) {
      const history = cell.history === "original" ? messages : withoutOlderTestPair(messages);
      const grouped: Candidate[][] = cell.mode === "batched" ? [uncertain] : uncertain.map(c => [c]);
      const decided = new Set<string>();
      let failed = false;
      for (const group of grouped) {
        const sent = requestBody(history, group, config.model);
        assert.equal(sent.choices.length, group.length, "Budget must not drop comparison candidates");
        const observation: Observation = { trial, fixtureId: row.fixture_id, ...cell,
          candidateIds: group.map(c => c.result.toolCallId), probabilities: {}, proposedIds: [],
          latencyMs: 0, inputTokens: null, error: null };
        const start = performance.now();
        try {
          const fetcher: typeof fetch = async (url, init) => {
            const response = await fetch(url, init);
            if (response.ok) {
              const data = await response.clone().json();
              for (const [i, candidate] of sent.choices.entries()) {
                const probability = data?.answers?.[`r${i}`]?.noul;
                if (typeof probability === "number") observation.probabilities[candidate.result.toolCallId] = probability;
              }
            }
            return response;
          };
          const scored = await score(history, group, config, undefined, fetcher);
          observation.inputTokens = scored.inputTokens;
          for (const ref of scored.refs) decided.add(ref);
          observation.proposedIds = group.filter(c => scored.refs.includes(c.ref)).map(c => c.result.toolCallId);
        } catch (cause) {
          observation.error = cause instanceof Error ? cause.message : "Unknown error";
          observation.probabilities = {};
          failed = true;
        }
        observation.latencyMs = Math.round(performance.now() - start);
        observations.push(observation);
        save();
        console.log(JSON.stringify(observation));
      }
      const proposed = choices.filter(c => automatic.has(c.ref) || decided.has(c.ref));
      const applied = failed ? [] : affordable(messages, new Set(), proposed, config.maxPaybackTurns);
      const proposedIds = new Set(proposed.map(c => c.result.toolCallId));
      const appliedIds = new Set(applied.map(c => c.result.toolCallId));
      // Evaluation labels are read only after inference; they are never model input.
      const scored = uncertain.map(c => {
        const annotation = row.annotations.find(a => a.tool_call_id === c.result.toolCallId);
        assert(annotation);
        return { id: c.result.toolCallId, label: annotation.label,
          proposed: proposedIds.has(c.result.toolCallId), applied: appliedIds.has(c.result.toolCallId),
          estimatedTokens: estimateTokens(c.result) };
      });
      const baseline = tokens(messages);
      results.push({ trial, fixtureId: row.fixture_id, domain: row.domain, variant: row.evidence_variant,
        ...cell, complete: !failed, baselineEstimatedTokens: baseline,
        beforeGateTokensRemoved: baseline - tokens(applyPruning(messages, new Set(proposed.map(c => c.ref)))),
        afterGateTokensRemoved: baseline - tokens(applyPruning(messages, new Set(applied.map(c => c.ref)))),
        scored, proposedIds: [...proposedIds], appliedIds: [...appliedIds] });
      save();
    }
  }
}
console.log(`Saved ${observations.length} requests and ${results.length} condition results to ${output}`);
if (observations.some(o => o.error)) process.exitCode = 1;
