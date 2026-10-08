"""Check that maintenance policy never masks a vulnerability or newer version."""

from datetime import date
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-rust.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
spec = importlib.util.spec_from_file_location("vendor", Path(__file__).with_name("check-vendor.py"))
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.package = {"name": "example", "version": "1.0.0"}
        self.record = {"id": "RUSTSEC-EXAMPLE", "affected": [{
            "package": {"name": "example"}, "database_specific": {"informational": "unmaintained"},
        }]}
        self.policy = {"RUSTSEC-EXAMPLE": {
            "package": "example", "version": "1.0.0", "review_by": "2027-01-08",
        }}

    def accepted(self, today=date(2026, 10, 8)):
        return audit.accepted_notice(self.package, self.record, self.policy, today)

    def test_exact_reviewed_maintenance_notice(self):
        self.assertTrue(self.accepted())

    def test_security_and_unsoundness_cannot_be_allowed(self):
        for kind in [None, "unsound"]:
            self.record["affected"][0]["database_specific"]["informational"] = kind
            self.assertFalse(self.accepted())

    def test_new_version_requires_review(self):
        self.package["version"] = "1.0.1"
        self.assertFalse(self.accepted())

    def test_expired_review_fails(self):
        self.assertFalse(self.accepted(date(2027, 1, 9)))

    def test_unknown_notice_fails(self):
        self.record["id"] = "RUSTSEC-UNKNOWN"
        self.assertFalse(self.accepted())

    def test_different_package_fails(self):
        self.package["name"] = "different"
        self.assertFalse(self.accepted())

    def test_only_the_backported_glib_advisory_is_resolved(self):
        package = {"name": "glib", "version": "0.18.5"}
        self.assertTrue(audit.resolved_by_backport(package, {"id": "RUSTSEC-2024-0429"}))
        self.assertTrue(audit.resolved_by_backport(package, {"id": "GHSA-wrw7-89jp-8q8g"}))
        self.assertFalse(audit.resolved_by_backport(package, {"id": "RUSTSEC-NEW"}))
        self.assertFalse(audit.resolved_by_backport(
            {**package, "source": "registry+example"}, {"id": "RUSTSEC-2024-0429"},
        ))
        self.assertFalse(audit.resolved_by_backport(
            {**package, "version": "0.18.4"}, {"id": "RUSTSEC-2024-0429"},
        ))


class VendorTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / "vendor/glib/src").mkdir(parents=True)
        (self.root / "security").mkdir()
        self.source = self.root / "vendor/glib/src/variant_iter.rs"
        self.source.write_text("let mut p: *mut libc::c_char;\n                &mut p,\n")
        record = {"version": "0.18.5", "files": {
            "src/variant_iter.rs": hashlib.sha256(self.source.read_bytes()).hexdigest(),
        }}
        (self.root / "security/vendor-integrity.json").write_text(json.dumps(record))
        (self.root / "Cargo.toml").write_text('[patch.crates-io]\nglib = { path = "vendor/glib" }\n')
        (self.root / "Cargo.lock").write_text('[[package]]\nname = "glib"\nversion = "0.18.5"\n')

    def check(self):
        with redirect_stdout(io.StringIO()):
            vendor.check_vendor(self.root)

    def test_reviewed_backport_passes(self):
        self.check()

    def test_altered_dependency_fails(self):
        self.source.write_text(self.source.read_text() + "unreviewed change\n")
        with self.assertRaises(ValueError):
            self.check()

    def test_additional_source_file_fails(self):
        (self.source.parent / "extra.rs").write_text("unreviewed source")
        with self.assertRaises(ValueError):
            self.check()

    def test_registry_fallback_fails(self):
        lock = self.root / "Cargo.lock"
        lock.write_text(lock.read_text() + 'source = "registry+https://github.com/rust-lang/crates.io-index"\n')
        with self.assertRaises(ValueError):
            self.check()

    def test_symlink_fails(self):
        (self.source.parent / "link.rs").symlink_to(self.source)
        with self.assertRaises(ValueError):
            self.check()


if __name__ == "__main__":
    unittest.main()
