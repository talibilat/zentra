#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import import_agenttrail


def main() -> int:
    parser = argparse.ArgumentParser(description="Test a fresh pinned AgentTrail import")
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    manifest = import_agenttrail.load_manifest()
    with tempfile.TemporaryDirectory(prefix="zentra-agenttrail-tests-") as directory:
        destination = Path(directory) / "upstream"
        import_agenttrail.import_to(args.source, destination, manifest)
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", directory),
            "TMPDIR": os.environ.get("TMPDIR", directory),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONPATH": str(destination / "src"),
        }
        result = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests"],
            cwd=destination,
            env=environment,
            check=False,
            timeout=600,
        )
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
