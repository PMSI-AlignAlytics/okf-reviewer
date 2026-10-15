#!/usr/bin/env node
// Tauri package agreement gate.
//
// `tauri build` refuses to run when an `@tauri-apps/*` npm package and its Rust
// crate differ in major or minor version. CI never runs a full release build,
// so a Rust-only plugin update can pass every check and still fail the release.
// This gate applies the same rule to the installed packages and Cargo.lock.
//
//   node scripts/check-tauri-versions.mjs
//
// `@tauri-apps/api` pairs with the `tauri` crate and `@tauri-apps/plugin-<x>`
// with `tauri-plugin-<x>`. Plugins used only from Rust have no npm package and
// are not compared. A declared npm package without its crate is an error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The Rust crate an `@tauri-apps/*` npm package pairs with, if any. */
export function crateFor(packageName) {
  if (packageName === "@tauri-apps/api") return "tauri";
  const plugin = /^@tauri-apps\/plugin-(.+)$/u.exec(packageName);
  return plugin ? `tauri-plugin-${plugin[1]}` : null;
}

function majorMinor(version) {
  const match = /^(\d+)\.(\d+)\./u.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Problems for npm packages whose crate is missing or on another major/minor.
 * `packages` maps npm names to installed versions; `crates` maps crate names
 * to locked versions.
 */
export function tauriVersionProblems(packages, crates) {
  const problems = [];
  for (const [name, version] of Object.entries(packages)) {
    const crate = crateFor(name);
    if (!crate) continue;
    const locked = crates[crate];
    if (!locked) {
      problems.push(`${name} ${version} has no locked ${crate} crate`);
    } else if (majorMinor(version) === null || majorMinor(version) !== majorMinor(locked)) {
      problems.push(`${name} ${version} does not match ${crate} ${locked} (major.minor)`);
    }
  }
  return problems;
}

/** Locked crate versions from Cargo.lock's [[package]] entries. */
export function lockedCrates(cargoLock) {
  const crates = {};
  for (const block of cargoLock.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    if (name && version) crates[name] = version;
  }
  return crates;
}

function installedTauriPackages() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => crateFor(name) !== null);
  return Object.fromEntries(declared.map((name) => {
    const installed = path.join(ROOT, "node_modules", ...name.split("/"), "package.json");
    return [name, JSON.parse(fs.readFileSync(installed, "utf8")).version];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = installedTauriPackages();
  const problems = tauriVersionProblems(
    packages,
    lockedCrates(fs.readFileSync(path.join(ROOT, "Cargo.lock"), "utf8")),
  );
  if (problems.length > 0) {
    console.error("Tauri npm packages and Rust crates disagree; `tauri build` will refuse to run:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`${Object.keys(packages).length} Tauri npm packages match their Rust crates.`);
}
