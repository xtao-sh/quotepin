export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 0.1;

export function continuousActivePage({
  scrollTop,
  clientHeight,
  scrollHeight,
  firstPage,
  lastPage,
  readingLine,
  candidates = []
}) {
  if (scrollTop <= 2) return firstPage || null;
  if (scrollTop + clientHeight >= scrollHeight - 2) return lastPage || null;
  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate.top - readingLine) < Math.abs(best.top - readingLine) ? candidate : best
  )).page || null;
}

export function rotatedPageSize(width, height, rotation = 0) {
  const normalized = ((Number(rotation) % 360) + 360) % 360;
  return normalized === 90 || normalized === 270
    ? { width: height, height: width }
    : { width, height };
}

export function clientRectToPageRect(rect, canvasRect, pageWidth, pageHeight, rotation = 0) {
  const points = [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.right, rect.bottom],
    [rect.left, rect.bottom]
  ].map(([x, y]) => clientPointToPagePoint(x, y, canvasRect, pageWidth, pageHeight, rotation));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = clampPercent(Math.min(...xs) / pageWidth * 100);
  const top = clampPercent(Math.min(...ys) / pageHeight * 100);
  const right = clampPercent(Math.max(...xs) / pageWidth * 100);
  const bottom = clampPercent(Math.max(...ys) / pageHeight * 100);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

function clientPointToPagePoint(x, y, canvasRect, pageWidth, pageHeight, rotation) {
  const normalized = ((Number(rotation) % 360) + 360) % 360;
  const radians = (-normalized * Math.PI) / 180;
  const dx = x - (canvasRect.left + canvasRect.width / 2);
  const dy = y - (canvasRect.top + canvasRect.height / 2);
  return {
    x: dx * Math.cos(radians) - dy * Math.sin(radians) + pageWidth / 2,
    y: dx * Math.sin(radians) + dy * Math.cos(radians) + pageHeight / 2
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}
