#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = ROOT / "import-manifest.json"
DEFAULT_DESTINATION = ROOT / "upstream"
GENERATED_DESTINATION_PATTERNS = (
    "**/__pycache__/**",
    "**/*.pyc",
    "**/*.egg-info/**",
    ".pytest_cache/**",
    "build/**",
    "dist/**",
)


class ImportError(RuntimeError):
    pass


def run_git(source: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", *args],
        cwd=source,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise ImportError(f"Git command failed: {' '.join(args)}")
    return result.stdout


def load_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ImportError("Import manifest is missing or invalid") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ImportError("Import manifest schema is unsupported")
    return value


def verify_source(source: Path, manifest: dict[str, Any]) -> str:
    source = source.resolve(strict=True)
    if run_git(source, "status", "--porcelain", "--untracked-files=all").strip():
        raise ImportError("AgentTrail source worktree must be clean")
    head = run_git(source, "rev-parse", "HEAD").decode("ascii").strip()
    expected = manifest["source"]["commit"]
    if head != expected:
        raise ImportError(f"AgentTrail source commit mismatch: expected {expected}, got {head}")
    return head


def tracked_files(source: Path, commit: str) -> dict[str, str]:
    output = run_git(source, "ls-tree", "-r", commit).decode("utf-8")
    files: dict[str, str] = {}
    for line in output.splitlines():
        metadata, path = line.split("\t", 1)
        mode, kind, _object_id = metadata.split(" ", 2)
        if kind != "blob":
            raise ImportError(f"Unsupported tracked object kind for {path}")
        normalized = PurePosixPath(path)
        if normalized.is_absolute() or ".." in normalized.parts or str(normalized) != path:
            raise ImportError("Tracked source path is unsafe")
        files[path] = mode
    return files


def selected_files(files: dict[str, str], manifest: dict[str, Any]) -> dict[str, str]:
    selection = manifest["selection"]
    includes = selection["include"]
    excludes = selection["exclude"]
    selected: dict[str, str] = {}
    for path, mode in files.items():
        included = any(fnmatch.fnmatchcase(path, pattern) for pattern in includes)
        excluded = any(fnmatch.fnmatchcase(path, pattern) for pattern in excludes)
        if included and not excluded:
            selected[path] = mode
    return selected


def read_blob(source: Path, commit: str, path: str) -> bytes:
    return run_git(source, "show", f"{commit}:{path}")


def source_snapshot(source: Path, manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    commit = verify_source(source, manifest)
    selected = selected_files(tracked_files(source, commit), manifest)
    snapshot: dict[str, dict[str, Any]] = {}
    for path in sorted(selected):
        content = read_blob(source, commit, path)
        snapshot[path] = {
            "mode": selected[path],
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    return snapshot


def tree_digest(files: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files):
        entry = files[path]
        digest.update(f"{entry['mode']} {entry['sha256']} {entry['bytes']} {path}\n".encode())
    return digest.hexdigest()


def validate_snapshot(snapshot: dict[str, dict[str, Any]], manifest: dict[str, Any]) -> None:
    expected = manifest.get("files")
    if snapshot != expected:
        raise ImportError("Pinned AgentTrail source does not match the import manifest")
    if tree_digest(snapshot) != manifest.get("treeSha256"):
        raise ImportError("AgentTrail manifest tree digest is invalid")


def assert_empty_destination(destination: Path) -> None:
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise ImportError("Import destination must be a real directory")
        if any(destination.iterdir()):
            raise ImportError("Fresh import destination must be empty")
    else:
        destination.mkdir(parents=True, mode=0o755)


def import_to(source: Path, destination: Path, manifest: dict[str, Any]) -> None:
    snapshot = source_snapshot(source, manifest)
    validate_snapshot(snapshot, manifest)
    assert_empty_destination(destination)
    commit = manifest["source"]["commit"]
    try:
        for relative, entry in snapshot.items():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(read_blob(source, commit, relative))
            target.chmod(0o755 if entry["mode"] == "100755" else 0o644)
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def destination_snapshot(destination: Path) -> dict[str, dict[str, Any]]:
    if not destination.is_dir() or destination.is_symlink():
        raise ImportError("Imported AgentTrail destination is missing or unsafe")
    snapshot: dict[str, dict[str, Any]] = {}
    for candidate in sorted(destination.rglob("*")):
        if candidate.is_symlink():
            raise ImportError("Imported AgentTrail tree contains a symbolic link")
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(destination).as_posix()
        if any(fnmatch.fnmatchcase(relative, pattern) for pattern in GENERATED_DESTINATION_PATTERNS):
            raise ImportError(f"Imported AgentTrail tree contains generated artifact: {relative}")
        content = candidate.read_bytes()
        mode = "100755" if candidate.stat().st_mode & stat.S_IXUSR else "100644"
        snapshot[relative] = {
            "mode": mode,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    return snapshot


def check_import(source: Path, destination: Path, manifest: dict[str, Any]) -> None:
    validate_snapshot(source_snapshot(source, manifest), manifest)
    validate_snapshot(destination_snapshot(destination), manifest)


def refresh(source: Path, destination: Path, manifest_path: Path, manifest: dict[str, Any]) -> None:
    if manifest_path.resolve() != DEFAULT_MANIFEST or destination.resolve() != DEFAULT_DESTINATION:
        raise ImportError("Manifest refresh is restricted to the repository import paths")
    snapshot = source_snapshot(source, manifest)
    manifest["files"] = snapshot
    manifest["treeSha256"] = tree_digest(snapshot)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if destination.exists():
        if destination.is_symlink():
            raise ImportError("Import destination must not be a symbolic link")
        shutil.rmtree(destination)
    import_to(source, destination, manifest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reproduce the pinned AgentTrail source import")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--import-fresh", action="store_true")
    mode.add_argument("--refresh", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = load_manifest(args.manifest)
        if args.refresh:
            refresh(args.source, args.destination, args.manifest, manifest)
        elif args.import_fresh:
            import_to(args.source, args.destination, manifest)
        else:
            check_import(args.source, args.destination, manifest)
    except (ImportError, OSError, subprocess.TimeoutExpired) as error:
        print(f"agenttrail import: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
