export function pageLabel(page) {
  return `第 ${page} 页`;
}

export function isPageNumberTitle(value) {
  const title = String(value || "").trim();
  return /^(?:第\s*\d+\s*页\s*)+$/u.test(title);
}

export function normalizePageNumberTitle(value, page) {
  return isPageNumberTitle(value) ? pageLabel(page) : String(value || "").trim();
}
