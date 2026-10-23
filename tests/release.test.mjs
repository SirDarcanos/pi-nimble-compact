import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t, { name = "pi-nimble-compact", version = "0.1.0", changelog = "## [0.1.0] - 2026-10-01", tag = "v0.1.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-nimble-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("../scripts/verify-release.mjs", import.meta.url), join(root, "scripts/verify-release.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return spawnSync(process.execPath, [join(root, "scripts/verify-release.mjs"), tag], { encoding: "utf8" });
}

test("release metadata accepts a matching stable tag and changelog", t => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, options, message] of [
  ["mismatched tag", { tag: "v0.2.0" }, "Release tag must match"],
  ["unexpected package name", { name: "wrong-package" }, "Unexpected npm package name"],
  ["missing release notes", { changelog: "## [Unreleased]" }, "Add a dated changelog"],
  ["prerelease version", { version: "0.1.0-beta.1", tag: "v0.1.0-beta.1" }, "Only stable releases"],
]) {
  test(`release metadata rejects ${name}`, t => {
    const result = fixture(t, options);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
  });
}
