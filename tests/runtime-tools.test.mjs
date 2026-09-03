import assert from "node:assert/strict";
import { RUNTIME_REQUIREMENTS, missingToolMessage, requirementForTool, runtimeReadiness } from "../src/lib/runtime-tools.js";

// A machine with everything installed reports nothing to do.
const complete = runtimeReadiness({ pdf: true, text: true, ocr: true, office: true, outline: true, pdfExport: true });
assert.equal(complete.ready, true);
assert.equal(complete.blocked, false);
assert.deepEqual(complete.missing, []);

// A clean Mac with no Homebrew packages at all is blocked, and every group is listed.
const bare = runtimeReadiness({ pdf: false, text: false, ocr: false, office: false, outline: false, pdfExport: false });
assert.equal(bare.ready, false);
assert.equal(bare.blocked, true);
assert.equal(bare.missing.length, RUNTIME_REQUIREMENTS.length);
assert.equal(bare.missing[0].id, "poppler");
assert.match(bare.missing[0].install, /brew install poppler/);

// Poppler present, everything optional missing: usable, so not blocking.
const popplerOnly = runtimeReadiness({ pdf: true, text: true, ocr: false, office: false, outline: false, pdfExport: false });
assert.equal(popplerOnly.blocked, false);
assert.equal(popplerOnly.ready, false);
assert.deepEqual(popplerOnly.missing.map((group) => group.id), ["tesseract", "libreoffice", "python-pdf"]);

// Half of Poppler counts as missing: pdftotext alone still breaks the text layer.
const halfPoppler = runtimeReadiness({ pdf: true, text: false, ocr: true, office: true, outline: true, pdfExport: true });
assert.equal(halfPoppler.blocked, true);
assert.deepEqual(halfPoppler.missing.map((group) => group.id), ["poppler"]);
assert.deepEqual(halfPoppler.missing[0].missingTools, ["text"]);

// A missing python dependency only shows once even though it backs two flags.
const noPython = runtimeReadiness({ pdf: true, text: true, ocr: true, office: true, outline: false, pdfExport: false });
assert.deepEqual(noPython.missing.map((group) => group.id), ["python-pdf"]);
assert.deepEqual(noPython.missing[0].missingTools, ["outline", "pdfExport"]);

// Absent or malformed payloads are treated as "nothing is available" rather than throwing.
for (const value of [undefined, null, "", 0, []]) {
  const unknown = runtimeReadiness(value);
  assert.equal(unknown.blocked, true, `payload ${JSON.stringify(value)} 应视为不可用`);
}

// The executable the API reports maps back to the package a user installs.
assert.equal(requirementForTool("pdfinfo").id, "poppler");
assert.equal(requirementForTool("pdftoppm").id, "poppler");
assert.equal(requirementForTool("pdftotext").id, "poppler");
assert.equal(requirementForTool("tesseract").id, "tesseract");
assert.equal(requirementForTool("soffice").id, "libreoffice");
assert.equal(requirementForTool("python3").id, "python-pdf");
assert.equal(requirementForTool("nope"), null);
assert.equal(requirementForTool(undefined), null);

// The import-failure message names the package and the command, not a developer string.
const message = missingToolMessage("pdfinfo is not installed", "pdfinfo");
assert.match(message, /Poppler/);
assert.match(message, /brew install poppler/);
assert.doesNotMatch(message, /is not installed/);

// An unmapped tool falls back to whatever the server said rather than inventing advice.
assert.equal(missingToolMessage("服务端说明", "unknown-tool"), "服务端说明");
assert.match(missingToolMessage("", ""), /本机组件/);

console.log("runtime-tools.test.mjs passed");
