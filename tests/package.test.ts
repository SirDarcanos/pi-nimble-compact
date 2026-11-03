import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("published tarball installs offline without runtime dependencies and loads in Pi", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), "pi-nimble-package-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  // Keep this consumer check on npm: Pi installs the published npm package,
  // independently of pnpm being used to develop this repository.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(packed[0].files.map((file: { path: string }) => file.path).sort(), ["LICENSE", "NOTICE.md", "README.md", "extensions/nimble.ts", "licenses/fast-jev-compaction-MIT.txt", "licenses/pi-jev-compaction-MIT.txt", "package.json", ...["client", "compact", "index", "messages", "request", "state", "types"].map(name => `src/engine/${name}.ts`), "src/pruning.ts"].sort());
  const consumer = join(temp, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  execFileSync(npm, ["install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(temp, packed[0].filename)], { cwd: consumer, encoding: "utf8" });
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  assert.equal(Object.keys(lock.packages).length, 2, "only the consumer and this package, no runtime dependency tree");
  const installed = join(consumer, "node_modules/pi-nimble-compact");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.version, "0.2.4");
  assert.match(manifest.description, /Deprecated: use pi-s1-compact/);
  assert.deepEqual(manifest.engines, { node: ">=22.19.0" }, "the legacy release must not raise runtime requirements");
  const readme = readFileSync(join(installed, "README.md"), "utf8");
  assert.match(readme, /## Migrate to pi-s1-compact/);
  assert.match(readme, /pi remove npm:pi-nimble-compact\s+pi install npm:pi-s1-compact/);
  assert.match(readme, /Node\.js 24\+.*Pi 1\.0\+/);
  assert.match(readme, /Do not load both pruners/);
  assert.match(readme, /Keep your existing session files/);
  const loader = new DefaultResourceLoader({ cwd: consumer, agentDir: join(temp, "agent"),
    settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: manifest.pi.extensions.map((path: string) => join(installed, path)),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.ok(loader.getExtensions().extensions[0]!.tools.has("nimble_read"));
});
