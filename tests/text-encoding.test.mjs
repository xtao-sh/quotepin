import assert from "node:assert/strict";
import { analyseTextEncoding, isUnmappableText, unmappableRatio } from "../src/lib/text-encoding.js";

// The real case: a Beamer deck whose Heiti subset carries no ToUnicode map. The slide reads
// 营销分析 and the text layer reports four glyph indices from four unrelated scripts.
assert.equal(isUnmappableText("œୗܽؽ"), true);
assert.equal(isUnmappableText("၄Ɠ₉"), true);
assert.equal(isUnmappableText("ĘʄǁęƓ ԅƓԻ"), true);
assert.equal(isUnmappableText("ƓŭǉĂƓʿ"), true);

// The same page's Songti runs have a ToUnicode map and come out intact. Flagging these would send
// the app off to OCR text it already has.
assert.equal(isUnmappableText("课程介绍"), false);
assert.equal(isUnmappableText("一份估计结果"), false);
assert.equal(isUnmappableText("2026–2027 学年第一学期"), false);
assert.equal(isUnmappableText("统计学基础　第二版"), false);

// Ordinary English, including the punctuation and symbols technical writing mixes in.
assert.equal(isUnmappableText("The addressable market has expanded steadily."), false);
assert.equal(isUnmappableText("β = −153.29, p < 0.005 → reject H₀"), false);
assert.equal(isUnmappableText("R² = 0.0020 · 95% CI [−259.98, −46.59]"), false);
assert.equal(isUnmappableText("naïve café résumé Łódź"), false, "欧洲文字的变音符号不该被当成乱码");
assert.equal(isUnmappableText("Ω(n log n) ≤ ∑ᵢ xᵢ"), false);

// Text genuinely written in one non-Latin script is coherent, whatever script it is. Only glyph
// indices spray across several at once.
assert.equal(isUnmappableText("مرحبا بالعالم هذا نص عربي"), false, "整段阿拉伯文是真文本，不是乱码");
assert.equal(isUnmappableText("שלום עולם זהו טקסט"), false);
assert.equal(isUnmappableText("Привет мир"), false);
assert.equal(isUnmappableText("Γειά σου κόσμε"), false);

// Too little to judge.
assert.equal(isUnmappableText(""), false);
assert.equal(isUnmappableText("œ"), false);
assert.equal(isUnmappableText(null), false);
assert.equal(isUnmappableText("  "), false);

// A foreign script wedged in beside Chinese is the other shape the failure takes: part of a run
// mapped and part did not.
assert.equal(isUnmappableText("营销ܽؽ分析"), true);

// A mostly-readable line with one stray symbol is not a broken font.
assert.equal(isUnmappableText("课程介绍 · 营销分析 2026 秋 ܽ"), false);

// The breakdown is reported so a caller can judge a whole page rather than one selection.
{
  const report = analyseTextEncoding("œୗܽؽ");
  assert.equal(report.counted, 4);
  assert.equal(report.foreign, 3);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.foreignScripts, 3, "奥里亚、叙利亚、阿拉伯三种互不相干的文字");
  assert.equal(report.expectedLetters, 0);
}
{
  const report = analyseTextEncoding("课程介绍");
  assert.equal(report.expected, 4);
  assert.equal(report.foreign, 0);
  assert.equal(report.expectedLetters, 4);
}
// Arabic really written as Arabic stays in one script, which is what keeps it out of the net.
assert.equal(analyseTextEncoding("مرحبا بالعالم").foreignScripts, 1);

assert.equal(unmappableRatio("œୗܽؽ"), 1);
assert.equal(unmappableRatio("课程介绍"), 0);
assert.equal(unmappableRatio(""), 0);
assert.ok(unmappableRatio("课程介绍œୗܽؽ") > 0.4 && unmappableRatio("课程介绍œୗܽؽ") < 0.6);

console.log("text-encoding.test.mjs passed");
