import React, { useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { rangeText, shouldPreferPointerSelection } from "./lib/text-selection";

GlobalWorkerOptions.workerSrc = workerSource;

const pdfDocuments = new Map();
const MAX_CACHED_PDF_DOCUMENTS = 3;
const MAX_RENDER_PIXELS = 24_000_000;
const MAX_CANVAS_DIMENSION = 16_384;

export function PdfPage({ documentId, version, page, textEnabled, onTextSelection }) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const selectionStartRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [state, setState] = useState("loading");
  const [ocrLayer, setOcrLayer] = useState(null);
  const [ocrState, setOcrState] = useState("idle");
  const sourceUrl = useMemo(
    () => `/api/documents/${encodeURIComponent(documentId)}/source?v=${encodeURIComponent(version || "current")}`,
    [documentId, version]
  );

  useEffect(() => {
    retainPdf(sourceUrl);
    return () => releasePdf(sourceUrl);
  }, [sourceUrl]);

  useEffect(() => {
    setOcrLayer(null);
    setOcrState("idle");
  }, [page, sourceUrl]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let timer = 0;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.max(1, Math.round(entries[0]?.contentRect.width || root.clientWidth));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth((current) => Math.abs(current - nextWidth) > 1 ? nextWidth : current), 60);
    });
    observer.observe(root);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!width) return undefined;
    let cancelled = false;
    let renderTask = null;
    let textTask = null;
    setState("loading");

    loadPdf(sourceUrl)
      .then((pdf) => pdf.getPage(page))
      .then(async (pdfPage) => {
        if (cancelled) return;
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const cssScale = width / baseViewport.width;
        const cssViewport = pdfPage.getViewport({ scale: cssScale });
        const pixelRatio = renderPixelRatio(cssViewport);
        const renderViewport = pdfPage.getViewport({ scale: cssScale * pixelRatio });
        const canvas = canvasRef.current;
        const textContainer = textLayerRef.current;
        if (!canvas || !textContainer || cancelled) return;

        setHeight(cssViewport.height);
        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        const context = canvas.getContext("2d", { alpha: false });
        context.save();
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport: renderViewport });

        textContainer.replaceChildren();
        textContainer.style.setProperty("--total-scale-factor", String(cssScale));
        textContainer.style.setProperty("--scale-round-x", "1px");
        textContainer.style.setProperty("--scale-round-y", "1px");
        textTask = new TextLayer({
          textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
          container: textContainer,
          viewport: cssViewport
        });
        await Promise.all([renderTask.promise, textTask.render()]);
        if (!cancelled) setState("ready");
      })
      .catch((error) => {
        if (!cancelled && error?.name !== "RenderingCancelledException" && error?.name !== "AbortException") setState("error");
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textTask?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    };
  }, [page, sourceUrl, width]);

  useEffect(() => {
    const textContainer = textLayerRef.current;
    if (!textEnabled || state !== "ready" || !textContainer || String(textContainer.textContent || "").trim()) return undefined;
    const controller = new AbortController();
    setOcrState("loading");
    fetch(`/api/documents/${encodeURIComponent(documentId)}/pages/${page}/ocr`, { method: "POST", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || payload.error || "OCR failed");
        return payload.layer;
      })
      .then((layer) => {
        setOcrLayer(layer?.words?.length ? layer : null);
        setOcrState(layer?.words?.length ? "ready" : "empty");
      })
      .catch((error) => {
        if (error.name !== "AbortError") setOcrState("error");
      });
    return () => controller.abort();
  }, [documentId, page, sourceUrl, state, textEnabled]);

  const startTextSelection = (event) => {
    if (!isPrimaryPointer(event)) return;
    const layer = event.currentTarget;
    const point = textPointAt(layer, event.clientX, event.clientY);
    selectionStartRef.current = point ? { layer, point, pointerId: event.pointerId } : null;
  };

  const finishTextSelection = (event) => {
    const layer = event.currentTarget;
    const start = selectionStartRef.current;
    const end = textPointAt(layer, event.clientX, event.clientY);
    selectionStartRef.current = null;
    window.requestAnimationFrame(() => {
      const nativeSelection = selectionFromNativeRange(layer);
      const pointerSelection = start?.layer === layer && end ? selectionFromPoints(layer, start.point, end) : null;
      const selection = shouldPreferPointerSelection(nativeSelection, pointerSelection)
        ? pointerSelection
        : nativeSelection || pointerSelection;
      if (selection) onTextSelection({ layer, ...selection });
    });
  };

  return (
    <div ref={rootRef} className="pdf-page-surface" style={height ? { height: `${height}px` } : undefined}>
      {state === "error" ? (
        <img
          className="native-preview pdf-preview-fallback"
          src={`/api/documents/${encodeURIComponent(documentId)}/pages/${page}/preview`}
          alt={`第 ${page} 页`}
          draggable="false"
        />
      ) : (
        <canvas ref={canvasRef} className="pdf-canvas" aria-label={`第 ${page} 页`} />
      )}
      <div
        ref={textLayerRef}
        className={`pdf-text-layer textLayer ${textEnabled ? "enabled" : ""}`}
        onPointerDown={textEnabled ? startTextSelection : undefined}
        onPointerUp={textEnabled ? finishTextSelection : undefined}
        onPointerCancel={textEnabled ? () => { selectionStartRef.current = null; } : undefined}
      />
      {ocrLayer?.words?.length > 0 && (
        <div
          className={`pdf-ocr-layer text-layer ${textEnabled ? "enabled" : ""}`}
          onPointerDown={textEnabled ? startTextSelection : undefined}
          onPointerUp={textEnabled ? finishTextSelection : undefined}
          onPointerCancel={textEnabled ? () => { selectionStartRef.current = null; } : undefined}
        >
          {ocrLayer.words.map((word, index) => (
            <span
              key={`${index}-${word.x}-${word.y}`}
              style={{ left: `${word.x}%`, top: `${word.y}%`, width: `${word.w}%`, height: `${word.h}%` }}
            >{word.text}</span>
          ))}
        </div>
      )}
      {state === "loading" && <div className="pdf-loading" aria-live="polite">正在渲染页面</div>}
      {ocrState === "loading" && <div className="ocr-loading" aria-live="polite">正在识别扫描页文字</div>}
      {ocrState === "error" && <div className="ocr-loading error" role="status">扫描页文字识别失败，可改用标记或框选</div>}
    </div>
  );
}

