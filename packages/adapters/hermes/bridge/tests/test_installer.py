import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_butler_bridge import installer
from agent_butler_bridge.patches import PATCH_SPECS, PatchDriftError


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "hermes_runtime"


class InstallerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "hermes-agent"
        shutil.copytree(FIXTURE_ROOT, self.root)
        self.backups = Path(self.tmp.name) / "backups"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_check_is_read_only_and_explicitly_static_only(self) -> None:
        before = tree_hashes(self.root)

        report = installer.check(self.root)

        self.assertEqual(tree_hashes(self.root), before)
        self.assertFalse(self.backups.exists())
        self.assertTrue(report["installable"])
        self.assertTrue(report["coverage"]["staticOnly"])
        self.assertFalse(report["coverage"]["provesLiveL3"])
        self.assertTrue(
            all(row["status"] == "missing" for row in report["coverage"]["rows"])
        )

    def test_install_is_atomic_idempotent_and_rollback_restores_hashes(self) -> None:
        original = target_hashes(self.root)

        installed = installer.install(self.root, backup_root=self.backups)
        manifest = Path(installed["manifest"])
        repeated = installer.install(self.root, backup_root=self.backups)

        self.assertEqual(installed["status"], "installed")
        self.assertTrue(manifest.is_file())
        self.assertEqual(repeated["status"], "already-installed")
        self.assertIsNone(repeated["manifest"])
        self.assertTrue((self.root / "gateway" / "butler_bridge" / "runtime.py").is_file())
        for spec in PATCH_SPECS:
            text = (self.root / spec.path).read_text(encoding="utf-8")
            self.assertEqual(text.count(spec.begin_marker), 1)
            self.assertTrue(text.endswith(spec.block + "\n"))
        coverage = installed["check"]["coverage"]
        self.assertTrue(all(row["status"] == "declared" for row in coverage["rows"]))

        rolled_back = installer.rollback(manifest)

        self.assertEqual(rolled_back["status"], "rolled-back")
        self.assertEqual(target_hashes(self.root), original)
        self.assertTrue(installer.check(self.root)["installable"])

    def test_partial_marker_and_anchor_drift_abort_without_writes(self) -> None:
        target = self.root / PATCH_SPECS[0].path
        target.write_text(
            target.read_text(encoding="utf-8") + "\n" + PATCH_SPECS[0].begin_marker + "\n",
            encoding="utf-8",
        )
        before = tree_hashes(self.root)
        with self.assertRaises(PatchDriftError):
            installer.install(self.root, backup_root=self.backups)
        self.assertEqual(tree_hashes(self.root), before)
        self.assertFalse(self.backups.exists())

        target = self.root / PATCH_SPECS[2].path
        target.write_text(
            target.read_text(encoding="utf-8").replace('            "port": self._port,', '            "port": 9999,'),
            encoding="utf-8",
        )
        before = tree_hashes(self.root)
        with self.assertRaises(PatchDriftError):
            installer.check(self.root)
        self.assertEqual(tree_hashes(self.root), before)

    def test_mid_install_failure_restores_every_applied_target(self) -> None:
        before = tree_hashes(self.root)
        original_write = installer._atomic_write_bytes
        calls = 0

        def fail_on_third(path, payload):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("injected write failure")
            return original_write(path, payload)

        with mock.patch.object(installer, "_atomic_write_bytes", side_effect=fail_on_third):
            with self.assertRaisesRegex(OSError, "injected"):
                installer.install(self.root, backup_root=self.backups)

        self.assertEqual(tree_hashes(self.root), before)

    def test_failed_post_install_check_rolls_back_and_removes_manifest(self) -> None:
        before = tree_hashes(self.root)
        original_check = installer.check
        calls = 0

        def fail_post_check(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise PatchDriftError("injected post-install check failure")
            return original_check(*args, **kwargs)

        with mock.patch.object(installer, "check", side_effect=fail_post_check):
            with self.assertRaisesRegex(PatchDriftError, "post-install"):
                installer.install(self.root, backup_root=self.backups)

        self.assertEqual(tree_hashes(self.root), before)
        self.assertEqual(list(self.backups.rglob("manifest.json")), [])

    def test_rollback_refuses_current_hash_drift_before_any_restore(self) -> None:
        installed = installer.install(self.root, backup_root=self.backups)
        target = self.root / PATCH_SPECS[0].path
        target.write_text(target.read_text(encoding="utf-8") + "# user drift\n", encoding="utf-8")
        before = tree_hashes(self.root)

        with self.assertRaisesRegex(RuntimeError, "hash drift"):
            installer.rollback(installed["manifest"])

        self.assertEqual(tree_hashes(self.root), before)


def tree_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256(path)
        for path in root.rglob("*")
        if path.is_file()
    }


def target_hashes(root: Path) -> dict[str, str]:
    return {spec.path: sha256(root / spec.path) for spec in PATCH_SPECS}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
