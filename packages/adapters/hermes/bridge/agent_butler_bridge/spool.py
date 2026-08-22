"""Private, content-addressed attachment staging for Bridge capture."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import shutil
from pathlib import Path
from typing import Any, Iterable, Mapping

from .ids import uuid7


DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
DEFAULT_MAX_ATTACHMENTS = 32
COPY_CHUNK_BYTES = 1024 * 1024


class AttachmentSpool:
    def __init__(
        self,
        root: str | Path,
        *,
        max_attachment_bytes: int = DEFAULT_MAX_ATTACHMENT_BYTES,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
        max_attachments: int = DEFAULT_MAX_ATTACHMENTS,
    ) -> None:
        self.root = Path(root)
        if max_attachment_bytes <= 0 or max_total_bytes <= 0 or max_attachments <= 0:
            raise ValueError("attachment size limits must be positive")
        if max_total_bytes < max_attachment_bytes:
            raise ValueError("total attachment limit must be at least the per-file limit")
        self.max_attachment_bytes = max_attachment_bytes
        self.max_total_bytes = max_total_bytes
        self.max_attachments = max_attachments

    def stage(
        self,
        message_id: str,
        sources: Iterable[str | Path | Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        _validate_message_id(message_id)
        message_dir = self.root / message_id
        if message_dir.exists():
            raise ValueError("message attachment spool already exists")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        message_dir.mkdir(mode=0o700)
        staged: list[dict[str, Any]] = []
        total = 0
        try:
            for index, raw_source in enumerate(sources):
                if index >= self.max_attachments:
                    raise ValueError("attachment count exceeds limit")
                source, requested_mime = _parse_source(raw_source)
                source_stat = source.lstat()
                if source.is_symlink():
                    raise ValueError(f"attachment source must not be a symlink: {source}")
                if not source.is_file():
                    raise ValueError(f"attachment source must be a regular file: {source}")
                size = int(source_stat.st_size)
                if size > self.max_attachment_bytes:
                    raise ValueError(f"attachment exceeds size limit: {source.name}")
                total += size
                if total > self.max_total_bytes:
                    raise ValueError("attachments exceed total size limit")

                file_name = _safe_name(source.name)
                destination = message_dir / f"{index:03d}-{file_name}"
                digest = hashlib.sha256()
                with source.open("rb") as reader, destination.open("xb") as writer:
                    while True:
                        chunk = reader.read(COPY_CHUNK_BYTES)
                        if not chunk:
                            break
                        digest.update(chunk)
                        writer.write(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
                destination.chmod(0o600)
                if destination.stat().st_size != size:
                    raise OSError(f"attachment size changed while copying: {source}")
                staged.append(
                    {
                        "attachmentId": uuid7(),
                        "fileName": file_name,
                        "mimeType": requested_mime
                        or mimetypes.guess_type(file_name)[0]
                        or "application/octet-stream",
                        "sizeBytes": size,
                        "sha256": digest.hexdigest(),
                        "spoolPath": str(destination),
                    }
                )
            return staged
        except BaseException:
            shutil.rmtree(message_dir, ignore_errors=True)
            raise

    def cleanup(self, message_id: str) -> None:
        _validate_message_id(message_id)
        shutil.rmtree(self.root / message_id, ignore_errors=True)


def _parse_source(raw: str | Path | Mapping[str, Any]) -> tuple[Path, str | None]:
    if isinstance(raw, (str, Path)):
        return Path(raw).expanduser(), None
    if not isinstance(raw, Mapping):
        raise ValueError("attachment source must be a path or object")
    path = raw.get("path")
    mime_type = raw.get("mimeType")
    if not isinstance(path, (str, Path)) or not str(path):
        raise ValueError("attachment path must be non-empty")
    if mime_type is not None and (not isinstance(mime_type, str) or not mime_type):
        raise ValueError("attachment mimeType must be a non-empty string")
    return Path(path).expanduser(), mime_type


def _safe_name(name: str) -> str:
    cleaned = "".join(character for character in name if character not in "\\/\0").strip()
    return cleaned[:255] or "attachment.bin"


def _validate_message_id(message_id: str) -> None:
    if (
        not isinstance(message_id, str)
        or not message_id
        or message_id in {".", ".."}
        or any(separator in message_id for separator in ("/", "\\", "\0"))
    ):
        raise ValueError("message_id must be a single safe path segment")
