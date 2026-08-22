import hashlib
import tempfile
import unittest
from pathlib import Path

from agent_butler_bridge.spool import AttachmentSpool


class AttachmentSpoolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.spool = AttachmentSpool(self.root / "spool", max_attachment_bytes=16)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_stage_copies_hashes_and_survives_source_removal(self) -> None:
        source = self.root / "report.txt"
        source.write_text("hello", encoding="utf-8")

        staged = self.spool.stage("message-1", [source])
        source.unlink()

        self.assertEqual(len(staged), 1)
        self.assertEqual(staged[0]["fileName"], "report.txt")
        self.assertEqual(staged[0]["sizeBytes"], 5)
        self.assertEqual(staged[0]["sha256"], hashlib.sha256(b"hello").hexdigest())
        spool_path = Path(staged[0]["spoolPath"])
        self.assertEqual(spool_path.read_bytes(), b"hello")
        self.assertEqual(spool_path.stat().st_mode & 0o777, 0o600)

    def test_failure_removes_partial_message_directory(self) -> None:
        first = self.root / "small.txt"
        first.write_text("small", encoding="utf-8")
        oversized = self.root / "large.bin"
        oversized.write_bytes(b"x" * 17)

        with self.assertRaisesRegex(ValueError, "size limit"):
            self.spool.stage("message-2", [first, oversized])

        self.assertFalse((self.root / "spool" / "message-2").exists())

    def test_rejects_symlink_sources(self) -> None:
        source = self.root / "source.txt"
        source.write_text("hello", encoding="utf-8")
        link = self.root / "link.txt"
        try:
            link.symlink_to(source)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")

        with self.assertRaisesRegex(ValueError, "symlink"):
            self.spool.stage("message-3", [link])

    def test_rejects_message_id_path_traversal(self) -> None:
        source = self.root / "source.txt"
        source.write_text("hello", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "path segment"):
            self.spool.stage("../escape", [source])

        self.assertFalse((self.root / "escape").exists())


if __name__ == "__main__":
    unittest.main()
