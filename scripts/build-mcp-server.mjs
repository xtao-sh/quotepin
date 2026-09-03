import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "dist-mcp");
const outputFile = path.join(outputDir, "review-annotation-server.mjs");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "mcp", "review-annotation-server.mjs")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" }
});

fs.chmodSync(outputFile, 0o755);
console.log(`MCP server bundle created: ${path.relative(root, outputFile)}`);
