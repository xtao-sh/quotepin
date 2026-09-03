import assert from "node:assert/strict";
import { classifyImportSource, describeImportSourceProblem, splitImportSources } from "../src/lib/import-source.js";

const kindOf = (input) => classifyImportSource(input).kind;
const valueOf = (input) => classifyImportSource(input).value;

// What a browser gives you.
assert.equal(kindOf("https://example.com/report.pdf"), "url");
assert.equal(kindOf("http://example.com/a.pdf"), "url");
assert.equal(kindOf("HTTPS://EXAMPLE.COM/A.PDF"), "url");

// What Finder's ⌥⌘C gives you.
assert.equal(kindOf("/Volumes/Work/Docs/报告.pdf"), "path");
assert.equal(kindOf("/Volumes/Work/Docs/My Report.pdf"), "path");

// What dragging a file into a text field gives you.
assert.equal(kindOf("file:///Volumes/Work/Docs/report.pdf"), "path");
assert.equal(kindOf("file:///Volumes/Work/%E6%8A%A5%E5%91%8A.pdf"), "path");

// Home-relative paths.
assert.equal(kindOf("~/Documents/report.pdf"), "path");
assert.equal(kindOf("~"), "path");
// "~foo" is another user's home in shell terms, not something to guess at.
assert.equal(kindOf("~someone/report.pdf"), "unknown");

// Surrounding quotes come along when copying from a shell prompt.
assert.equal(valueOf('"/Volumes/Work/My Report.pdf"'), "/Volumes/Work/My Report.pdf");
assert.equal(valueOf("'/Volumes/Work/My Report.pdf'"), "/Volumes/Work/My Report.pdf");
assert.equal(kindOf('"/Volumes/Work/My Report.pdf"'), "path");
// A quote inside the path is not a wrapping quote.
assert.equal(valueOf('/Volumes/Work/it"s.pdf'), '/Volumes/Work/it"s.pdf');

// Whitespace around the input never decides the answer.
assert.equal(kindOf("   https://example.com/a.pdf   "), "url");
assert.equal(kindOf("\t/Volumes/Work/a.pdf\n"), "path");

// Schemes the app cannot fetch are refused with a specific message rather than guessed at.
for (const value of ["ftp://example.com/a.pdf", "smb://server/share/a.pdf", "s3://bucket/a.pdf"]) {
  assert.equal(kindOf(value), "unsupported", `${value} 应当被判为不支持`);
}
assert.match(describeImportSourceProblem("unsupported"), /HTTP\/HTTPS/);

// Neither a complete link nor a path.
for (const value of ["example.com/a.pdf", "report.pdf", "Documents/report.pdf", "C:\\Users\\a.pdf"]) {
  assert.equal(kindOf(value), "unknown", `${value} 应当被判为无法识别`);
}
assert.match(describeImportSourceProblem("unknown"), /http:\/\/ 或 https:\/\//);

// Empty input is its own case, so the dialog can say "请输入…" rather than "无法识别".
for (const value of ["", "   ", null, undefined]) {
  assert.equal(kindOf(value), "empty");
}
assert.equal(describeImportSourceProblem("empty"), "");
assert.equal(describeImportSourceProblem("path"), "");

// Several lines behave like a multi-select in the native picker.
assert.deepEqual(
  splitImportSources("/Volumes/Work/a.pdf\n\n  https://example.com/b.pdf  \n/Volumes/Work/c.pdf"),
  ["/Volumes/Work/a.pdf", "https://example.com/b.pdf", "/Volumes/Work/c.pdf"]
);
assert.deepEqual(splitImportSources("单独一行"), ["单独一行"]);
assert.deepEqual(splitImportSources("   \n \n"), []);
assert.deepEqual(splitImportSources(""), []);
assert.deepEqual(splitImportSources(null), []);

console.log("import-source.test.mjs passed");
