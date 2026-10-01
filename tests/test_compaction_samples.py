"""Run with .venv/bin/python -m unittest discover -s tests -p 'test_*.py'."""

import json
from io import BytesIO
from pathlib import Path
import subprocess
import unittest

import pandas as pd

from compaction_samples import DOMAINS, VARIANTS, assemble_snapshot, balanced_coverage


class CompactionSamplesTest(unittest.TestCase):
    def fixture(self, variant, domain="parser"):
        return assemble_snapshot(dict(
            domain=domain, evidence_variant=variant,
            scenario=dict(project="SyntheticProject", context="Fictional software product."),
        ))

    def test_parquet_roundtrip_and_snapshot_invariants(self):
        for variant in ("buried-contract", "instruction-like-tool-text"):
            with self.subTest(variant=variant):
                row = self.fixture(variant)
                buffer = BytesIO()
                pd.DataFrame([row]).to_parquet(buffer)
                buffer.seek(0)
                saved = pd.read_parquet(buffer).iloc[0]
                messages = json.loads(saved["snapshot_messages"])
                self.assertEqual(messages, json.loads(row["snapshot_messages"]))
                results = {m["toolCallId"]: m for m in messages if m["role"] == "toolResult"}
                calls = {c["id"]: c for m in messages if m["role"] == "assistant"
                         for c in m["content"] if c["type"] == "toolCall"}
                self.assertEqual(calls.keys(), results.keys())
                self.assertEqual(len(results), 7)
                self.assertTrue(all(len(r["content"][0]["text"]) >= 2000 for r in results.values()))
                self.assertEqual(calls["source-old"]["arguments"], calls["source-new"]["arguments"])
                self.assertEqual(results["tests-old"]["content"], results["tests-new"]["content"])
                contract = results["contract"]["content"][0]["text"]
                offset = contract.index(row["task_spec"]["signature"])
                self.assertGreater(offset, 2000)
                self.assertGreater(len(contract) - offset, 2000)
                self.assertEqual(sum(a["label"] == "stale" for a in row["annotations"]), 2)
                self.assertFalse(any(k in m for m in messages
                                     for k in ("label", "rationale", "annotations")))

    def test_balanced_coverage(self):
        for count in (6, 12, 18):
            frame = balanced_coverage(pd.DataFrame(index=range(count)))
            counts = frame.groupby(["domain", "evidence_variant"]).size()
            self.assertEqual(len(counts), len(DOMAINS) * len(VARIANTS))
            self.assertTrue((counts == count // 6).all())

    def test_plugin_eligibility_and_supersession(self):
        rows = [self.fixture(variant, domain) for domain in DOMAINS for variant in VARIANTS]
        probe = """
import assert from 'node:assert/strict';
import { candidates, superseded } from './src/pruning.ts';
let input = '';
for await (const chunk of process.stdin) input += chunk;
for (const row of JSON.parse(input)) {
    const messages = JSON.parse(row.snapshot_messages);
    const choices = candidates(messages, new Set(), 2000);
    assert.equal(choices.length, 6);
    assert(!choices.some(c => c.result.toolCallId === 'recent-build'));
    const refs = superseded(messages, choices);
    assert.deepEqual(choices.filter(c => refs.has(c.ref))
        .map(c => c.result.toolCallId).sort(), ['source-old', 'tests-old']);
}
"""
        result = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-e", probe],
            input=json.dumps(rows), capture_output=True, text=True,
            cwd=Path(__file__).resolve().parents[1], timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_controlled_domains_and_unfinished_tasks(self):
        for domain, spec in DOMAINS.items():
            with self.subTest(domain=domain):
                row = self.fixture("buried-contract", domain)
                messages = json.loads(row["snapshot_messages"])
                results = {m["toolCallId"]: m["content"][0]["text"]
                           for m in messages if m["role"] == "toolResult"}
                self.assertIn(spec["task"], messages[0]["content"])
                self.assertIn(spec["signature"], results["contract"])
                self.assertEqual(len(row["task_spec"]["constraints"]), 2)
                for constraint in spec["constraints"]:
                    self.assertIn(constraint, results["contract"])
                for call_id in ("source-old", "source-new"):
                    self.assertIn("throw new Error('not implemented')", results[call_id])
                    self.assertIn(spec["function"], results[call_id])
                self.assertNotEqual(results["source-old"], results["source-new"])
                for message in messages:
                    if message["role"] == "toolResult" and message["toolName"] == "read":
                        self.assertIs(message["details"]["metrics"]["truncated"], False)
                self.assertIn("36 passed, 4 skipped, 0 failed", results["tests-new"])
                total = sum(map(len, results.values()))
                self.assertLess(len(results["recent-build"]) / total, 0.4)
                self.assertEqual(row["fixture_notes"]["recommended_keep_recent_tokens"], 2000)


if __name__ == "__main__":
    unittest.main()
