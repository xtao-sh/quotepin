// A PDF that embeds a subset font with Identity-H encoding and no ToUnicode CMap carries no record
// of which character each glyph stands for. The glyphs draw correctly, so the page looks right, but
// every extractor — pdf.js, Poppler, Acrobat — can only report the raw glyph index, and reading that
// as a Unicode code point produces characters scattered across unrelated scripts: 营销分析 comes back
// as œୗܽؽ (U+0153 Latin Extended-A, U+0B57 Oriya, U+073D Syriac, U+063D Arabic).
//
// Detecting that is not a matter of listing forbidden characters — Arabic is perfectly legitimate in
// an Arabic document. What gives it away is incoherence. Real text is written in one script, or in
// two that go together; glyph indices land wherever they land.

// The scripts these documents are written in, plus the punctuation, symbols and maths that technical
// writing mixes into them. Nothing here is ever evidence of a broken font.
const EXPECTED = [
  [0x0000, 0x00ff], // ASCII and Latin-1
  [0x0300, 0x036f], // combining diacriticals
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x2000, 0x206f], // general punctuation
  [0x2070, 0x209f], // superscripts and subscripts
  [0x20a0, 0x20bf], // currency
  [0x2100, 0x218f], // letterlike and number forms
  [0x2190, 0x22ff], // arrows and mathematical operators
  [0x2300, 0x23ff], // miscellaneous technical
  [0x2460, 0x24ff], // enclosed alphanumerics
  [0x2500, 0x25ff], // box drawing and geometric shapes
  [0x2e80, 0x2eff], // CJK radicals
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // kana
  [0x3100, 0x312f], // bopomofo
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef] // fullwidth and halfwidth forms
];

// Latin Extended and the phonetic blocks. Legitimate in European names and in maths subscripts, and
// also where a large share of misread glyph indices land — so they are counted but never damning on
// their own.
const AMBIGUOUS = [
  [0x0100, 0x02ff], // Latin Extended-A/B, IPA, spacing modifiers
  [0x1d00, 0x1dbf] // phonetic extensions, the source of ᵢ and friends
];

// Everything else worth naming. Two characters from the same script are coherent; two from different
// scripts in one short run are not text.
const SCRIPTS = [
  ["hebrew", 0x0590, 0x05ff],
  ["arabic", 0x0600, 0x06ff],
  ["syriac", 0x0700, 0x074f],
  ["arabic", 0x0750, 0x077f],
  ["thaana", 0x0780, 0x07bf],
  ["nko", 0x07c0, 0x07ff],
  ["samaritan", 0x0800, 0x083f],
  ["devanagari", 0x0900, 0x097f],
  ["bengali", 0x0980, 0x09ff],
  ["gurmukhi", 0x0a00, 0x0a7f],
  ["gujarati", 0x0a80, 0x0aff],
  ["oriya", 0x0b00, 0x0b7f],
  ["tamil", 0x0b80, 0x0bff],
  ["telugu", 0x0c00, 0x0c7f],
  ["kannada", 0x0c80, 0x0cff],
  ["malayalam", 0x0d00, 0x0d7f],
  ["sinhala", 0x0d80, 0x0dff],
  ["thai", 0x0e00, 0x0e7f],
  ["lao", 0x0e80, 0x0eff],
  ["tibetan", 0x0f00, 0x0fff],
  ["myanmar", 0x1000, 0x109f],
  ["georgian", 0x10a0, 0x10ff],
  ["ethiopic", 0x1200, 0x139f],
  ["cherokee", 0x13a0, 0x13ff],
  ["khmer", 0x1780, 0x17ff],
  ["mongolian", 0x1800, 0x18af],
  ["armenian", 0x0530, 0x058f],
  ["cyrillic", 0x0500, 0x052f] // Cyrillic supplement, adjacent to the block above
];

const inRanges = (code, ranges) => ranges.some(([low, high]) => code >= low && code <= high);

function scriptOf(code) {
  for (const [name, low, high] of SCRIPTS) {
    if (code >= low && code <= high) return name;
  }
  return "other";
}

export function analyseTextEncoding(value) {
  const text = String(value || "");
  const scripts = new Set();
  let counted = 0;
  let expected = 0;
  let ambiguous = 0;
  let foreign = 0;
  let asciiLetters = 0;
  let expectedLetters = 0;

  for (const character of text) {
    if (/\s/.test(character)) continue;
    const code = character.codePointAt(0);
    counted += 1;
    if (inRanges(code, EXPECTED)) {
      expected += 1;
      if (/[\p{L}\p{N}]/u.test(character)) expectedLetters += 1;
      if (code < 0x80 && /[a-z]/i.test(character)) asciiLetters += 1;
      continue;
    }
    if (inRanges(code, AMBIGUOUS)) {
      ambiguous += 1;
      continue;
    }
    foreign += 1;
    scripts.add(scriptOf(code));
  }

  return { counted, expected, ambiguous, foreign, expectedLetters, asciiLetters, foreignScripts: scripts.size };
}

// True when the string is glyph indices rather than text.
export function isUnmappableText(value) {
  const report = analyseTextEncoding(value);
  if (report.counted < 2) return false;
  const suspect = report.ambiguous + report.foreign;
  if (!suspect) return false;
  const ratio = suspect / report.counted;

  // Characters from two or more unrelated scripts in one run. Text written in a single foreign
  // script — an Arabic or Hebrew document — never looks like this.
  if (report.foreignScripts >= 2 && ratio >= 0.4) return true;

  // A foreign script sitting inside Chinese or English: part of the run mapped and part did not.
  if (report.foreign > 0 && report.expectedLetters > 0 && ratio >= 0.15) return true;

  // A run of Latin Extended and phonetic characters with no ordinary letter anywhere to anchor it.
  // European words carry ASCII letters alongside their accented ones, and Chinese carries
  // ideographs; a fragment that has neither is not a word in any language. Combining marks and
  // direction controls come along with the garbage, so they do not count as anchors either.
  if (report.ambiguous >= 2 && report.asciiLetters === 0 && report.expectedLetters === 0) return true;

  return false;
}

// How much of a page's text layer is unreadable, so a document can be judged as a whole rather than
// one selection at a time.
export function unmappableRatio(value) {
  const report = analyseTextEncoding(value);
  if (!report.counted) return 0;
  return (report.ambiguous + report.foreign) / report.counted;
}
