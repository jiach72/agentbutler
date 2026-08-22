"""Transactional installer for the managed Hermes Agent Butler Bridge hooks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .patches import (
    PATCH_SPECS,
    PatchDriftError,
    analyze_patch,
    render_patch,
    static_coverage_rows,
)


MANAGED_RELATIVE_ROOT = Path("gateway/butler_bridge")
MANIFEST_VERSION = 1


def check(
    hermes_root: str | Path,
    *,
    source_package: str | Path | None = None,
) -> dict[str, Any]:
    """Read-only validation of anchors, managed files, and static declarations."""

    root = _existing_directory(hermes_root)
    source = _source_package(source_package)
    source_files = _managed_source_files(source)
    _validate_python_files(source_files.values())

    patch_statuses: dict[str, str] = {}
    patch_reports: list[dict[str, str]] = []
    for spec in PATCH_SPECS:
        target = _target(root, spec.path)
        if not target.is_file():
            raise FileNotFoundError(f"Hermes patch target not found: {target}")
        state = analyze_patch(target.read_text(encoding="utf-8"), spec)
        patch_statuses[spec.path] = state
        patch_reports.append({"path": spec.path, "status": state})

    managed_status = _managed_status(root, source_files)
    patch_states = set(patch_statuses.values())
    if len(patch_states) > 1:
        raise PatchDriftError("Hermes contains only a subset of the managed hook blocks")
    only_patch_state = next(iter(patch_states))
    if (only_patch_state == "installed") != (managed_status == "installed"):
        raise PatchDriftError("managed package and Hermes hook blocks are out of sync")

    return {
        "root": str(root),
        "installable": only_patch_state == "missing" and managed_status == "missing",
        "alreadyInstalled": only_patch_state == "installed" and managed_status == "installed",
        "managedPackage": managed_status,
        "patches": patch_reports,
        "coverage": {
            "staticOnly": True,
            "provesLiveL3": False,
            "rows": static_coverage_rows(patch_statuses),
        },
    }


def install(
    hermes_root: str | Path,
    *,
    source_package: str | Path | None = None,
    backup_root: str | Path | None = None,
) -> dict[str, Any]:
    """Atomically install every managed file after a complete read-only preflight."""

    root = _existing_directory(hermes_root)
    source = _source_package(source_package)
    report = check(root, source_package=source)
    if report["alreadyInstalled"]:
        return {"status": "already-installed", "manifest": None, "check": report}

    source_files = _managed_source_files(source)
    operations: list[tuple[Path, bytes]] = []
    for spec in PATCH_SPECS:
        target = _target(root, spec.path)
        current = target.read_text(encoding="utf-8")
        operations.append((target, render_patch(current, spec).encode("utf-8")))
    for relative, source_file in sorted(source_files.items(), key=lambda item: item[0].as_posix()):
        operations.append((_target(root, MANAGED_RELATIVE_ROOT / relative), source_file.read_bytes()))

    # Validate every output before creating the backup directory or touching a
    # target. This keeps anchor/import/compile failures strictly zero-write.
    for target, payload in operations:
        if target.exists() and not target.is_file():
            raise IsADirectoryError(f"managed target is not a regular file: {target}")
        if target.suffix == ".py":
            compile(payload.decode("utf-8"), str(target), "exec")

    selected_backup_root = (
        Path(backup_root).expanduser().resolve()
        if backup_root is not None
        else (root.parent / f".{root.name}-agent-butler-backups").resolve()
    )
    transaction_dir = selected_backup_root / _timestamp_id()
    transaction_dir.mkdir(parents=True, exist_ok=False)
    manifest_path = transaction_dir / "manifest.json"
    entries: list[dict[str, Any]] = []

    for target, payload in operations:
        relative = target.relative_to(root)
        existed = target.is_file()
        pre_sha = _sha256_file(target) if existed else None
        backup_path = transaction_dir / "files" / relative
        if existed:
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup_path)
        entries.append(
            {
                "path": relative.as_posix(),
                "existed": existed,
                "preSha256": pre_sha,
                "postSha256": _sha256_bytes(payload),
                "backupPath": str(backup_path) if existed else None,
            }
        )

    applied: list[dict[str, Any]] = []
    try:
        for (target, payload), entry in zip(operations, entries):
            applied.append(entry)
            _atomic_write_bytes(target, payload)
            if _sha256_file(target) != entry["postSha256"]:
                raise RuntimeError(f"post-write hash mismatch: {target}")
        manifest = {
            "version": MANIFEST_VERSION,
            "createdAt": _utc_now(),
            "root": str(root),
            "sourcePackage": str(source),
            "files": entries,
        }
        _atomic_write_bytes(
            manifest_path,
            (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
        installed = check(root, source_package=source)
    except BaseException:
        _restore_entries(root, reversed(applied), verify_current=False)
        if manifest_path.is_file():
            manifest_path.unlink()
        raise

    return {
        "status": "installed",
        "manifest": str(manifest_path),
        "check": installed,
    }


def rollback(manifest_file: str | Path) -> dict[str, Any]:
    """Restore exactly one manifest after verifying every current post hash."""

    manifest_path = Path(manifest_file).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != MANIFEST_VERSION:
        raise ValueError("unsupported installer manifest version")
    root = _existing_directory(manifest.get("root"))
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("installer manifest contains no files")

    resolved: list[tuple[Path, dict[str, Any]]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid installer manifest entry")
        target = _target(root, str(entry.get("path") or ""))
        expected = entry.get("postSha256")
        if not isinstance(expected, str) or not target.is_file():
            raise RuntimeError(f"rollback refused: installed target is missing: {target}")
        if _sha256_file(target) != expected:
            raise RuntimeError(f"rollback refused: post-install hash drift: {target}")
        if entry.get("existed"):
            backup = Path(str(entry.get("backupPath") or "")).expanduser().resolve()
            if not backup.is_file():
                raise RuntimeError(f"rollback backup is missing: {backup}")
            if _sha256_file(backup) != entry.get("preSha256"):
                raise RuntimeError(f"rollback backup hash mismatch: {backup}")
        resolved.append((target, entry))

    _restore_entries(root, (entry for _target_path, entry in reversed(resolved)))

    for target, entry in resolved:
        if entry.get("existed"):
            if not target.is_file() or _sha256_file(target) != entry.get("preSha256"):
                raise RuntimeError(f"rollback verification failed: {target}")
        elif target.exists():
            raise RuntimeError(f"rollback failed to remove newly installed file: {target}")
    return {"status": "rolled-back", "manifest": str(manifest_path), "root": str(root)}


def _restore_entries(
    root: Path,
    entries: Iterable[dict[str, Any]],
    *,
    verify_current: bool = True,
) -> None:
    for entry in entries:
        target = _target(root, str(entry["path"]))
        if verify_current and target.is_file():
            expected = entry.get("postSha256")
            if expected and _sha256_file(target) != expected:
                raise RuntimeError(f"restore refused after target drift: {target}")
        if entry.get("existed"):
            backup = Path(str(entry["backupPath"])).expanduser().resolve()
            _atomic_write_bytes(target, backup.read_bytes())
        elif target.exists():
            if not target.is_file():
                raise IsADirectoryError(f"refusing to remove non-file target: {target}")
            target.unlink()


def _managed_status(root: Path, source_files: dict[Path, Path]) -> str:
    destination = _target(root, MANAGED_RELATIVE_ROOT)
    if not destination.exists():
        return "missing"
    if not destination.is_dir():
        raise PatchDriftError(f"managed package path is not a directory: {destination}")
    actual_files = {
        path.relative_to(destination)
        for path in destination.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }
    if not actual_files:
        return "missing"
    expected = set(source_files)
    if actual_files != expected:
        raise PatchDriftError("managed package file set has drifted")
    for relative, source in source_files.items():
        if _sha256_file(destination / relative) != _sha256_file(source):
            raise PatchDriftError(f"managed package file has drifted: {relative.as_posix()}")
    return "installed"


def _managed_source_files(source: Path) -> dict[Path, Path]:
    files = {
        path.relative_to(source): path
        for path in source.rglob("*.py")
        if path.is_file() and "__pycache__" not in path.parts
    }
    if Path("__init__.py") not in files:
        raise FileNotFoundError(f"Bridge source package has no __init__.py: {source}")
    return files


def _validate_python_files(paths: Iterable[Path]) -> None:
    for path in paths:
        compile(path.read_text(encoding="utf-8"), str(path), "exec")


def _source_package(value: str | Path | None) -> Path:
    source = Path(value).expanduser().resolve() if value is not None else Path(__file__).parent.resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"Bridge source package not found: {source}")
    return source


def _existing_directory(value: str | Path | None) -> Path:
    if value is None:
        raise ValueError("Hermes root is required")
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise FileNotFoundError(f"Hermes root is not a directory: {path}")
    return path


def _target(root: Path, relative: str | Path) -> Path:
    raw = Path(relative)
    if raw.is_absolute() or not raw.parts:
        raise ValueError(f"invalid managed relative path: {relative}")
    target = (root / raw).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"managed path escapes Hermes root: {relative}") from exc
    return target


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(previous_mode)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _timestamp_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "install"):
        selected = subparsers.add_parser(command)
        selected.add_argument("root")
        selected.add_argument("--source-package")
        if command == "install":
            selected.add_argument("--backup-root")
    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("manifest")
    args = parser.parse_args(argv)

    if args.command == "check":
        result = check(args.root, source_package=args.source_package)
    elif args.command == "install":
        result = install(
            args.root,
            source_package=args.source_package,
            backup_root=args.backup_root,
        )
    else:
        result = rollback(args.manifest)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
