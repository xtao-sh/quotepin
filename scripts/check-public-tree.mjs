import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file && fs.existsSync(file));
const errors = [];
const forbiddenPaths = [
  /^\.private-reference\//,
  /^app-data\//,
  /^design-reference\//,
  /^release(?:-|\/)/,
  /PDF批注管理系统架构设计\.zip$/,
  /\.(?:p12|pfx|pem|provisionprofile)$/i,
  /(?:^|\/)\.env(?:\.|$)/
];
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".toml", ".txt", ".yml", ".yaml"]);
const sensitivePatterns = [
  { label: "absolute macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ }
];

for (const file of trackedFiles) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) errors.push(`${file}: forbidden public path`);
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const { label, pattern } of sensitivePatterns) {
    if (pattern.test(content)) errors.push(`${file}: contains ${label}`);
  }
}

for (const required of ["LICENSE", "NOTICE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"]) {
  if (!trackedFiles.includes(required) && !fs.existsSync(required)) errors.push(`${required}: required release document is missing`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public-tree check passed (${trackedFiles.length} tracked or untracked candidate files).`);
}
