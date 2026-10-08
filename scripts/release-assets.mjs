// Build the static updater feed from complete, verified release assets.
// Only Node built-ins are used: the publishing job runs no package install.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMATS = { deb: ".deb", appimage: ".AppImage", msi: ".msi", nsis: ".exe" };
const TARGETS = { deb: "linux-x86_64-deb", appimage: "linux-x86_64-appimage", msi: "windows-x86_64-msi", nsis: "windows-x86_64-nsis" };

function decode(value) {
  assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/u, "Invalid base64 data");
  return Buffer.from(value, "base64");
}

export function verifyArtifact(bytes, encodedSignature, encodedPublicKey, version) {
  const publicLines = decode(encodedPublicKey.trim()).toString("utf8").trim().split(/\r?\n/u);
  assert.equal(publicLines.length, 2, "Invalid updater public key");
  const publicPacket = decode(publicLines[1]);
  assert.equal(publicPacket.length, 42, "Invalid updater public key length");
  assert.equal(publicPacket.subarray(0, 2).toString(), "Ed", "Invalid public key algorithm");
  const lines = decode(encodedSignature.trim()).toString("utf8").trim().split(/\r?\n/u);
  assert.equal(lines.length, 4, "Invalid updater signature");
  assert.match(lines[2], /^trusted comment: /u, "Missing signed comment");
  const packet = decode(lines[1]);
  assert.equal(packet.length, 74, "Invalid signature length");
  assert.equal(packet.subarray(0, 2).toString(), "ED", "An updater signature must use prehashing");
  assert.deepEqual(packet.subarray(2, 10), publicPacket.subarray(2, 10), "The signing key does not match the app public key");
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicPacket.subarray(10)]),
    format: "der", type: "spki",
  });
  const signature = packet.subarray(10);
  const hash = crypto.createHash("blake2b512").update(bytes).digest();
  assert.ok(crypto.verify(null, hash, key, signature), "Invalid artifact signature");
  const comment = lines[2].slice("trusted comment: ".length);
  assert.ok(crypto.verify(null, Buffer.concat([signature, Buffer.from(comment)]), key, decode(lines[3])), "Invalid signed version comment");
  const signedVersions = comment.split("\t").filter((part) => part.startsWith("version:")).map((part) => part.slice(8));
  assert.deepEqual(signedVersions, [version], "The signature must bind the artifact to the release version");
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

export function collectAssets(source, destination, formats, version, publicKey) {
  const files = filesUnder(source);
  fs.mkdirSync(destination, { recursive: true });
  for (const format of formats) {
    assert.ok(Object.hasOwn(FORMATS, format), `Unknown package format: ${format}`);
    const candidates = files.filter((file) => file.endsWith(FORMATS[format]));
    assert.equal(candidates.length, 1, `Expected exactly one ${format} package`);
    const file = candidates[0];
    const signature = fs.readFileSync(`${file}.sig`, "utf8").trim();
    const bytes = fs.readFileSync(file);
    verifyArtifact(bytes, signature, publicKey, version);
    // Publish known safe asset names, including for products containing spaces.
    const name = path.basename(file).replace(/[^A-Za-z0-9._-]/gu, "_");
    assert.ok(!fs.existsSync(path.join(destination, name)), `Duplicate package: ${name}`);
    fs.writeFileSync(path.join(destination, name), bytes);
    fs.writeFileSync(path.join(destination, `${name}.sig`), `${signature}\n`);
  }
}

export function createManifest(directory, tag, repository, version, publicKey, notes, date = new Date()) {
  assert.equal(tag, `v${version}`, "The release tag must match the app version");
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Invalid release tag");
  assert.equal(repository, "PMSI-AlignAlytics/okf-reviewer", "Unexpected release repository");
  const files = filesUnder(directory);
  const platforms = {};
  for (const [format, extension] of Object.entries(FORMATS)) {
    const candidates = files.filter((file) => file.endsWith(extension));
    assert.equal(candidates.length, 1, `Expected exactly one ${format} package`);
    const file = candidates[0];
    const name = path.basename(file);
    assert.match(name, /^[A-Za-z0-9._-]+$/u, "Unsafe release asset name");
    const signature = fs.readFileSync(`${file}.sig`, "utf8").trim();
    verifyArtifact(fs.readFileSync(file), signature, publicKey, version);
    platforms[TARGETS[format]] = {
      signature, url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    };
  }
  return { version, notes, pub_date: date.toISOString(), platforms };
}

function main() {
  const [command, source, ...args] = process.argv.slice(2);
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  const publicKey = config.plugins.updater.pubkey;
  if (command === "collect") {
    const [destination, formats] = args;
    collectAssets(source, destination, formats.split(","), version, publicKey);
  } else if (command === "manifest") {
    const [tag, repository] = args;
    const log = fs.readFileSync(path.join(ROOT, "docs/log.md"), "utf8");
    const entry = log.split("\n").find((line) => line.startsWith(`* **Release**: ${version}.`));
    assert.ok(entry, "Record the release in docs/log.md before publishing");
    const notes = entry.slice(`* **Release**: ${version}. `.length);
    const manifest = createManifest(source, tag, repository, version, publicKey, notes);
    fs.writeFileSync(path.join(source, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(source, "release-notes.md"), `${notes}\n`);
  } else {
    throw new Error("Usage: release-assets.mjs collect <bundle-dir> <asset-dir> <formats> | manifest <asset-dir> <tag> <repository>");
  }
  console.log("Release assets verified successfully.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