function loadPdf(url) {
  if (!pdfDocuments.has(url)) {
    const loadingTask = getDocument({ url, disableAutoFetch: false, enableXfa: true });
    const promise = loadingTask.promise.catch((error) => {
      pdfDocuments.delete(url);
      throw error;
    });
    pdfDocuments.set(url, { loadingTask, promise, refs: 0, lastUsed: Date.now() });
  }
  const entry = pdfDocuments.get(url);
  entry.lastUsed = Date.now();
  return entry.promise;
}

function retainPdf(url) {
  loadPdf(url);
  const entry = pdfDocuments.get(url);
  if (entry) entry.refs += 1;
}

function releasePdf(url) {
  const entry = pdfDocuments.get(url);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = Date.now();
  evictPdfDocuments();
}

function evictPdfDocuments() {
  const candidates = [...pdfDocuments.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (pdfDocuments.size > MAX_CACHED_PDF_DOCUMENTS && candidates.length) {
    const [url, entry] = candidates.shift();
    pdfDocuments.delete(url);
    entry.loadingTask.destroy().catch(() => undefined);
  }
}

function renderPixelRatio(viewport) {
  const desiredRatio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const area = Math.max(1, viewport.width * viewport.height);
  const areaLimit = Math.sqrt(MAX_RENDER_PIXELS / area);
  const dimensionLimit = Math.min(
    MAX_CANVAS_DIMENSION / Math.max(1, viewport.width),
    MAX_CANVAS_DIMENSION / Math.max(1, viewport.height)
  );
  return Math.max(0.25, Math.min(desiredRatio, areaLimit, dimensionLimit));
}

function isPrimaryPointer(event) {
  return event.pointerType !== "mouse" || event.button === 0;
}

function selectionFromNativeRange(layer) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return null;
  return selectionFromRange(layer, range);
}

function selectionFromPoints(layer, start, end) {
  const range = orderedRange(start, end);
  return range?.collapsed ? null : selectionFromRange(layer, range);
}

