import assert from "node:assert/strict";
import { buildTextAnchor, contextForExport, normalizeSelectedText, quoteWithContext, rangeText } from "../src/lib/text-selection.js";

// A PDF text layer is one span per line separated by <br>. Enough of a DOM to exercise the walker.
const text = (value) => ({ nodeType: 3, textContent: value });
const element = (nodeName, children) => ({ nodeType: 1, nodeName, childNodes: children });
const fragment = (children) => ({ nodeType: 11, nodeName: "#document-fragment", childNodes: children });
const rangeOver = (node) => ({ cloneContents: () => node });

// Range.toString() serialises text nodes and ignores <br>, which welds the end of one line onto the
// start of the next: "assumes the" + "current pricing" becomes "assumes thecurrent pricing".
{
  const lines = fragment([
    element("SPAN", [text("That projection assumes the")]),
    element("BR", []),
    element("SPAN", [text("current pricing tier holds")])
  ]);
  assert.equal(rangeText(rangeOver(lines)), "That projection assumes the\ncurrent pricing tier holds");
  assert.equal(
    normalizeSelectedText(rangeText(rangeOver(lines))),
    "That projection assumes the current pricing tier holds",
    "换行必须活到 normalizeSelectedText 才能变成词间空格"
  );
}

// Lowercase <br>, nesting, and a range that cannot be cloned.
assert.equal(rangeText(rangeOver(fragment([text("a"), element("br", []), text("b")]))), "a\nb");
assert.equal(rangeText(rangeOver(fragment([element("SPAN", [element("SPAN", [text("deep")])])]))), "deep");
assert.equal(rangeText(null), "");
assert.equal(rangeText({ cloneContents() { throw new Error("detached"); }, toString: () => "fallback" }), "fallback");

// The anchor keeps a wide window on purpose — re-anchoring needs it to tell two similar passages
// apart — so the export is what has to be cut back, not the anchor.
const PAGE_PREFIX = "3.2 Market Outlook The addressable market has expanded steadily over the past six quarters, driven mainly by mid-market adoption rather than enterprise expansion. Penetration will double within two years.";
const PAGE_SUFFIX = "horizon, though the confidence interval widens considerably after the first eighteen months. Regional variation remains significant: the northern markets outperform, while southern coverage is still thin.";

{
  const anchor = buildTextAnchor("That projection assumes the current pricing tier holds.", PAGE_PREFIX, PAGE_SUFFIX);
  assert.ok(anchor.prefix.length > 150, "锚定窗口仍然要宽，重新定位靠它消歧");

  const shown = contextForExport({ quote: "That projection assumes the current pricing tier holds.", prefix: anchor.prefix, suffix: anchor.suffix });
  assert.equal(shown.prefix, "Penetration will double within two years.");
  assert.equal(shown.suffix, "horizon, though the confidence interval widens considerably after the first eighteen months.");
  const line = `${shown.prefix}【quote】${shown.suffix}`;
  assert.ok(line.length < 250, `导出行仍然过长：${line.length} 字符`);
}

// Selecting the opening of a sentence leaves nothing behind it, so the sentence before is worth
// reaching back for rather than showing an empty lead-in.
{
  const shown = contextForExport({
    quote: "Regional variation remains significant.",
    prefix: "Renewal rates improve steadily. The trend continues.",
    suffix: ""
  });
  assert.equal(shown.prefix, "The trend continues.");
}

// Chinese sentences end differently, and the closing quotation mark belongs to the sentence it ends.
{
  const shown = contextForExport({
    quote: "渗透率将在两年内翻倍",
    prefix: "上游供应链已经吸收了大部分冲击。市场规模持续扩大。",
    suffix: "，这将带动上游需求。后续季度仍需观察。"
  });
  assert.equal(shown.prefix, "市场规模持续扩大。");
  assert.equal(shown.suffix, "，这将带动上游需求。");
}
// Ending a selection right before the full stop leaves only the punctuation behind it, so the
// following sentence is reached for — the mirror of what sentenceBefore does at the other end.
{
  const shown = contextForExport({ quote: "见下表", prefix: "他说“这一点已经确认。”", suffix: "。其余不变。" });
  assert.equal(shown.suffix, "。其余不变。");
  // The break regex takes 。” together, so the selection sits at a sentence boundary on both sides
  // and the whole preceding sentence — closing quote included — is what gets shown.
  assert.equal(shown.prefix, "他说“这一点已经确认。”");
}

// A quote that is already a paragraph says what it is about; wrapping it in more page text buries it.
{
  const long = "The addressable market has expanded steadily over the past six quarters, driven mainly by mid-market adoption rather than enterprise expansion.";
  assert.deepEqual(contextForExport({ quote: long, prefix: PAGE_PREFIX, suffix: PAGE_SUFFIX }), { prefix: "", suffix: "" });
}

// A sentence longer than the window is cut, and says so, rather than running to the page edge.
{
  const runOn = `${"word ".repeat(60)}end.`;
  const shown = contextForExport({ quote: "x", prefix: runOn, suffix: runOn });
  assert.ok(shown.prefix.startsWith("…"), "被截断的前文要标出来");
  assert.ok(shown.suffix.endsWith("…"), "被截断的后文要标出来");
  assert.ok(shown.prefix.length <= 111 && shown.suffix.length <= 111);
}

// Nothing to show is a valid answer; the export omits the line entirely.
assert.deepEqual(contextForExport({ quote: "x", prefix: "", suffix: "" }), { prefix: "", suffix: "" });
assert.deepEqual(contextForExport(), { prefix: "", suffix: "" });

// Markers are not separators: a reader that strips 【】 to rebuild the sentence should not be left
// with "expansion.【Penetration】will".
{
  const line = quoteWithContext("Penetration", { prefix: "driven mainly by adoption.", suffix: "will double within two years." });
  assert.equal(line, "driven mainly by adoption. 【Penetration】 will double within two years.");
}
// Chinese does not write with spaces, so inserting them would corrupt the sentence.
{
  const line = quoteWithContext("渗透率", { prefix: "市场规模持续扩大。", suffix: "将在两年内翻倍。" });
  assert.equal(line, "市场规模持续扩大。【渗透率】将在两年内翻倍。");
}
// Punctuation on either side already separates the words.
// A comma binds to the word before it, so none is inserted after 】; a comma before the quote still
// takes the space that normalising the text had stripped.
assert.equal(quoteWithContext("x", { prefix: "ends here,", suffix: ", continues" }), "ends here, 【x】, continues");
assert.equal(quoteWithContext("alone", {}), "【alone】");

// Trimming to a budget must not leave half a word behind.
{
  const runOn = `${"alpha ".repeat(40)}omega end.`;
  const shown = contextForExport({ quote: "x", prefix: runOn, suffix: runOn });
  assert.ok(!/^…\S*[a-z]/.test(shown.prefix) || shown.prefix.startsWith("…alpha"), `前文截断切在词中间：${shown.prefix.slice(0, 20)}`);
  assert.ok(/(\s|…)$/.test(shown.suffix.replace(/…$/, "…")), "后文截断应当止于词边界");
  assert.ok(!shown.suffix.replace(/…$/, "").endsWith("alph"), "后文截断切在词中间");
}

console.log("export-context.test.mjs passed");
