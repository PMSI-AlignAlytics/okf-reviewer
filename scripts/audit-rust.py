"""Check locked registry packages against OSV's live RustSec advisories.

The local GLib backport is checked by content and lock resolution, and queried
for new advisories too. Only its specifically backported advisory is resolved.
Only exact, time-bounded unmaintained-package notices can pass the policy.
Vulnerabilities, unsoundness, unknown notices and API failures fail the check.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
import importlib.util
import json
from pathlib import Path
import sys
import tomllib
import urllib.request


def request_json(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json", "User-Agent": "okf-dependency-audit",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def accepted_notice(package, record, policy, today):
    if record.get("withdrawn"):
        return True
    affected = [a for a in record["affected"] if a["package"]["name"] == package["name"]]
    # Never allow a security advisory merely because it shares a known ID.
    if not affected or any(a.get("database_specific", {}).get("informational") != "unmaintained" for a in affected):
        return False
    identifiers = {record["id"], *record.get("aliases", [])}
    for identifier in identifiers:
        notice = policy.get(identifier)
        if notice and notice["package"] == package["name"] and notice["version"] == package["version"]:
            return today <= date.fromisoformat(notice["review_by"])
    return False


def resolved_by_backport(package, record):
    # check_vendor() must pass before the live audit. Do not exclude the local
    # package from OSV: a different advisory against this version must fail.
    return (package["name"] == "glib" and package["version"] == "0.18.5"
            and "source" not in package
            and record["id"] in {"RUSTSEC-2024-0429", "GHSA-wrw7-89jp-8q8g"})


def main():
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("check_vendor", root / "scripts/check-vendor.py")
    vendor_check = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vendor_check)
    vendor_check.check_vendor(root)
    packages = [p for p in tomllib.loads((root / "Cargo.lock").read_text())["package"]
                if p.get("source", "").startswith("registry+") or p["name"] == "glib"]
    packages = list({(p["name"], p["version"]): p for p in packages}.values())
    rows = []
    for start in range(0, len(packages), 150):
        batch = packages[start:start + 150]
        result = request_json("https://api.osv.dev/v1/querybatch", {"queries": [
            {"package": {"ecosystem": "crates.io", "name": p["name"]}, "version": p["version"]}
            for p in batch
        ]})
        if len(result["results"]) != len(batch):
            raise ValueError("OSV returned an incomplete batch")
        rows.extend(zip(batch, result["results"]))
    identifiers = sorted({v["id"] for _, row in rows for v in row.get("vulns", [])})
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = dict(zip(identifiers, pool.map(
            lambda i: request_json("https://api.osv.dev/v1/vulns/" + i), identifiers,
        )))
    policy = json.loads((root / "security/maintenance-policy.json").read_text())["notices"]
    failures = []
    today = date.today()
    for package, row in rows:
        for vuln in row.get("vulns", []):
            record = records[vuln["id"]]
            if record.get("withdrawn"):
                continue
            label = f"{package['name']} {package['version']}: {record['id']}"
            if resolved_by_backport(package, record):
                print("Resolved by verified GLib backport — " + label)
            elif accepted_notice(package, record, policy, today):
                print("Reviewed maintenance notice — " + label)
            else:
                failures.append(label)
    print(f"Checked {len(packages)} locked dependency versions; {len(failures)} unresolved advisories")
    for failure in failures:
        print("ERROR: " + failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
