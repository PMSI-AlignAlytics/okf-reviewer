// A repeated release run must verify the published update, never replace it.
// Only Node built-ins are used; no signing secret or package install is needed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest } from "./release-assets.mjs";

export function readReleaseContext(source, tag, sha, repository) {
  assert.match(sha, /^[a-f0-9]{40}$/u, "Expected a pinned release commit");
  assert.equal(repository, "PMSI-AlignAlytics/okf-reviewer", "Unexpected release repository");
  const { version } = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Invalid release tag");
  assert.equal(tag, `v${version}`, "The release tag must match the source version");
  const config = JSON.parse(fs.readFileSync(path.join(source, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  const prefix = `* **Release**: ${version}. `;
  const entry = fs.readFileSync(path.join(source, "docs/log.md"), "utf8").split("\n").find((line) => line.startsWith(prefix));
  assert.ok(entry, "Record the release in docs/log.md before publishing");
  return { tag, sha, repository, version, publicKey: config.plugins.updater.pubkey, notes: entry.slice(prefix.length) };
}

export function validatePublishedMetadata(release, context) {
  assert.equal(release.draft, false, "Expected a published release");
  assert.equal(release.tag_name, context.tag, "Published release tag mismatch");
  assert.equal(release.target_commitish, context.sha, "Published release source mismatch");
  assert.equal(release.prerelease, context.version.includes("-"), "Published release channel mismatch");
  assert.equal(release.body.trim(), context.notes, "Published release notes mismatch");
  assert.equal(release.assets.length, 9, "Expected four installers, four signatures, and latest.json");
  assert.equal(new Set(release.assets.map((asset) => asset.name)).size, 9, "Duplicate published assets");
  assert.ok(release.assets.some((asset) => asset.name === "latest.json"), "Missing published update feed");
  const names = new Set(release.assets.map((asset) => asset.name));
  for (const extension of [".deb", ".AppImage", ".msi", ".exe"]) {
    const packages = [...names].filter((name) => name.endsWith(extension));
    assert.equal(packages.length, 1, `Expected exactly one published ${extension} package`);
    assert.ok(names.has(`${packages[0]}.sig`), "Missing published package signature");
  }
  for (const asset of release.assets) {
    assert.match(asset.name, /^[A-Za-z0-9._-]+$/u, "Unsafe published asset name");
    assert.equal(asset.state, "uploaded", "Published asset is not ready");
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, "Invalid published asset size");
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/u, "Missing published asset digest");
    assert.equal(asset.browser_download_url, `https://github.com/${context.repository}/releases/download/${context.tag}/${asset.name}`, "Unexpected published asset URL");
  }
}

export function validatePublishedFiles(release, directory, context) {
  validatePublishedMetadata(release, context);
  for (const asset of release.assets) {
    const bytes = fs.readFileSync(path.join(directory, asset.name));
    assert.equal(bytes.length, asset.size, `Published asset size mismatch: ${asset.name}`);
    assert.equal(`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`, asset.digest, `Published asset digest mismatch: ${asset.name}`);
  }
  const feed = JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"));
  const expected = createManifest(directory, context.tag, context.repository, context.version, context.publicKey, context.notes, new Date(feed.pub_date));
  assert.deepEqual(feed, expected, "Published update feed does not match the verified installers and source");
}

export async function checkPublishedRelease(context, { token, request = fetch } = {}) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await request(`https://api.github.com/repos/${context.repository}/releases/tags/${context.tag}`, { headers, signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) return false;
  assert.ok(response.ok, `Unable to inspect release: HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft === true) return false;
  validatePublishedMetadata(release, context);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "okf-published-release-"));
  try {
    // Public downloads also prove that the app can retrieve the feed and files.
    // The API token is never sent to release downloads or redirected CDN hosts.
    for (const asset of release.assets) {
      const download = await request(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
      assert.ok(download.ok, `Unable to download published asset ${asset.name}: HTTP ${download.status}`);
      fs.writeFileSync(path.join(directory, asset.name), Buffer.from(await download.arrayBuffer()));
    }
    validatePublishedFiles(release, directory, context);
    console.log(`${context.tag} is already published; all four signed installers and the update feed are valid. Published assets are preserved.`);
    return true;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const [tag, sha, source] = process.argv.slice(2);
  assert.ok(source, "Usage: check-published-release.mjs <tag> <commit> <source-directory>");
  const context = readReleaseContext(source, tag, sha, process.env.GITHUB_REPOSITORY);
  const published = await checkPublishedRelease(context, { token: process.env.GH_TOKEN });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
  if (!published) console.log(`${tag} is not published; continue the signed release build.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
