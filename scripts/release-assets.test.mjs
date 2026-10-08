import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectAssets, createManifest, verifyArtifact } from "./release-assets.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/updater");
const payload = fs.readFileSync(path.join(fixture, "payload.txt"));
const signature = fs.readFileSync(path.join(fixture, "payload.txt.sig"), "utf8").trim();
const publicKey = fs.readFileSync(path.join(fixture, "public.key.pub"), "utf8").trim();

test("verifies an independent Tauri CLI signature and rejects modified bytes, comments, and versions", () => {
  verifyArtifact(payload, signature, publicKey, "1.2.3");
  assert.throws(() => verifyArtifact(Buffer.from("modified"), signature, publicKey, "1.2.3"), /Invalid artifact signature/u);
  assert.throws(() => verifyArtifact(payload, signature, publicKey, "9.9.9"), /release version/u);
  const forged = Buffer.from(signature, "base64").toString().replace("version:1.2.3", "version:9.9.9");
  assert.throws(() => verifyArtifact(payload, Buffer.from(forged).toString("base64"), publicKey, "9.9.9"), /signed version comment/u);
  assert.throws(() => verifyArtifact(payload, "not a signature", publicKey, "1.2.3"));
});

test("collects all installation formats with safe immutable URLs and refuses incomplete publication", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-release-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "assets");
  fs.mkdirSync(source);
  for (const extension of ["deb", "AppImage", "msi", "exe"]) {
    const file = path.join(source, `OKF Reviewer_1.2.3_x64.${extension}`);
    fs.writeFileSync(file, payload);
    fs.writeFileSync(`${file}.sig`, signature);
  }
  collectAssets(source, destination, ["deb", "appimage", "msi", "nsis"], "1.2.3", publicKey);
  const manifest = createManifest(destination, "v1.2.3", "PMSI-AlignAlytics/okf-reviewer", "1.2.3", publicKey, "Release notes");
  assert.deepEqual(Object.keys(manifest.platforms), ["linux-x86_64-deb", "linux-x86_64-appimage", "windows-x86_64-msi", "windows-x86_64-nsis"]);
  for (const platform of Object.values(manifest.platforms)) {
    assert.match(platform.url, /^https:\/\/github\.com\/PMSI-AlignAlytics\/okf-reviewer\/releases\/download\/v1\.2\.3\/OKF_Reviewer/u);
    verifyArtifact(payload, platform.signature, publicKey, manifest.version);
  }
  assert.throws(() => createManifest(destination, "v9.9.9", "PMSI-AlignAlytics/okf-reviewer", "1.2.3", publicKey, ""), /tag must match/u);
  fs.unlinkSync(path.join(destination, "OKF_Reviewer_1.2.3_x64.exe"));
  assert.throws(() => createManifest(destination, "v1.2.3", "PMSI-AlignAlytics/okf-reviewer", "1.2.3", publicKey, ""), /one nsis/u);
});

test("refuses duplicate packages and signatures made for another app release", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-release-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "app.msi"), payload);
  fs.writeFileSync(path.join(source, "app.msi.sig"), signature);
  assert.throws(() => collectAssets(source, path.join(root, "assets"), ["msi"], "9.9.9", publicKey), /release version/u);
  fs.writeFileSync(path.join(source, "another.msi"), payload);
  assert.throws(() => collectAssets(source, path.join(root, "assets"), ["msi"], "1.2.3", publicKey), /one msi/u);
});
