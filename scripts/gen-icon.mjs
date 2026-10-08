// Regenerate platform and in-app icons from the approved transparent PNG.
// Run: node scripts/gen-icon.mjs
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const icons = join(root, "src-tauri/icons");
const result = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "icon",
    join(root, "src-tauri/app-icon.png"),
    "--output",
    icons,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// A 256px asset stays crisp at the existing titlebar and empty-state sizes.
copyFileSync(join(icons, "128x128@2x.png"), join(root, "src/assets/icon.png"));
console.log("Updated platform icons and src/assets/icon.png");
