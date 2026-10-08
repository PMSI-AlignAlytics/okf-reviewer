#!/usr/bin/env node
// Rebuild Tauri's Debian package from its staging tree with dpkg-deb.
//
// Tauri's bundler writes the .deb's outer ar archive itself and records the
// building account's numeric UID and GID in the ar member headers, whose owner
// fields are six decimal digits wide. A UID above 999999, common on cloud VMs
// with directory-backed accounts, overflows the field, and dpkg rejects the
// result as "corrupt - bad archive header magic". The staging tree Tauri
// assembles beside that file is sound, so this script packages the same tree
// with dpkg-deb, owned by root as an installed package should be.
//
//   pnpm tauri build --bundles deb   # staging tree, plus Tauri's own .deb
//   pnpm repack:deb                  # <package>_<version>_<arch>.deb beside it
//   sudo dpkg -i target/release/bundle/deb/<package>_<version>_<arch>.deb
//
// The script refuses a staging tree it cannot vouch for: one whose files
// disagree with its own md5sums manifest, or one older than the release binary
// (a `cargo build --release` since the bundle was made). Where Tauri's own .deb
// is valid, both packages carry the same files.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "target", "release");
const BUNDLE_DIR = path.join(RELEASE, "bundle", "deb");

// Tauri rewrites the release binary a moment after staging its bundle copy, so
// the binary is always slightly newer. A gap beyond this means a later build.
const STALE_TOLERANCE_MS = 60_000;

const rel = (p) => path.relative(ROOT, p);
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

function dpkg(tool, args, options = {}) {
  try {
    return execFileSync(tool, args, { encoding: "utf8", ...options });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${tool} not found; Debian packages can only be built on a dpkg-based Linux host`);
    }
    throw error;
  }
}

/** Top-level `Field: value` pairs of a Debian control file. */
function parseControl(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

/** Every entry below `dir`, with POSIX paths relative to it. */
function walk(dir, prefix = "") {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relPath = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(abs);
    entries.push({ abs, rel: relPath, stat });
    if (stat.isDirectory()) entries.push(...walk(abs, relPath));
  }
  return entries;
}

function locateStage() {
  const { productName } = readJson("src-tauri/tauri.conf.json");
  const { version } = readJson("package.json");
  const arch = dpkg("dpkg", ["--print-architecture"]).trim();
  const stage = path.join(BUNDLE_DIR, `${productName}_${version}_${arch}`);
  for (const required of ["control/control", "control/md5sums", "data"]) {
    if (!fs.existsSync(path.join(stage, required))) {
      throw new Error(`${rel(path.join(stage, required))} is missing; run \`pnpm tauri build --bundles deb\` first`);
    }
  }
  return stage;
}

function verifyManifest(stage) {
  const manifest = new Map();
  for (const line of fs.readFileSync(path.join(stage, "control", "md5sums"), "utf8").split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{32}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`malformed md5sums line: ${JSON.stringify(line)}`);
    manifest.set(match[2], match[1]);
  }

  const problems = [];
  const files = walk(path.join(stage, "data")).filter((entry) => entry.stat.isFile());
  for (const { abs, rel: file } of files) {
    const expected = manifest.get(file);
    if (!expected) {
      problems.push(`${file} is not in md5sums`);
      continue;
    }
    manifest.delete(file);
    const actual = crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex");
    if (actual !== expected) problems.push(`${file} does not match its md5sums entry`);
  }
  for (const file of manifest.keys()) problems.push(`${file} is in md5sums but not staged`);
  if (problems.length) {
    throw new Error(`staging tree is inconsistent; rebuild it with \`pnpm tauri build --bundles deb\`:\n  ${problems.join("\n  ")}`);
  }
}

function verifyFresh(stage) {
  const stagedBin = path.join(stage, "data", "usr", "bin");
  if (!fs.existsSync(stagedBin)) return;
  for (const name of fs.readdirSync(stagedBin)) {
    const built = path.join(RELEASE, name);
    if (!fs.existsSync(built)) continue;
    const gap = fs.statSync(built).mtimeMs - fs.statSync(path.join(stagedBin, name)).mtimeMs;
    if (gap > STALE_TOLERANCE_MS) {
      throw new Error(`${rel(built)} is newer than its staged copy; rebuild the bundle with \`pnpm tauri build --bundles deb\``);
    }
  }
}

/** Directories and executables 0755, everything else 0644, whatever the umask was. */
function normalizeModes(root) {
  fs.chmodSync(root, 0o755);
  for (const { abs, stat } of walk(root)) {
    if (stat.isDirectory()) fs.chmodSync(abs, 0o755);
    else if (stat.isFile()) fs.chmodSync(abs, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}

function main() {
  const stage = locateStage();
  verifyManifest(stage);
  verifyFresh(stage);

  const control = parseControl(fs.readFileSync(path.join(stage, "control", "control"), "utf8"));
  const out = path.join(BUNDLE_DIR, `${control.Package}_${control.Version}_${control.Architecture}.deb`);
  // Built beside the destination and renamed into place, so a failure never
  // leaves a truncated package where a good one was.
  const partial = path.join(BUNDLE_DIR, `.${path.basename(out)}.partial`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "okf-repack-deb-"));
  try {
    const root = path.join(work, "root");
    fs.cpSync(path.join(stage, "data"), root, { recursive: true });
    fs.cpSync(path.join(stage, "control"), path.join(root, "DEBIAN"), { recursive: true });
    normalizeModes(root);

    dpkg("dpkg-deb", ["--root-owner-group", "--build", root, partial], { stdio: ["ignore", "ignore", "inherit"] });
    const built = parseControl(dpkg("dpkg-deb", ["--field", partial]));
    for (const field of ["Package", "Version", "Architecture"]) {
      if (built[field] !== control[field]) {
        throw new Error(`built package has ${field} ${built[field]}, staged control says ${control[field]}`);
      }
    }
    fs.renameSync(partial, out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }

  console.log(`Wrote ${rel(out)} (${control.Package} ${control.Version}, ${control.Architecture})`);
  const tauriDeb = `${stage}.deb`;
  if (fs.existsSync(tauriDeb)) {
    let tauriValid = true;
    try {
      dpkg("dpkg-deb", ["--info", tauriDeb], { stdio: "ignore" });
    } catch {
      tauriValid = false;
    }
    if (!tauriValid) console.log(`${rel(tauriDeb)} is unreadable by dpkg; install the package above instead.`);
  }
  console.log(`Install with: sudo dpkg -i '${rel(out)}'`);
}

try {
  main();
} catch (error) {
  console.error(`repack-deb: ${error.message}`);
  process.exitCode = 1;
}
