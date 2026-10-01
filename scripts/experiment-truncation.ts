/** Offline truncation experiment; uses saved decisions, never calls a model.
 * node --import tsx scripts/experiment-truncation.ts fixtures.json replay.json output.json
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { affordable, applyPruning, candidates, reference, superseded, textOf } from "../src/pruning.ts";
import { experimentalPayback, projectTruncated } from "./truncated-projection.ts";

const [input, savedPath, output] = process.argv.slice(2);
assert(input && savedPath && output, "Usage: experiment-truncation.ts fixtures.json replay.json output.json");
const bytes = readFileSync(input);
const rows = JSON.parse(bytes.toString("utf8"));
const saved = JSON.parse(readFileSync(savedPath, "utf8"));
assert(Array.isArray(rows) && rows.length === saved.records.length && rows.length > 0);
assert.equal(saved.errors, 0);
const tokens = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);
const records = rows.map((row: any) => {
  const original: AgentMessage[] = JSON.parse(row.snapshot_messages);
  const before = JSON.stringify(original);
  const source = saved.records.find((r: any) => r.fixtureId === row.fixture_id);
  assert(source && !source.error);
  const choices = candidates(original, new Set(), saved.config.keepRecentTokens);
  const sortedIds = (items: typeof choices) => items.map(c => c.result.toolCallId).sort();
  assert.deepEqual(sortedIds(choices), [...source.eligibleIds].sort());
  const auto = superseded(original, choices);
  const rules = choices.filter(c => auto.has(c.ref));
  assert.deepEqual(sortedIds(rules), [...source.automaticIds].sort());
  const combined = choices.filter(c => auto.has(c.ref) || source.nimbleProposedIds.includes(c.result.toolCallId));
  const baseline = tokens(original);
  assert.equal(baseline, source.conditions.find((c: any) => c.name === "none").baselineEstimatedTokens);
  const conditions = [];
  for (const [policy, proposed] of [["rules", rules], ["rules+nimble", combined]] as const) {
    const real = affordable(original, new Set(), proposed, saved.config.maxPaybackTurns);
    const reproduced = experimentalPayback(original, new Set(), proposed, saved.config.maxPaybackTurns, applyPruning);
    assert.deepEqual(sortedIds(reproduced), sortedIds(real), "Experimental gate must match production for marker-only projection");
    assert.deepEqual(sortedIds(real), [...source.conditions.find((c: any) => c.name === policy).clearedIds].sort());
    for (const [projection, project] of [["marker-only", applyPruning], ["head-tail-600", projectTruncated]] as const) {
      const accepted = experimentalPayback(original, new Set(), proposed, saved.config.maxPaybackTurns, project);
      for (const [stage, selected] of [["before-gate", proposed], ["after-gate", accepted]] as const) {
        const projected = project(original, new Set(selected.map(c => c.ref)));
        const results = new Map(projected.flatMap(m => m.role === "toolResult" ? [[m.toolCallId, m] as const] : []));
        const counts = textOf(results.get("tests-new")!).includes("Tests: 36 passed, 4 skipped, 0 failed.");
        const pendingFunction = textOf(results.get("source-new")!).includes("throw new Error('not implemented')");
        const contract = textOf(results.get("contract")!);
        const constraintsVisible = row.task_spec.constraints.map((constraint: string) => contract.includes(constraint));
        const refs = new Set(selected.map(c => c.ref));
        for (const message of original) {
          if (message.role !== "toolResult" || !refs.has(reference(message))) {
            assert.strictEqual(projected[original.indexOf(message)], message);
          }
        }
        conditions.push({ policy, projection, stage, baselineEstimatedTokens: baseline,
          estimatedTokensRemoved: baseline - tokens(projected),
          shortenedIds: selected.map(c => c.result.toolCallId),
          evidenceVisible: { latestTestCounts: counts, pendingFunction, contractConstraints: constraintsVisible },
          projectedEvidence: {
            tests: textOf(results.get("tests-new")!), source: textOf(results.get("source-new")!),
            contract: textOf(results.get("contract")!),
          } });
      }
    }
  }
  assert.equal(JSON.stringify(original), before, "Never mutate stored evidence");
  return { fixtureId: row.fixture_id, domain: row.domain, variant: row.evidence_variant, conditions };
});
const summary = records[0].conditions.map((cell: any) => {
  const matching = records.map((row: any) => row.conditions.find((c: any) =>
    c.policy === cell.policy && c.projection === cell.projection && c.stage === cell.stage));
  const baseline = matching.reduce((sum: number, c: any) => sum + c.baselineEstimatedTokens, 0);
  const removed = matching.reduce((sum: number, c: any) => sum + c.estimatedTokensRemoved, 0);
  return { policy: cell.policy, projection: cell.projection, stage: cell.stage,
    estimatedTokensRemoved: removed, removedFraction: removed / baseline,
    fixturesWithTestCounts: matching.filter((c: any) => c.evidenceVisible.latestTestCounts).length,
    fixturesWithPendingFunction: matching.filter((c: any) => c.evidenceVisible.pendingFunction).length,
    fixturesWithBothContractConstraints: matching.filter((c: any) => c.evidenceVisible.contractConstraints.every(Boolean)).length };
});
const report = { schemaVersion: 1, inputSha256: createHash("sha256").update(bytes).digest("hex"),
  sourceReplay: savedPath, config: saved.config, retainedCharacters: 600, records, summary,
  limitations: ["Offline reuse of original batched decisions, not a new classifier run or task execution",
    "Same newest-first cache payback formula, recomputed for the different projection",
    "Before-gate results are counterfactual, not applied plugin behavior",
    "Exact substring visibility tests measure only specified fixture facts, not task correctness or sufficient context",
    "Buried constraints may still require retrieval; original outputs remain unchanged",
    "Original replay predates snapshot hashes; matched IDs/baselines/candidates/masks, not certified byte identity",
    "No production changes, real cache measurements or billing claims"] };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, summary }, null, 2));
