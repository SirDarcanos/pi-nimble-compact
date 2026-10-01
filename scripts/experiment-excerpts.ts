/** Paired synthetic excerpt experiment. Local Ollama only; does not alter plugin behavior.
 * node --import tsx scripts/experiment-excerpts.ts fixtures.json report.json
 * Each evidence view scores one candidate/request, with identical state/questions.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { estimateTokens as requestTokens } from "../src/engine/state.ts";
import { affordable, applyPruning, candidates, configuration, MAX_REQUEST_BYTES,
  MAX_REQUEST_TOKENS, requestBody, score, superseded, textOf } from "../src/pruning.ts";
import { evidenceExcerpt, VIEWS, type EvidenceView } from "./excerpt-strategies.ts";

interface Observation {
  fixtureId: string; id: string; view: EvidenceView; probability: number | null;
  proposesClear: boolean; error: string | null; latencyMs: number;
  requestBytes: number; estimatedRequestTokens: number; classifierInputTokens: number | null;
  evidenceCharacters: number; evidenceText: string;
}
interface Classified {
  id: string; label: string; eligible: boolean; proposed: boolean; applied: boolean;
  estimatedTokens: number;
}
interface Result {
  fixtureId: string; domain: string; variant: string; view: EvidenceView;
  scoringComplete: boolean; baselineEstimatedTokens: number;
  beforeGateTokensRemoved: number; afterGateTokensRemoved: number;
  proposedIds: string[]; appliedIds: string[]; classified: Classified[];
}

const [input, output] = process.argv.slice(2);
assert(input && output, "Usage: experiment-excerpts.ts fixtures.json report.json");
const inputBytes = readFileSync(input);
const rows = JSON.parse(inputBytes.toString("utf8"));
assert(Array.isArray(rows) && rows.length > 0);
const config = { ...configuration({}), endpoint: "http://127.0.0.1:11434/v1/systemone",
  model: "nimble", apiKey: "", keepRecentTokens: 2000, timeoutMs: 180_000 };
const tokens = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);
const observations: Observation[] = [];
const results: Result[] = [];
mkdirSync(dirname(output), { recursive: true });
function save() {
  writeFileSync(output, JSON.stringify({ schemaVersion: 1,
    inputSha256: createHash("sha256").update(inputBytes).digest("hex"), config,
    observations, results, complete: results.length === rows.length * VIEWS.length,
    limitations: ["Six synthetic fixtures / three templates; single trial per view, not statistical evidence",
      "All views use one candidate/request; differs from production multi-candidate batching",
      "Threshold, gate and request ceilings unchanged; trigger bypassed, recent window 2k, timeout 180s",
      "Head/middle/tail payload 800 characters but adds an extra omission marker",
      "Full output is allowed only if original byte/token estimate limits are met",
      "Errors/budget failures are reported, not treated as evidence of correct retention",
      "Counterbalanced view order reduces but does not eliminate order/load effects",
      "No real task, retrieval, cache or billing measurement; classifier input usage may exceed estimator counts"] }, null, 2) + "\n");
}
for (const [rowIndex, row] of rows.entries()) {
  const messages: AgentMessage[] = JSON.parse(row.snapshot_messages);
  const choices = candidates(messages, new Set(), config.keepRecentTokens);
  const automatic = superseded(messages, choices);
  const uncertain = choices.filter(c => !automatic.has(c.ref));
  const decisions = new Map<EvidenceView, Set<string>>(VIEWS.map(view => [view, new Set()]));
  const failed = new Set<EvidenceView>();
  for (const [candidateIndex, item] of uncertain.entries()) {
    const original = requestBody(messages, [item], config.model);
    assert.equal(original.choices.length, 1);
    const shift = (rowIndex + candidateIndex) % VIEWS.length;
    const order = [...VIEWS.slice(shift), ...VIEWS.slice(0, shift)];
    for (const view of order) {
      const body = JSON.parse(original.body);
      body.state.results[0].excerpt = evidenceExcerpt(textOf(item.result), view);
      if (view === "head-tail") assert.equal(JSON.stringify(body), original.body);
      const encoded = JSON.stringify(body);
      const bytes = Buffer.byteLength(encoded);
      const estimated = requestTokens(encoded);
      const observation: Observation = { fixtureId: row.fixture_id, id: item.result.toolCallId,
        view, probability: null, proposesClear: false, error: null, latencyMs: 0,
        requestBytes: bytes, estimatedRequestTokens: estimated, classifierInputTokens: null,
        evidenceCharacters: body.state.results[0].excerpt.length,
        evidenceText: body.state.results[0].excerpt };
      const start = performance.now();
      try {
        assert(bytes <= MAX_REQUEST_BYTES && estimated <= MAX_REQUEST_TOKENS,
          "Evidence view exceeds existing request budget; not sent");
        const fetcher: typeof fetch = async (url, init) => {
          // Change ONLY the excerpt. Production score() still validates the response.
          const response = await fetch(url, { ...init, body: encoded });
          if (response.ok) {
            const data = await response.clone().json();
            observation.probability = data?.answers?.r0?.noul ?? null;
          }
          return response;
        };
        const scored = await score(messages, [item], config, undefined, fetcher);
        observation.classifierInputTokens = scored.inputTokens;
        observation.proposesClear = scored.refs.includes(item.ref);
        if (observation.proposesClear) decisions.get(view)!.add(item.ref);
      } catch (cause) {
        observation.probability = null;
        observation.error = cause instanceof Error ? cause.message : "Unknown failure";
        failed.add(view);
      }
      observation.latencyMs = Math.round(performance.now() - start);
      observations.push(observation);
      save();
      const { evidenceText: _evidence, ...progress } = observation;
      console.log(JSON.stringify(progress));
    }
  }
  for (const view of VIEWS) {
    const proposed = choices.filter(c => automatic.has(c.ref) || decisions.get(view)!.has(c.ref));
    // Matching fail-closed semantics: if any scoring request fails, no batch applied.
    const applied = failed.has(view) ? [] : affordable(messages, new Set(), proposed, config.maxPaybackTurns);
    const proposedIds = new Set(proposed.map(c => c.result.toolCallId));
    const appliedIds = new Set(applied.map(c => c.result.toolCallId));
    const classified = row.annotations.map((annotation: any) => {
      const message = messages.find(m => m.role === "toolResult" && m.toolCallId === annotation.tool_call_id);
      assert(message);
      return { id: annotation.tool_call_id, label: annotation.label,
        eligible: choices.some(c => c.result.toolCallId === annotation.tool_call_id),
        proposed: proposedIds.has(annotation.tool_call_id), applied: appliedIds.has(annotation.tool_call_id),
        estimatedTokens: estimateTokens(message) };
    });
    const baseline = tokens(messages);
    results.push({ fixtureId: row.fixture_id, domain: row.domain, variant: row.evidence_variant,
      view, scoringComplete: !failed.has(view), baselineEstimatedTokens: baseline,
      beforeGateTokensRemoved: baseline - tokens(applyPruning(messages, new Set(proposed.map(c => c.ref)))),
      afterGateTokensRemoved: baseline - tokens(applyPruning(messages, new Set(applied.map(c => c.ref)))),
      proposedIds: [...proposedIds], appliedIds: [...appliedIds], classified });
  }
  save();
}
console.log(`Saved ${observations.length} paired observations to ${output}`);
if (observations.some(o => o.error)) process.exitCode = 1;
