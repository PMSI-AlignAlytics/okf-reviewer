import assert from "node:assert/strict";
import { test } from "node:test";
import { crateFor, lockedCrates, tauriVersionProblems } from "./check-tauri-versions.mjs";

test("pairs the API package with tauri and plugins with their crates", () => {
  assert.equal(crateFor("@tauri-apps/api"), "tauri");
  assert.equal(crateFor("@tauri-apps/plugin-store"), "tauri-plugin-store");
  assert.equal(crateFor("@tauri-apps/cli"), null);
  assert.equal(crateFor("react"), null);
});

test("reads locked crate versions", () => {
  const lock = '[[package]]\nname = "tauri"\nversion = "2.12.1"\nsource = "registry"\n\n[[package]]\nname = "tauri-plugin-store"\nversion = "2.5.0"\n';
  assert.deepEqual(lockedCrates(lock), { tauri: "2.12.1", "tauri-plugin-store": "2.5.0" });
});

test("reports the mismatches that stop a release build", () => {
  const crates = { tauri: "2.12.1", "tauri-plugin-opener": "2.7.0", "tauri-plugin-store": "2.5.0" };
  assert.deepEqual(tauriVersionProblems({
    "@tauri-apps/api": "2.12.3",
    "@tauri-apps/plugin-opener": "2.7.2",
    "@tauri-apps/plugin-store": "2.5.0",
    "@tauri-apps/cli": "2.12.1",
  }, crates), [], "patch differences are allowed");
  assert.deepEqual(tauriVersionProblems({
    "@tauri-apps/plugin-opener": "2.5.4",
    "@tauri-apps/plugin-store": "2.4.3",
    "@tauri-apps/plugin-dialog": "2.8.1",
  }, crates), [
    "@tauri-apps/plugin-opener 2.5.4 does not match tauri-plugin-opener 2.7.0 (major.minor)",
    "@tauri-apps/plugin-store 2.4.3 does not match tauri-plugin-store 2.5.0 (major.minor)",
    "@tauri-apps/plugin-dialog 2.8.1 has no locked tauri-plugin-dialog crate",
  ]);
});
