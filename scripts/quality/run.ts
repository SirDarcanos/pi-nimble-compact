/**
 * Local opt-in main-model trials (makes provider requests):
 * node --import tsx scripts/quality/run.ts --trials 2
 * Optional: --provider NAME --model ID --task contract|history|counts --arm baseline|marker-only|two-tier --timeout-ms 180000
 * Artifacts always go beneath ignored local-data/quality/. Exact model selection; no fallback.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { arms, tasks, prepareFixture, type Arm, type Task } from "./fixtures.ts";
import { runTrial } from "./runner.ts";

const args = process.argv.slice(2);
const values = new Map<string, string>();
const allowed = new Set(["--provider", "--model", "--trials", "--task", "--arm", "--timeout-ms"]);
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]!) || !args[i + 1] || values.has(args[i]!)) throw new Error("Unknown, duplicate, or incomplete quality CLI option");
  values.set(args[i]!, args[i + 1]!);
}
const provider = values.get("--provider") ?? "openai-codex";
const modelId = values.get("--model") ?? "gpt-6.1-sol";
const trials = Number(values.get("--trials") ?? 2);
const timeoutMs = Number(values.get("--timeout-ms") ?? 180_000);
if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error("Trials must be 1–10");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("Timeout must be 1000–600000 ms");
const taskValue = values.get("--task"), armValue = values.get("--arm");
if (taskValue && !tasks.includes(taskValue as Task)) throw new Error("Unknown task");
if (armValue && !arms.includes(armValue as Arm)) throw new Error("Unknown arm");
const selectedTasks = taskValue ? [taskValue as Task] : [...tasks];
const selectedArms = armValue ? [armValue as Arm] : [...arms];
const agentDir = getAgentDir();
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
const model = runtime.getModel(provider, modelId);
if (!model) throw new Error(`Exact model unavailable: ${provider}/${modelId}; no substitute used`);
const auth = await runtime.checkAuth(provider);
if (!auth) throw new Error(`Provider authentication unavailable: ${provider}`);
const root = resolve("local-data", "quality", new Date().toISOString().replaceAll(/[:.]/g, "-") + `-${process.pid}`);
mkdirSync(root, { recursive: true });
const results: Array<Awaited<ReturnType<typeof runTrial>>> = [];
const setupFailures: Array<{ task: Task; arm: Arm; trial: number; error: string }> = [];
const config = { provider, model: modelId, api: model.api, trials, tasks: selectedTasks, arms: selectedArms,
  timeoutMs, thinkingLevel: "medium", retry: false, normalCompaction: true,
  mode: "fixed-snapshot", masks: "predeclared-stress-masks-not-classifier-decisions", toolBudget: 30,
  acceptance: "Every trial must pass independent behavior checks, public tests, final reporting, and side-effect safety; model must run current tests.",
  limitations: ["Three templates, repeated trials are not independent new tasks", "No live classifier, trigger, payback, or persistence quality evaluation", "Bounded custom tools rather than full shell coding tools", "Not an OS security sandbox", "SDK cost estimates are not measured bills"] };
function save() {
  const byArm = selectedArms.map(arm => {
    const runs = results.filter(result => result.arm === arm);
    return { arm, runs: runs.length, successes: runs.filter(result => result.evaluation.success).length,
      activeProjectionRuns: runs.filter(result => result.projection.observedActive).length,
      inputTokens: runs.reduce((sum, result) => sum + result.usage.input, 0),
      outputTokens: runs.reduce((sum, result) => sum + result.usage.output, 0),
      cacheReadTokens: runs.reduce((sum, result) => sum + result.usage.cacheRead, 0),
      cacheWriteTokens: runs.reduce((sum, result) => sum + result.usage.cacheWrite, 0),
      retrievals: runs.reduce((sum, result) => sum + result.retrievals.length, 0),
      testRuns: runs.reduce((sum, result) => sum + result.testRuns, 0) };
  });
  const pairedRegressions = results.filter(result => result.arm !== "baseline" && !result.evaluation.success
    && results.some(baseline => baseline.arm === "baseline" && baseline.task === result.task && baseline.trial === result.trial && baseline.evaluation.success))
    .map(({ task, arm, trial }) => ({ task, arm, trial }));
  const complete = results.length + setupFailures.length === trials * selectedTasks.length * selectedArms.length;
  const summary = { complete, acceptancePassed: complete && setupFailures.length === 0 && results.every(result => result.evaluation.success),
    byArm, pairedRegressions, billingSavings: null };
  writeFileSync(join(root, "report.json"), JSON.stringify({ config, summary, setupFailures, results }, null, 2));
  return summary;
}
save();
console.log(`Local artifacts: ${root}`);
for (let trial = 1; trial <= trials; trial++) for (const [index, task] of selectedTasks.entries()) {
  const source = prepareFixture(join(root, `${task}-${trial}-starting-state`), task);
  // Rotate arm order to reduce a fixed warm-up/order bias; execution is serial.
  const offset = (trial - 1 + index) % selectedArms.length;
  const order = [...selectedArms.slice(offset), ...selectedArms.slice(0, offset)];
  for (const arm of order) {
    const id = `${task}-${trial}-${arm}`;
    try {
      const result = await runTrial({ directory: join(root, id), task, arm, trial, model, modelRuntime: runtime, timeoutMs, source });
      results.push(result);
      console.log(`${id}: ${result.evaluation.success ? "PASS" : "FAIL"}; retrievals=${result.retrievals.length}; tests=${result.testRuns}; error=${result.error ?? "none"}`);
    } catch (error) {
      setupFailures.push({ task, arm, trial, error: error instanceof Error ? error.message : String(error) });
      console.log(`${id}: HARNESS ERROR`);
    }
    save();
  }
}
const summary = save();
console.log(JSON.stringify(summary, null, 2));
if (!summary.acceptancePassed) process.exitCode = 1;
