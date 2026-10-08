"""Verify the complete GLib backport and the lockfile's use of it."""

import hashlib
import json
from pathlib import Path
import tomllib


def check_vendor(root):
    record = json.loads((root / "security/vendor-integrity.json").read_text())
    vendor = root / "vendor/glib"
    if any(p.is_symlink() for p in vendor.rglob("*")):
        raise ValueError("GLib backport must not contain symlinks")
    actual = {
        p.relative_to(vendor).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in vendor.rglob("*") if p.is_file()
    }
    if actual != record["files"]:
        raise ValueError("GLib backport differs from its reviewed integrity manifest")
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    if manifest["patch"]["crates-io"]["glib"] != {"path": "vendor/glib"}:
        raise ValueError("Cargo must use the reviewed local GLib backport")
    packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    glib = [p for p in packages if p["name"] == "glib"]
    if len(glib) != 1 or glib[0]["version"] != record["version"] or "source" in glib[0]:
        raise ValueError("Cargo.lock must resolve GLib exclusively to the local backport")
    source = (vendor / "src/variant_iter.rs").read_text()
    if "let mut p: *mut libc::c_char" not in source or "                &mut p," not in source:
        raise ValueError("GLib VariantStrIter out-argument fix is missing")
    print(f"Verified GLib {record['version']} backport: {len(actual)} files")


if __name__ == "__main__":
    check_vendor(Path(__file__).resolve().parent.parent)
