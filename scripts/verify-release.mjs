import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const tag = process.argv[2];

assert.equal(manifest.name, "pi-nimble-compact", "Unexpected npm package name");
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Only stable releases are supported");
assert.equal(tag, `v${manifest.version}`, "Release tag must match package.json");
assert.equal(lock.name, manifest.name, "Lockfile package name must match");
assert.equal(lock.packages[""].name, manifest.name, "Lockfile root package name must match");
assert.equal(lock.version, manifest.version, "Lockfile version must match");
assert.equal(lock.packages[""].version, manifest.version, "Lockfile root version must match");
assert.ok(changelog.split("\n").some(line =>
  line.startsWith(`## [${manifest.version}] - `) && /^\d{4}-\d{2}-\d{2}$/.test(line.slice(-10))),
"Add a dated changelog entry for this version before releasing");
console.log(`Release metadata verified: ${manifest.name}@${manifest.version} (${tag})`);
