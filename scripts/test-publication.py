"""Publication checks must inspect staged content and exclude local artifacts."""

from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name("check-publication.mjs")


class PublicationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        (self.root / "README.md").write_text("Generic project documentation.\n")
        (self.root / ".env.example").write_text("EXAMPLE_FLAG=enabled\n")
        self.stage()

    def stage(self):
        subprocess.run(["git", "add", "--all"], cwd=self.root, check=True)

    def run_check(self):
        return subprocess.run(["node", str(SCRIPT)], cwd=self.root, capture_output=True, text=True)

    def test_example_configuration_passes(self):
        self.assertEqual(self.run_check().returncode, 0)

    def test_local_environment_file_fails(self):
        (self.root / ".env").write_text("EXAMPLE_FLAG=enabled\n")
        self.stage()
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("private local file", result.stderr)

    def test_dependency_symlink_fails(self):
        (self.root / "node_modules").symlink_to(self.root, target_is_directory=True)
        self.stage()
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("local dependency or build artifact", result.stderr)

    def test_absolute_symlink_fails(self):
        (self.root / "external").symlink_to(self.root / "README.md")
        self.stage()
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("absolute symbolic link", result.stderr)

    def test_staged_paths_fail_without_disclosing_the_value(self):
        private_path = "/" + "/".join(["home", "example", "private.txt"])
        (self.root / "README.md").write_text(private_path)
        # An unstaged local change is not part of the proposed publication.
        self.assertEqual(self.run_check().returncode, 0)
        self.stage()
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("personal filesystem path", result.stderr)
        self.assertNotIn(private_path, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
