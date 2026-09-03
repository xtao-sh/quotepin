import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const licenseOutput = path.join(output, "licenses");

const rootDocuments = [
  ["LICENSE", "LICENSE.txt"],
  ["NOTICE", "NOTICE.txt"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["TRADEMARKS.md", "TRADEMARKS.md"]
];

const packages = [
  "@fontsource/jetbrains-mono",
  "@fontsource/onest",
  "@modelcontextprotocol/sdk",
  "archiver",
  "express",
  "lucide-react",
  "multer",
  "pdfjs-dist",
  "react",
  "react-dom",
  "unzipper",
  "zod"
];

fs.mkdirSync(licenseOutput, { recursive: true });
for (const [sourceName, outputName] of rootDocuments) {
  fs.copyFileSync(path.join(root, sourceName), path.join(output, outputName));
}

for (const packageName of packages) {
  const packageDirectory = path.join(root, "node_modules", ...packageName.split("/"));
  const licensePath = findLicense(packageDirectory);
  if (!licensePath) throw new Error(`No license file found for ${packageName}`);
  const safeName = packageName.replace(/^@/, "").replaceAll("/", "-");
  fs.copyFileSync(licensePath, path.join(licenseOutput, `${safeName}-${path.basename(licensePath)}`));
}

function findLicense(directory) {
  const names = fs.readdirSync(directory);
  const fileName = names.find((name) => /^(licen[sc]e|copying)(\.|$)/i.test(name));
  return fileName ? path.join(directory, fileName) : "";
}
