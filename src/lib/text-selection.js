const FOOTNOTE_MARKERS = /^[\s\d\u00b9\u00b2\u00b3\u2070-\u2079*\u2020\u2021\u00a7\u00b6()[\]{}.,:;]+$/u;

export function normalizeSelectedText(value) {
  return String(value || "")
    .replace(/\u00ad/g, "")
    .replace(/([\p{L}]{2,})-[ \t]*\r?\n[ \t]*([\p{Ll}]{2,})/gu, "$1$2")
    .replace(/[ \t]*\r?\n[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function isFootnoteOnlySelection(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 12 && FOOTNOTE_MARKERS.test(text);
}

export function shouldPreferSpanSelection(nativeQuote, spanQuote) {
  const nativeText = normalizeSelectedText(nativeQuote);
  const spanText = normalizeSelectedText(spanQuote);
  return isFootnoteOnlySelection(nativeText) &&
    !isFootnoteOnlySelection(spanText) &&
    spanText.length >= nativeText.length + 2;
}

export function shouldPreferPointerSelection(nativeSelection, pointerSelection) {
  const nativeText = normalizeSelectedText(nativeSelection?.quote);
  const pointerText = normalizeSelectedText(pointerSelection?.quote);
  if (!pointerText) return false;
  if (!nativeText) return true;
  if (shouldPreferSpanSelection(nativeText, pointerText)) return true;
  if (pointerText.length >= 2 && nativeText.length > pointerText.length * 1.6 && nativeText.includes(pointerText)) return true;
  if (nativeText !== pointerText) return false;
  return (pointerSelection?.clientRects?.length || 0) > (nativeSelection?.clientRects?.length || 0);
}

// A PDF text layer is one absolutely positioned span per line with a <br> between them. Range's own
// toString() serialises text nodes and nothing else, so it returns the lines welded together —
// "assumes the" + "current pricing" reads as "assumes thecurrent pricing". Walking the cloned
// contents lets the line breaks survive long enough for normalizeSelectedText to turn them into
// the single spaces they should have been.
export function rangeText(range) {
  if (!range) return "";
  try {
    return nodeText(range.cloneContents());
  } catch {
    return String(range.toString?.() || "");
  }
}

function nodeText(node) {
  let text = "";
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) text += child.textContent || "";
    else if (String(child.nodeName || "").toUpperCase() === "BR") text += "\n";
    else text += nodeText(child);
  }
  return text;
}

// Terminators for both scripts this app sees. The trailing quote/bracket class keeps a closing
// quotation mark attached to the sentence it ends.
const SENTENCE_BREAK = /[.!?。！？；;](?:["'”’」』)\]]*)/g;
const CONTEXT_LIMIT = 110;
const CONTEXT_MINIMUM = 16;
// Sixteen characters is three words of English and a whole clause of Chinese, so a plain character
// count would judge the two scripts by very different standards. Counting a CJK character as two
// puts "市场规模持续扩大。" and "The trend continues." on roughly the same footing.
const WIDE = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function weightedLength(text) {
  let total = 0;
  for (const character of text) total += WIDE.test(character) ? 2 : 1;
  return total;
}

// The index at which the budget runs out, counted from whichever end the caller is keeping.
function weightedCut(text, budget, fromEnd) {
  const characters = [...text];
  let total = 0;
  for (let step = 0; step < characters.length; step += 1) {
    const character = characters[fromEnd ? characters.length - 1 - step : step];
    total += WIDE.test(character) ? 2 : 1;
    if (total > budget) return fromEnd ? characters.length - step : step;
  }
  return fromEnd ? 0 : characters.length;
}
// A quote this long already says what it is about; surrounding text only buries it.
const SELF_SUFFICIENT_QUOTE = 90;

// What the export shows around a quote. The stored anchor deliberately keeps a wide window because
// re-anchoring needs it to disambiguate, but pasting that window into a chat reproduces most of the
// page around a one-sentence remark. Cut it back to the sentence the selection actually sits in.
export function contextForExport({ quote = "", prefix = "", suffix = "" } = {}) {
  const quoteText = normalizeSelectedText(quote);
  if (weightedLength(quoteText) >= SELF_SUFFICIENT_QUOTE) return { prefix: "", suffix: "" };
  return {
    prefix: sentenceBefore(normalizeSelectedText(prefix)),
    suffix: sentenceAfter(normalizeSelectedText(suffix))
  };
}

function sentenceBefore(text) {
  if (!text) return "";
  const breaks = [...text.matchAll(SENTENCE_BREAK)];
  let start = breaks.length ? breaks[breaks.length - 1].index + breaks[breaks.length - 1][0].length : 0;
  // Landing right after a full stop leaves nothing useful, so reach back one more sentence.
  if (weightedLength(text.slice(start)) < CONTEXT_MINIMUM && breaks.length > 1) {
    const earlier = breaks[breaks.length - 2];
    start = earlier.index + earlier[0].length;
  } else if (weightedLength(text.slice(start)) < CONTEXT_MINIMUM && breaks.length === 1) {
    start = 0;
  }
  const kept = text.slice(start).trimStart();
  if (weightedLength(kept) <= CONTEXT_LIMIT) return kept;
  const cut = [...kept].slice(weightedCut(kept, CONTEXT_LIMIT, true)).join("");
  return `…${trimPartialWord(cut, "start")}`;
}

function sentenceAfter(text) {
  if (!text) return "";
  const breaks = [...text.matchAll(SENTENCE_BREAK)];
  let end = breaks.length ? breaks[0].index + breaks[0][0].length : text.length;
  if (weightedLength(text.slice(0, end)) < CONTEXT_MINIMUM && breaks.length > 1) {
    end = breaks[1].index + breaks[1][0].length;
  }
  const kept = text.slice(0, end).trimEnd();
  if (weightedLength(kept) <= CONTEXT_LIMIT) return kept;
  const cut = [...kept].slice(0, weightedCut(kept, CONTEXT_LIMIT, false)).join("");
  return `${trimPartialWord(cut, "end")}…`;
}

// Cutting to a character budget lands mid-word as often as not, and "…ed steadily over" reads as a
// typo rather than as a trim. Scripts that separate words with spaces can simply drop the fragment;
// CJK has no word boundary to find, so it is left alone.
function trimPartialWord(text, side) {
  if (side === "start") {
    const space = text.search(/\s/);
    const rest = space >= 0 ? text.slice(space) : text;
    return (WIDE.test(text[0] || "") ? text : rest).trimStart();
  }
  const space = text.search(/\s\S*$/);
  const rest = space >= 0 ? text.slice(0, space) : text;
  return (WIDE.test(text[text.length - 1] || "") ? text : rest).trimEnd();
}

// Rendering the quote inside its context. The markers make the selection unambiguous, but a reader
// or a model that strips them to rebuild the sentence should get its spacing back, and only scripts
// that write with spaces want one.
export function quoteWithContext(quote, { prefix = "", suffix = "" } = {}, open = "【", close = "】") {
  const lead = prefix ? `${prefix}${needsSpace(prefix.slice(-1), quote.slice(0, 1)) ? " " : ""}` : "";
  const tail = suffix ? `${needsSpace(quote.slice(-1), suffix.slice(0, 1)) ? " " : ""}${suffix}` : "";
  return `${lead}${open}${quote}${close}${tail}`;
}

// Punctuation that binds to the word before it, and punctuation that binds to the word after it.
const CLINGS_LEFT = /^[,.;:!?%)\]}"'”’»]/u;
const CLINGS_RIGHT = /[([{"'“‘«]$/u;

function needsSpace(left, right) {
  if (!left || !right) return false;
  if (WIDE.test(left) || WIDE.test(right)) return false;
  if (/\s/.test(left) || /\s/.test(right)) return false;
  if (CLINGS_LEFT.test(right) || CLINGS_RIGHT.test(left)) return false;
  return true;
}

export function buildTextAnchor(quote, prefix = "", suffix = "") {
  return {
    exact: normalizeSelectedText(quote).slice(0, 100000),
    prefix: normalizeSelectedText(prefix).slice(-240),
    suffix: normalizeSelectedText(suffix).slice(0, 240)
  };
}
