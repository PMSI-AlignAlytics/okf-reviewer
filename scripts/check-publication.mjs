// Scan the Git index, including newly staged files, without reading ignored
// local configuration or printing potentially private matching values.
import { execFileSync } from "node:child_process";

function git(args) {
  try {
    return execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    // Child-process errors can contain stdout with file contents. Keep those
    // values out of logs when the index is unavailable or access is denied.
    console.error("Unable to read the Git index for the publication check");
    process.exit(2);
  }
}
const entries = git(["ls-files", "--stage", "-z"]).toString("utf8").split("\0").filter(Boolean).map((entry) => {
  const separator = entry.indexOf("\t");
  return { mode: entry.slice(0, separator).split(" ")[0], file: entry.slice(separator + 1) };
});
const privateFile = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials\.json|id_(?:rsa|ed25519)(?:\..*)?)$/u;
const localConfig = /(?:^|\/)(?:\.cursor\/mcp\.json|\.claude\/settings(?:\.local)?\.json|\.aws\/)/u;
const localArtifact = /(?:^|\/)(?:node_modules|\.pnpm-store|dist|target|coverage)(?:\/|$)/u;
const example = /\.env(?:\.[^/]+)?\.(?:example|template)$/u;
const personalPath = /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!runneradmin\b|RUNNER~1\b)[^\\/\s<>"']+[\\/]|\/(?:home|Users)\/[A-Za-z0-9_.-]+\/)/iu;
const failures = [];
for (const { file, mode } of entries) {
  if (localArtifact.test(file)) {
    failures.push(`${file}: local dependency or build artifact is tracked`);
    continue;
  }
  if (localConfig.test(file) || (privateFile.test(file) && !example.test(file))) {
    failures.push(`${file}: private local file is tracked`);
    continue;
  }
  // Use the indexed contents so a staged deletion or a dirty local editor
  // file cannot change what the publication check actually approves.
  const bytes = git(["show", `:${file}`]);
  if (mode === "120000" && /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(bytes.toString("utf8"))) {
    failures.push(`${file}: absolute symbolic link`);
    continue;
  }
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (personalPath.test(lines[i])) failures.push(`${file}:${i + 1}: personal filesystem path`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Publication checks passed for ${entries.length} indexed files`);
}
