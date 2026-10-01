/** Compare the same saved classifier decisions before and after the payback gate.
 * No inference or network calls. Input snapshot IDs, token baselines, candidate IDs,
 * rule decisions, and applied masks must reproduce the saved run or comparison fails.
 * node --import tsx scripts/compare-payback.ts fixtures.json replay.json comparison.json
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { affordable, applyPruning, candidates, superseded } from "../src/pruning.ts";

const [input, replayPath, output] = process.argv.slice(2);
assert(input && replayPath && output,
  "Usage: compare-payback.ts fixtures.json replay.json comparison.json");
const rows = JSON.parse(readFileSync(input, "utf8"));
const replay = JSON.parse(readFileSync(replayPath, "utf8"));
assert(Array.isArray(rows) && rows.length > 0);
assert.equal(replay.errors, 0, "Cannot compare a replay with scoring failures");
assert.equal(rows.length, replay.records.length);
assert.equal(new Set(rows.map((r: any) => r.fixture_id)).size, rows.length);
assert.equal(new Set(replay.records.map((r: any) => r.fixtureId)).size, replay.records.length);
const tokenCount = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);
const names = ["none", "rules-before-gate", "rules-after-gate", "rules+nimble-before-gate", "rules+nimble-after-gate"];
const records = rows.map((row: any) => {
  const saved = replay.records.find((r: any) => r.fixtureId === row.fixture_id);
  assert(saved && !saved.error, "Missing or failed saved fixture");
  assert.equal(saved.domain, row.domain);
  assert.equal(saved.variant, row.evidence_variant);
  const messages: AgentMessage[] = JSON.parse(row.snapshot_messages);
  const baseline = tokenCount(messages);
  assert.equal(baseline, saved.conditions.find((c: any) => c.name === "none").baselineEstimatedTokens);
  const choices = candidates(messages, new Set(), replay.config.keepRecentTokens);
  const sortedIds = (items: typeof choices) => items.map(c => c.result.toolCallId).sort();
  assert.deepEqual(sortedIds(choices), [...saved.eligibleIds].sort());
  const automatic = superseded(messages, choices);
  const rules = choices.filter(c => automatic.has(c.ref));
  assert.deepEqual(sortedIds(rules), [...saved.automaticIds].sort());
  const proposedIds = new Set<string>(saved.nimbleProposedIds);
  const scored = choices.filter(c => !automatic.has(c.ref));
  for (const id of proposedIds) assert(scored.some(c => c.result.toolCallId === id));
  // Cross-check threshold decisions rather than trusting arbitrary proposed IDs.
  for (const [id, probability] of Object.entries(saved.probabilities)) {
    assert(typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1);
    assert(scored.some(c => c.result.toolCallId === id));
    assert.equal(proposedIds.has(id), probability < replay.config.keepThreshold);
  }
  const combined = choices.filter(c => automatic.has(c.ref) || proposedIds.has(c.result.toolCallId));
  const afterRules = affordable(messages, new Set(), rules, replay.config.maxPaybackTurns);
  const afterCombined = affordable(messages, new Set(), combined, replay.config.maxPaybackTurns);
  for (const [name, cleared] of [["rules", afterRules], ["rules+nimble", afterCombined]] as const) {
    const original = saved.conditions.find((c: any) => c.name === name);
    assert.deepEqual(sortedIds(cleared), [...original.clearedIds].sort());
    assert.equal(tokenCount(applyPruning(messages, new Set(cleared.map(c => c.ref)))), original.projectedEstimatedTokens);
  }
  const eligibleIds = new Set(saved.eligibleIds);
  const conditions = [[], rules, afterRules, combined, afterCombined].map((cleared, i) => {
    const ids = new Set(cleared.map(c => c.result.toolCallId));
    const projected = tokenCount(applyPruning(messages, new Set(cleared.map(c => c.ref))));
    const classified = row.annotations.map((annotation: any) => {
      const result = messages.find(m => m.role === "toolResult" && m.toolCallId === annotation.tool_call_id);
      assert(result);
      return { id: annotation.tool_call_id as string, label: annotation.label as string,
        eligible: eligibleIds.has(annotation.tool_call_id), cleared: ids.has(annotation.tool_call_id),
        estimatedTokens: estimateTokens(result) };
    });
    return { condition: names[i], baselineEstimatedTokens: baseline, projectedEstimatedTokens: projected,
      estimatedTokensRemoved: baseline - projected, removedFraction: (baseline - projected) / baseline,
      clearedIds: [...ids], classified };
  });
  return { fixtureId: row.fixture_id, domain: row.domain, variant: row.evidence_variant, conditions };
});
const summary = names.map(name => {
  const conditions = records.map((r: any) => r.conditions.find((c: any) => c.condition === name));
  const classified = conditions.flatMap((c: any) => c.classified);
  function metric(label: string) {
    const items = classified.filter((c: any) => c.eligible && c.label === label);
    const cleared = items.filter((c: any) => c.cleared);
    const totalTokens = items.reduce((sum: number, c: any) => sum + c.estimatedTokens, 0);
    return { total: items.length, cleared: cleared.length, rate: items.length ? cleared.length / items.length : null,
      tokenWeightedRate: totalTokens ? cleared.reduce((sum: number, c: any) => sum + c.estimatedTokens, 0) / totalTokens : null };
  }
  const baseline = conditions.reduce((sum: number, c: any) => sum + c.baselineEstimatedTokens, 0);
  const removed = conditions.reduce((sum: number, c: any) => sum + c.estimatedTokensRemoved, 0);
  return { condition: name, baselineEstimatedTokens: baseline, estimatedTokensRemoved: removed,
    projectedEstimatedTokens: baseline - removed, removedFraction: removed / baseline,
    eligibleStale: metric("stale"), eligibleImportant: metric("important") };
});
const comparison = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceReplay: replayPath,
  inferenceReused: true, config: replay.config, records, summary,
  limitations: [...replay.limitations,
    "Before-gate projections are counterfactual diagnostics, not applied plugin behavior",
    "Saved run predates snapshot hashing; consistency checked by IDs, estimates, candidates and applied masks, not byte identity"] };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(comparison, null, 2) + "\n");
console.log(JSON.stringify({ output, summary }, null, 2));
