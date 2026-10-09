import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createManifest } from "./release-assets.mjs";
import { checkPublishedRelease, readReleaseContext, validatePublishedFiles, validatePublishedMetadata } from "./check-published-release.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/updater");
const payload = fs.readFileSync(path.join(fixture, "payload.txt"));
const signature = fs.readFileSync(path.join(fixture, "payload.txt.sig"));
const publicKey = fs.readFileSync(path.join(fixture, "public.key.pub"), "utf8").trim();
const releaseContext = { tag: "v1.2.3", sha: "a".repeat(40), repository: "PMSI-AlignAlytics/okf-reviewer", version: "1.2.3", publicKey, notes: "Release notes" };

function publishedFixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "okf-published-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const extension of ["deb", "AppImage", "msi", "exe"]) {
    fs.writeFileSync(path.join(directory, `app.${extension}`), payload);
    fs.writeFileSync(path.join(directory, `app.${extension}.sig`), signature);
  }
  const feed = createManifest(directory, releaseContext.tag, releaseContext.repository, releaseContext.version, publicKey, releaseContext.notes, new Date("2026-10-09T00:00:00Z"));
  fs.writeFileSync(path.join(directory, "latest.json"), `${JSON.stringify(feed)}\n`);
  const release = {
    draft: false, tag_name: releaseContext.tag, target_commitish: releaseContext.sha,
    prerelease: false, body: `${releaseContext.notes}\n`,
    assets: fs.readdirSync(directory).map((name) => {
      const bytes = fs.readFileSync(path.join(directory, name));
      return {
        name, state: "uploaded", size: bytes.length,
        digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        browser_download_url: `https://github.com/${releaseContext.repository}/releases/download/${releaseContext.tag}/${name}`,
      };
    }),
  };
  return { directory, release, feed };
}

function updateDigest(release, directory, name) {
  const bytes = fs.readFileSync(path.join(directory, name));
  const asset = release.assets.find((entry) => entry.name === name);
  asset.size = bytes.length;
  asset.digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

test("reads version, key, and notes from the pinned application source", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "okf-release-source-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "src-tauri"));
  fs.mkdirSync(path.join(directory, "docs"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
  fs.writeFileSync(path.join(directory, "src-tauri/tauri.conf.json"), JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { requireSignedVersion: true, pubkey: publicKey } } }));
  fs.writeFileSync(path.join(directory, "docs/log.md"), "* **Release**: 9.9.9. Future notes\n* **Release**: 1.2.3. Release notes\n");
  assert.deepEqual(readReleaseContext(directory, "v1.2.3", releaseContext.sha, releaseContext.repository), releaseContext);
  assert.throws(() => readReleaseContext(directory, "v9.9.9", releaseContext.sha, releaseContext.repository), /source version/u);
  assert.throws(() => readReleaseContext(directory, "v1.2.3", "main", releaseContext.repository), /pinned release commit/u);
});

test("verifies all published signatures and the feed without changing downloaded files", (context) => {
  const { directory, release } = publishedFixture(context);
  const original = fs.readdirSync(directory).map((name) => fs.readFileSync(path.join(directory, name)));
  validatePublishedFiles(release, directory, releaseContext);
  assert.deepEqual(fs.readdirSync(directory).map((name) => fs.readFileSync(path.join(directory, name))), original);
});

test("rejects incomplete, conflicting, unsafe, or unready published metadata", (context) => {
  const { release } = publishedFixture(context);
  for (const change of [
    (copy) => { copy.target_commitish = "b".repeat(40); },
    (copy) => { copy.tag_name = "v9.9.9"; },
    (copy) => { copy.prerelease = true; },
    (copy) => { copy.body = "Other notes"; },
    (copy) => { copy.assets.pop(); },
    (copy) => { copy.assets[0].name = copy.assets[1].name; },
    (copy) => { copy.assets[0].name = "../app.deb"; },
    (copy) => { copy.assets[0].state = "starter"; },
    (copy) => { copy.assets[0].browser_download_url = "https://example.com/app.deb"; },
    (copy) => { copy.assets[0].digest = null; },
  ]) {
    const copy = structuredClone(release);
    change(copy);
    assert.throws(() => validatePublishedMetadata(copy, releaseContext));
  }
});

test("rejects altered downloads even when replacement digests match", (context) => {
  const { directory, release } = publishedFixture(context);
  fs.writeFileSync(path.join(directory, "app.deb"), "modified");
  assert.throws(() => validatePublishedFiles(release, directory, releaseContext), /size mismatch/u);
  updateDigest(release, directory, "app.deb");
  assert.throws(() => validatePublishedFiles(release, directory, releaseContext), /Invalid artifact signature/u);
});

test("rejects a feed with a different version, notes, URL, signature, or missing installer", (context) => {
  const { directory, release, feed } = publishedFixture(context);
  for (const change of [
    (copy) => { copy.version = "9.9.9"; },
    (copy) => { copy.notes = "Other notes"; },
    (copy) => { copy.platforms["windows-x86_64-msi"].url = "https://example.com/app.msi"; },
    (copy) => { copy.platforms["windows-x86_64-msi"].signature = "different"; },
    (copy) => { delete copy.platforms["windows-x86_64-nsis"]; },
  ]) {
    const copy = structuredClone(feed);
    change(copy);
    fs.writeFileSync(path.join(directory, "latest.json"), JSON.stringify(copy));
    updateDigest(release, directory, "latest.json");
    assert.throws(() => validatePublishedFiles(release, directory, releaseContext), /Published update feed/u);
  }
});

test("missing releases and drafts continue building; API failures fail closed", async () => {
  assert.equal(await checkPublishedRelease(releaseContext, { request: async () => new Response(null, { status: 404 }) }), false);
  assert.equal(await checkPublishedRelease(releaseContext, { request: async () => Response.json({ draft: true }) }), false);
  for (const status of [401, 403, 500]) {
    await assert.rejects(checkPublishedRelease(releaseContext, { request: async () => new Response(null, { status }) }), /Unable to inspect release/u);
  }
});

test("checks public download access and keeps the API token out of download requests", async (context) => {
  const { directory, release } = publishedFixture(context);
  const downloads = [];
  const request = async (url, options) => {
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return Response.json(release);
    }
    assert.equal(options.headers, undefined);
    const asset = release.assets.find((entry) => entry.browser_download_url === url);
    assert.ok(asset);
    downloads.push(asset.name);
    return new Response(fs.readFileSync(path.join(directory, asset.name)));
  };
  assert.equal(await checkPublishedRelease(releaseContext, { token: "test-token", request }), true);
  assert.equal(downloads.length, 9);
  await assert.rejects(checkPublishedRelease(releaseContext, {
    request: async (url) => url.startsWith("https://api.github.com/") ? Response.json(release) : new Response(null, { status: 404 }),
  }), /Unable to download published asset/u);
});
