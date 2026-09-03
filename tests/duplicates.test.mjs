import assert from "node:assert/strict";
import { annotationsAtRisk, findDuplicateDocuments } from "../server/duplicates.js";

const doc = (id, extra = {}) => ({ id, name: `${id}.pdf`, projectId: "p", pageCount: 10, updated: 1, ...extra });

// The case this was built for, taken from a real workspace: one source file imported twice, the
// second copy differing byte for byte because the deck was recompiled between imports. A hash-based
// check finds nothing here, which is why the source path is the primary key.
{
  const groups = findDuplicateDocuments(
    [
      doc("a", { originalPath: "/Teach/营销分析/课程介绍.pdf", contentHash: "76ec99d6", updated: 300 }),
      doc("b", { originalPath: "/Teach/营销分析/课程介绍.pdf", contentHash: "75493c25", updated: 400 })
    ],
    { annotationCounts: { a: 2 } }
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "same_source");
  assert.equal(groups[0].sourcePath, "/Teach/营销分析/课程介绍.pdf");
  assert.equal(groups[0].sameProject, true);
  // The annotated copy leads, even though the other one is newer.
  assert.deepEqual(groups[0].documents.map((item) => item.id), ["a", "b"]);
  assert.equal(annotationsAtRisk(groups[0]), 0, "只有一份带批注时，删掉其余的不会丢东西");
}

// Byte-identical copies are the strongest signal and are reported as such, even across paths.
{
  const groups = findDuplicateDocuments([
    doc("a", { originalPath: "/one/deck.pdf", contentHash: "same" }),
    doc("b", { originalPath: "/two/deck.pdf", contentHash: "same" })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "identical");
  assert.equal(groups[0].sourcePath, "", "路径不同就没有唯一的来源可报");
}

// Belonging is transitive: b shares a path with a and a hash with c, so all three are one document's
// history rather than two overlapping pairs.
{
  const groups = findDuplicateDocuments([
    doc("a", { originalPath: "/deck.pdf", contentHash: "h1" }),
    doc("b", { originalPath: "/deck.pdf", contentHash: "h2" }),
    doc("c", { originalPath: "/elsewhere/deck.pdf", contentHash: "h2" })
  ]);
  assert.equal(groups.length, 1, "不该拆成两个互相重叠的组");
  assert.deepEqual(groups[0].documents.map((item) => item.id).sort(), ["a", "b", "c"]);
  assert.equal(groups[0].reason, "related");
}

// Same name, genuinely different files: this is the lecture reused by another course, and merging
// the two would be wrong. Nothing links them, so nothing groups them.
{
  const groups = findDuplicateDocuments([
    doc("a", { name: "1.1 导论.pdf", originalPath: "/计量经济学/课件/1.1 导论.pdf", contentHash: "h1" }),
    doc("b", { name: "1.1 导论.pdf", originalPath: "/商务数据分析/课件/1.1 导论.pdf", contentHash: "h2" })
  ]);
  assert.deepEqual(groups, [], "同名不足以判定重复");
}

// A missing path or hash links nothing: two documents that were both dragged in from somewhere the
// app never recorded are not thereby the same document.
{
  const groups = findDuplicateDocuments([doc("a"), doc("b"), doc("c", { originalPath: "", contentHash: "" })]);
  assert.deepEqual(groups, []);
}

// Copies in different projects are still reported — the same lecture in two courses may be
// deliberate — but the caller is told, so it can show which project each one is in.
{
  const groups = findDuplicateDocuments(
    [
      doc("a", { projectId: "p1", originalPath: "/deck.pdf" }),
      doc("b", { projectId: "p2", originalPath: "/deck.pdf" })
    ],
    { projectNames: { p1: "计量", p2: "商务数据分析" } }
  );
  assert.equal(groups[0].sameProject, false);
  assert.deepEqual(groups[0].documents.map((item) => item.projectName).sort(), ["商务数据分析", "计量"].sort());
}

// When more than one copy carries annotations, the caller has to be able to say so before deleting.
{
  const groups = findDuplicateDocuments(
    [
      doc("a", { originalPath: "/deck.pdf" }),
      doc("b", { originalPath: "/deck.pdf" }),
      doc("c", { originalPath: "/deck.pdf" })
    ],
    { annotationCounts: { a: 9, b: 3, c: 1 } }
  );
  assert.deepEqual(groups[0].documents.map((item) => item.id), ["a", "b", "c"], "按批注数排序");
  assert.equal(annotationsAtRisk(groups[0]), 4, "保留第一份时，其余两份共有 4 处批注会丢");
}

// Groups with real work sort ahead of groups without, so the risky decisions surface first.
{
  const groups = findDuplicateDocuments(
    [
      doc("x1", { originalPath: "/quiet.pdf" }),
      doc("x2", { originalPath: "/quiet.pdf" }),
      doc("y1", { originalPath: "/busy.pdf" }),
      doc("y2", { originalPath: "/busy.pdf" })
    ],
    { annotationCounts: { y1: 5 } }
  );
  assert.deepEqual(groups.map((group) => group.sourcePath), ["/busy.pdf", "/quiet.pdf"]);
}

// Nothing to look at.
assert.deepEqual(findDuplicateDocuments([]), []);
assert.deepEqual(findDuplicateDocuments([doc("only", { originalPath: "/deck.pdf" })]), []);
assert.deepEqual(findDuplicateDocuments(), []);
assert.deepEqual(findDuplicateDocuments([null, undefined, {}]), []);

console.log("duplicates.test.mjs passed");
