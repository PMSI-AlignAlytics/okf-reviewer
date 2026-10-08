// The wrapper unit tests mock Mermaid. Exercise the actual locked libraries,
// application renderer, theme and CSP in a disposable offline browser too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const csp = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-render-security-"));
const server = await createServer({
  root, configFile: false, cacheDir, logLevel: "error",
  resolve: { alias: { "@": path.join(root, "src") } },
  optimizeDeps: { noDiscovery: true, include: ["mermaid", "katex"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "isolated-render-security-page",
    configureServer(vite) {
      vite.middlewares.use("/__render_security__", (_request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", csp);
        response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  await page.goto(origin + "/__render_security__");
  const result = await page.evaluate(async () => {
    const { renderMermaidBlocks } = await import("/src/shared/render/mermaid.ts");
    const { renderMathBlocks } = await import("/src/shared/render/math.ts");
    function diagram(source) {
      const container = document.createElement("div");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-mermaid";
      code.textContent = source;
      pre.append(code);
      container.append(pre);
      document.body.append(container);
      return container;
    }
    const property = "rendererPrototypeProbe";
    const before = Object.hasOwn(Object.prototype, property);
    const hostile = diagram("architecture-beta\n group rendererPrototypeProbe(cloud)[Probe]\n service first(server)[First] in __proto__\n service second(server)[Second] in rendererPrototypeProbe\n first:R -- L:second");
    let after;
    try {
      await renderMermaidBlocks(hostile);
      after = Object.hasOwn(Object.prototype, property);
    } finally {
      Reflect.deleteProperty(Object.prototype, property);
    }
    const normal = diagram("flowchart LR\n A[Source] --> B[Reviewed]");
    await renderMermaidBlocks(normal);
    const untrusted = diagram('%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n A[Source] --> B[Reviewed]\n click A "javascript:alert(1)"');
    await renderMermaidBlocks(untrusted);
    const math = document.createElement("div");
    math.innerHTML = '<span class="math math-inline">\\frac{a}{b} + \\href{https://example.invalid}{x} + \\includegraphics{x.png}</span>';
    document.body.append(math);
    await renderMathBlocks(math);
    return {
      before, after,
      normalSvgs: normal.querySelectorAll("figure svg").length,
      unsafeDiagramLinks: untrusted.querySelectorAll('a[href], a[xlink\\:href], [onclick]').length,
      mathRendered: !!math.querySelector(".katex math"),
      unsafeMathElements: math.querySelectorAll("a, img").length,
    };
  });
  assert.equal(result.before, false, "browser must start with a clean prototype");
  assert.equal(result.after, false, "hostile architecture diagram must not pollute Object.prototype");
  assert.equal(result.normalSvgs, 2, "valid diagrams must render both themes");
  assert.equal(result.unsafeDiagramLinks, 0, "authored config must not enable clickable links");
  assert.equal(result.mathRendered, true, "patched KaTeX must typeset normal math");
  assert.equal(result.unsafeMathElements, 0, "untrusted TeX must not create links or fetched images");
  console.log("Renderer security regressions passed with the real libraries and application CSP");
} finally {
  if (browser) await browser.close();
  await server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
