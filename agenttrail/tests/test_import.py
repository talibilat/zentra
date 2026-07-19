from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import import_agenttrail


AGENTTRAIL = Path(__file__).parents[1]
REPOSITORY = Path(__file__).parents[2]
MANIFEST = AGENTTRAIL / "import-manifest.json"
UPSTREAM = AGENTTRAIL / "upstream"


class ImportTests(unittest.TestCase):
    def test_committed_import_matches_manifest_and_product_boundary(self):
        manifest = import_agenttrail.load_manifest(MANIFEST)
        imported = import_agenttrail.destination_snapshot(UPSTREAM)
        import_agenttrail.validate_snapshot(imported, manifest)

        self.assertEqual(manifest["license"]["spdx"], "MIT")
        self.assertIn("MIT License", (UPSTREAM / "LICENSE").read_text(encoding="utf-8"))
        self.assertTrue((UPSTREAM / "src" / "agent_tail" / "web" / "index.html").is_file())
        self.assertTrue((UPSTREAM / "tests" / "test_e2e.py").is_file())
        self.assertNotIn("examples/demo-run.jsonl", manifest["files"])
        self.assertNotIn("tests/test_examples.py", manifest["files"])
        self.assertFalse((UPSTREAM / ".scratch").exists())
        self.assertFalse(any("__pycache__" in path for path in manifest["files"]))

        readme = (AGENTTRAIL / "README.md").read_text(encoding="utf-8")
        self.assertIn("AgentTrail", readme)
        self.assertIn("Agent Tail `1.x` event envelope", readme)
        self.assertIn("grants no execution", readme)

    def test_clean_source_guard_rejects_dirty_and_mismatched_repositories(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            self._git(source, "init")
            self._git(source, "config", "user.name", "AgentTrail Import Test")
            self._git(source, "config", "user.email", "agenttrail@example.invalid")
            (source / "LICENSE").write_text("MIT License\n", encoding="utf-8")
            (source / "src").mkdir()
            (source / "src" / "keep.py").write_text("VALUE = 1\n", encoding="utf-8")
            self._git(source, "add", ".")
            self._git(source, "commit", "-m", "fixture")
            commit = self._git(source, "rev-parse", "HEAD").strip()
            manifest = self._fixture_manifest(commit)

            (source / "dirty.txt").write_text("not committed\n", encoding="utf-8")
            with self.assertRaisesRegex(import_agenttrail.ImportError, "must be clean"):
                import_agenttrail.verify_source(source, manifest)
            (source / "dirty.txt").unlink()

            manifest["source"]["commit"] = "0" * 40
            with self.assertRaisesRegex(import_agenttrail.ImportError, "commit mismatch"):
                import_agenttrail.verify_source(source, manifest)

    def test_fresh_import_reproduces_manifest_and_excludes_forbidden_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            self._git(source, "init")
            self._git(source, "config", "user.name", "AgentTrail Import Test")
            self._git(source, "config", "user.email", "agenttrail@example.invalid")
            (source / "LICENSE").write_text("MIT License\n", encoding="utf-8")
            (source / "src").mkdir()
            (source / "src" / "keep.py").write_text("VALUE = 1\n", encoding="utf-8")
            (source / "examples").mkdir()
            (source / "examples" / "demo.jsonl").write_text("{}\n", encoding="utf-8")
            (source / ".scratch").mkdir()
            (source / ".scratch" / "plan.md").write_text("scratch\n", encoding="utf-8")
            self._git(source, "add", ".")
            self._git(source, "commit", "-m", "fixture")
            commit = self._git(source, "rev-parse", "HEAD").strip()
            manifest = self._fixture_manifest(commit)
            snapshot = import_agenttrail.source_snapshot(source, manifest)
            manifest["files"] = snapshot
            manifest["treeSha256"] = import_agenttrail.tree_digest(snapshot)

            destination = root / "fresh"
            import_agenttrail.import_to(source, destination, manifest)

            self.assertEqual(import_agenttrail.destination_snapshot(destination), snapshot)
            self.assertTrue((destination / "src" / "keep.py").is_file())
            self.assertFalse((destination / "examples").exists())
            self.assertFalse((destination / ".scratch").exists())

            generated = destination / "build" / "generated.py"
            generated.parent.mkdir()
            generated.write_text("generated\n", encoding="utf-8")
            with self.assertRaisesRegex(import_agenttrail.ImportError, "generated artifact"):
                import_agenttrail.destination_snapshot(destination)

    def test_manifest_is_canonical_json(self):
        parsed = json.loads(MANIFEST.read_text(encoding="utf-8"))
        expected = json.dumps(parsed, indent=2, sort_keys=True) + "\n"
        self.assertEqual(MANIFEST.read_text(encoding="utf-8"), expected)

    def _fixture_manifest(self, commit: str):
        return {
            "schemaVersion": 1,
            "source": {"repository": "fixture", "commit": commit},
            "license": {"spdx": "MIT", "decision": "fixture"},
            "selection": {
                "include": ["LICENSE", "src/**"],
                "exclude": ["examples/**", ".scratch/**", "**/__pycache__/**"],
            },
            "files": {},
            "treeSha256": "",
        }

    def _git(self, source: Path, *args: str) -> str:
        result = subprocess.run(
            ["/usr/bin/git", *args], cwd=source,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, timeout=10,
        )
        if result.returncode != 0:
            self.fail(result.stderr)
        return result.stdout


if __name__ == "__main__":
    unittest.main()