function selectionFromRange(layer, range) {
  const quote = rangeText(range);
  if (!quote.trim()) return null;
  const clientRects = selectedTextRects(layer, range);
  if (!clientRects.length) return null;
  const prefixRange = range.cloneRange();
  const suffixRange = range.cloneRange();
  try {
    prefixRange.selectNodeContents(layer);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    suffixRange.selectNodeContents(layer);
    suffixRange.setStart(range.endContainer, range.endOffset);
  } catch {
    return { quote, prefix: "", suffix: "", clientRects };
  }
  return { quote, prefix: rangeText(prefixRange), suffix: rangeText(suffixRange), clientRects };
}

function orderedRange(start, end) {
  if (!start?.node || !end?.node) return null;
  const range = document.createRange();
  const [first, last] = pointPrecedes(start, end) ? [start, end] : [end, start];
  try {
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range;
  } catch {
    return null;
  }
}

function pointPrecedes(first, second) {
  if (first.node === second.node) return first.offset <= second.offset;
  return Boolean(first.node.compareDocumentPosition(second.node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function selectedTextRects(layer, range) {
  const rects = [];
  for (const span of textSpans(layer)) {
    let intersects = false;
    try {
      intersects = range.intersectsNode(span);
    } catch {
      intersects = false;
    }
    if (!intersects) continue;
    const node = [...span.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.length);
    if (!node) continue;
    const length = node.textContent.length;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : length;
    if (end <= start) continue;
    const part = document.createRange();
    part.setStart(node, Math.max(0, Math.min(length, start)));
    part.setEnd(node, Math.max(0, Math.min(length, end)));
    const partRects = [...part.getClientRects()].filter(usableRect);
    if (partRects.length) rects.push(...partRects);
    else {
      const fallback = proportionalTextRect(span.getBoundingClientRect(), start, end, length);
      if (usableRect(fallback)) rects.push(fallback);
    }
  }
  if (!rects.length) rects.push(...[...range.getClientRects()].filter(usableRect));
  return dedupeRects(rects);
}

function proportionalTextRect(rect, start, end, length) {
  const safeLength = Math.max(1, length);
  const left = rect.left + rect.width * (start / safeLength);
  const right = rect.left + rect.width * (end / safeLength);
  return { left, right, top: rect.top, bottom: rect.bottom, width: right - left, height: rect.height, x: left, y: rect.top };
}

function usableRect(rect) {
  return Number(rect?.width) > 0.1 && Number(rect?.height) > 0.1;
}

function dedupeRects(rects) {
  const unique = [];
  for (const rect of rects) {
    if (unique.some((item) => Math.abs(item.left - rect.left) < 0.4 && Math.abs(item.top - rect.top) < 0.4 && Math.abs(item.width - rect.width) < 0.4 && Math.abs(item.height - rect.height) < 0.4)) continue;
    unique.push(rect);
  }
  return unique;
}

function textPointAt(layer, x, y) {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret?.offsetNode?.nodeType === Node.TEXT_NODE && layer.contains(caret.offsetNode)) {
    return { node: caret.offsetNode, offset: Math.max(0, Math.min(caret.offsetNode.textContent?.length || 0, caret.offset)) };
  }
  const legacyRange = document.caretRangeFromPoint?.(x, y);
  if (legacyRange?.startContainer?.nodeType === Node.TEXT_NODE && layer.contains(legacyRange.startContainer)) {
    return { node: legacyRange.startContainer, offset: legacyRange.startOffset };
  }
  const span = nearestTextSpan(layer, x, y);
  const node = span ? [...span.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.length) : null;
  if (!node) return null;
  const rect = span.getBoundingClientRect();
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  return { node, offset: Math.round((node.textContent?.length || 0) * ratio) };
}

function textSpans(layer) {
  return [...layer.querySelectorAll("span")].filter((span) => !span.querySelector("span") && [...span.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.length));
}

function nearestTextSpan(layer, x, y) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const span of textSpans(layer)) {
    const rect = span.getBoundingClientRect();
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx * dx + dy * dy * 4;
    if (distance < nearestDistance) {
      nearest = span;
      nearestDistance = distance;
    }
  }
  return nearest;
}
