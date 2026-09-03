// The import dialog takes one field. What a person actually pastes into it varies by where they
// copied it from: a browser gives an https URL, Finder's ⌥⌘C gives a bare POSIX path, dragging a
// file into a text field gives a file:// URL, and dragging into Terminal first gives a path with
// backslash-escaped spaces. Classifying here keeps the dialog and the API agreeing on what is what.

const HTTP_URL = /^https?:\/\//i;
const FILE_URL = /^file:\/\//i;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function classifyImportSource(input) {
  // Copying a path from a shell prompt often brings the surrounding quotes with it.
  const value = String(input ?? "").trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim();
  if (!value) return { kind: "empty", value: "" };
  if (HTTP_URL.test(value)) return { kind: "url", value };
  if (FILE_URL.test(value)) return { kind: "path", value };
  if (value.startsWith("/") || value === "~" || value.startsWith("~/")) return { kind: "path", value };
  if (OTHER_SCHEME.test(value)) return { kind: "unsupported", value };
  return { kind: "unknown", value };
}

// One field, possibly several lines: the native picker already supports multi-select, so pasting a
// list of paths should behave the same way.
export function splitImportSources(input) {
  return String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function describeImportSourceProblem(kind) {
  if (kind === "unsupported") return "只支持 HTTP/HTTPS 链接，或本机文件路径。";
  if (kind === "unknown") return "看起来既不是完整链接，也不是本机文件路径。链接要以 http:// 或 https:// 开头，路径要以 / 或 ~/ 开头。";
  return "";
}
