/** Local synthetic snapshot replay; not a Pi lifecycle/task-success benchmark.
 * node --import tsx scripts/replay-compaction.ts input.json output.json
 * Input: JSON array of exported Data Designer rows. Only snapshot_messages enter scoring.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { affordable, affordableReductions, applyPruning, candidates, configuration, requestBody, score, superseded, textOf } from "../src/pruning.ts";

interface Classified {
  id: string; label: string; cleared: boolean; truncated: boolean; estimatedTokens: number; eligible: boolean;
}
interface Condition {
  name: string; baselineEstimatedTokens: number; projectedEstimatedTokens: number;
  estimatedTokensRemoved: number; clearedIds: string[]; truncatedIds: string[]; classified: Classified[];
  evidenceVisible: { latestTestCounts: boolean; pendingFunction: boolean; bothContractConstraints: boolean };
}
interface ReplayRecord {
  fixtureId: string; domain: string; variant: string; eligibleIds: string[];
  automaticIds: string[]; nimbleProposedIds: string[]; evaluated: number;
  classifierInputTokens: number | null; classifierLatencyMs: number; error: string | null;
  probabilities: Record<string, number>; conditions: Condition[];
}

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: replay-compaction.ts input.json output.json");
const rows = JSON.parse(readFileSync(input, "utf8"));
assert(Array.isArray(rows) && rows.length > 0, "Expected a nonempty array of fixtures");
// Pin endpoint and credentials: no inherited remote endpoint or API key is used.
const config = { ...configuration({}), endpoint: "http://127.0.0.1:11434/v1/systemone",
  model: "nimble", apiKey: "", keepRecentTokens: 2000, timeoutMs: 180_000 };
const tokens = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);
const records: ReplayRecord[] = [];
for (const row of rows) {
  const messages: AgentMessage[] = JSON.parse(row.snapshot_messages);
  assert(Array.isArray(messages));
  const choices = candidates(messages, new Set(), config.keepRecentTokens);
  const automatic = superseded(messages, choices);
  const uncertain = choices.filter(c => !automatic.has(c.ref));
  const rules = choices.filter(c => automatic.has(c.ref));
  const ruleClears = affordable(messages, new Set(), rules, config.maxPaybackTurns);
  const probabilities: Record<string, number> = {};
  let usage: number | null = null;
  let evaluated = 0;
  let error: string | null = null;
  let nimbleRefs: string[] = [];
  let keptRefs: string[] = [];
  const start = performance.now();
  try {
    if (uncertain.length) {
      const sent = requestBody(messages, uncertain, config.model);
      const fetcher: typeof fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (response.ok) {
          const data = await response.clone().json();
          for (const [i, item] of sent.choices.entries()) {
            const probability = data?.answers?.[`r${i}`]?.noul;
            if (typeof probability === "number") probabilities[item.result.toolCallId] = probability;
          }
        }
        return response;
      };
      const result = await score(messages, uncertain, config, undefined, fetcher);
      nimbleRefs = result.refs;
      keptRefs = result.keptRefs;
      usage = result.inputTokens;
      evaluated = result.evaluated;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Unknown scoring error";
  }
  const latencyMs = Math.round(performance.now() - start);
  const proposed = choices.filter(c => automatic.has(c.ref) || nimbleRefs.includes(c.ref));
  // The extension fails closed for the whole batch when scoring fails.
  const combined = error ? [] : affordable(messages, new Set(), proposed, config.maxPaybackTurns);
  const toTruncate = config.truncateMinChars > 0 ? choices.filter(c => keptRefs.includes(c.ref)
    && textOf(c.result).length > config.truncateMinChars) : [];
  const tiered = error ? { cleared: [], truncated: [], saved: 0 }
    : affordableReductions(messages, new Set(), new Set(), proposed, toTruncate, config.maxPaybackTurns);
  function condition(name: string, cleared: typeof choices, truncated: typeof choices = []): Condition {
    const refs = new Set(cleared.map(c => c.ref));
    const ids = new Set(cleared.map(c => c.result.toolCallId));
    const truncatedIds = new Set(truncated.map(c => c.result.toolCallId));
    const projection = applyPruning(messages, refs, new Set(truncated.map(c => c.ref)));
    const projected = tokens(projection);
    const baseline = tokens(messages);
    const classified = row.annotations.map((annotation: any) => {
      const message = messages.find(m => m.role === "toolResult" && m.toolCallId === annotation.tool_call_id);
      assert(message, "Annotation must match a tool result");
      return { id: annotation.tool_call_id, label: annotation.label, cleared: ids.has(annotation.tool_call_id), truncated: truncatedIds.has(annotation.tool_call_id),
        estimatedTokens: estimateTokens(message), eligible: choices.some(c => c.result.toolCallId === annotation.tool_call_id) };
    });
    const visible = (id: string) => {
      const result = projection.find(m => m.role === "toolResult" && m.toolCallId === id);
      assert(result?.role === "toolResult");
      return textOf(result);
    };
    return { name, baselineEstimatedTokens: baseline, projectedEstimatedTokens: projected,
      estimatedTokensRemoved: baseline - projected, clearedIds: [...ids], truncatedIds: [...truncatedIds], classified,
      evidenceVisible: {
        latestTestCounts: visible("tests-new").includes("Tests: 36 passed, 4 skipped, 0 failed."),
        pendingFunction: visible("source-new").includes("throw new Error('not implemented')"),
        bothContractConstraints: row.task_spec.constraints.every((constraint: string) => visible("contract").includes(constraint)),
      } };
  }
  const record = { fixtureId: row.fixture_id, domain: row.domain, variant: row.evidence_variant,
    eligibleIds: choices.map(c => c.result.toolCallId), automaticIds: rules.map(c => c.result.toolCallId),
    nimbleProposedIds: choices.filter(c => nimbleRefs.includes(c.ref)).map(c => c.result.toolCallId),
    evaluated, classifierInputTokens: usage, classifierLatencyMs: latencyMs, error, probabilities,
    conditions: [condition("none", []), condition("rules", ruleClears), condition("rules+nimble", combined),
      condition("rules+nimble-tiered", tiered.cleared, tiered.truncated)] };
  records.push(record);
  console.log(JSON.stringify({ fixture: row.fixture_id, domain: row.domain, latencyMs, error,
    probabilities, cleared: tiered.cleared.map(c => c.result.toolCallId),
    truncated: tiered.truncated.map(c => c.result.toolCallId) }));
}
const summary = ["none", "rules", "rules+nimble", "rules+nimble-tiered"].map(name => {
  const conditions = records.map(r => r.conditions.find(c => c.name === name)!);
  const classified = conditions.flatMap(c => c.classified);
  const eligible = classified.filter(c => c.eligible && c.label !== "uncertain");
  function metric(label: string) {
    const items = eligible.filter(c => c.label === label);
    const cleared = items.filter(c => c.cleared);
    const denominatorTokens = items.reduce((sum, c) => sum + c.estimatedTokens, 0);
    return { total: items.length, cleared: cleared.length,
      rate: items.length ? cleared.length / items.length : null,
      tokenWeightedRate: denominatorTokens ? cleared.reduce((sum, c) => sum + c.estimatedTokens, 0) / denominatorTokens : null };
  }
  return { condition: name, baselineEstimatedTokens: conditions.reduce((sum, c) => sum + c.baselineEstimatedTokens, 0),
    projectedEstimatedTokens: conditions.reduce((sum, c) => sum + c.projectedEstimatedTokens, 0),
    estimatedTokensRemoved: conditions.reduce((sum, c) => sum + c.estimatedTokensRemoved, 0),
    eligibleStale: metric("stale"), eligibleImportant: metric("important"),
    truncatedOutputs: conditions.reduce((sum, c) => sum + c.truncatedIds.length, 0),
    evidenceVisible: {
      latestTestCounts: conditions.filter(c => c.evidenceVisible.latestTestCounts).length,
      pendingFunction: conditions.filter(c => c.evidenceVisible.pendingFunction).length,
      bothContractConstraints: conditions.filter(c => c.evidenceVisible.bothContractConstraints).length,
    } };
});
const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), config, records, summary,
  errors: records.filter(r => r.error).length,
  limitations: ["Six controlled synthetic fixtures, three task templates; not a broad accuracy evaluation",
    "Trigger bypassed; keepRecentTokens=2000 and scoring timeout=180000 differ from plugin defaults",
    "Payback gate uses plugin default 20 turns; not measured provider billing",
    "Estimates are projected single-request footprints, not cumulative token or cost savings",
    "Uncertain annotations excluded from accuracy rates; proposed and applied decisions reported separately",
    "No future turns, real task execution, retrieval cost, cache usage, or task-success measurements",
    "Important-output labels are provisional; full-body clearing rates do not establish actual errors",
    "Exact substring visibility covers only selected fixture facts; absence implies retrieval, not task failure",
    "First classifier latency may include model load; inputs are synthetic and sent only to local Ollama"] };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, errors: report.errors, summary }, null, 2));
if (report.errors) process.exitCode = 1;
