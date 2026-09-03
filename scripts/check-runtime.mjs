import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  executableCheck("PDF renderer", process.env.PDFTOPPM, ["pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"], true),
  executableCheck("PDF metadata", process.env.PDFINFO, ["pdfinfo", "/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo"], true),
  executableCheck("PDF text layer", process.env.PDFTOTEXT, ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"], true),
  executableCheck("OCR", process.env.TESSERACT, ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"], false),
  executableCheck("Office conversion", process.env.SOFFICE, ["soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"], false)
];

const python = resolveExecutable(process.env.PYTHON, [
  path.join(root, ".venv", "bin", "python3"),
  process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, "bin", "python3") : "",
  "python3",
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3"
]);
checks.push(pythonCheck(python));

for (const check of checks) {
  const marker = check.ok ? "OK" : check.required ? "MISSING" : "OPTIONAL";
  console.log(`${marker.padEnd(8)} ${check.name.padEnd(20)} ${check.detail}`);
}

if (checks.some((check) => check.required && !check.ok)) {
  console.error("\nRequired document runtime dependencies are missing. See README.md.");
  process.exitCode = 1;
}

function executableCheck(name, explicit, candidates, required) {
  const resolved = resolveExecutable(explicit, candidates);
  return { name, required, ok: Boolean(resolved), detail: resolved || "not installed" };
}

function pythonCheck(executable) {
  if (!executable) return { name: "Python PDF export", required: true, ok: false, detail: "python3 not installed" };
  try {
    execFileSync(executable, ["-c", "import pypdf, reportlab"], { stdio: "ignore" });
    return { name: "Python PDF export", required: true, ok: true, detail: executable };
  } catch {
    return { name: "Python PDF export", required: true, ok: false, detail: `${executable} lacks pypdf/reportlab` };
  }
}

function resolveExecutable(explicit, candidates) {
  for (const candidate of [explicit, ...candidates]) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const command = process.platform === "win32" ? "where" : "/usr/bin/which";
      const resolved = execFileSync(command, [candidate], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // Continue through the known installation locations.
    }
  }
  return "";
}
