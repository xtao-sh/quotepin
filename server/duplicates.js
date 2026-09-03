// Finding the same document imported twice.
//
// The obvious key — a hash of the bytes — turns out to be nearly useless here. These documents are
// LaTeX output, and recompiling writes a fresh creation date into the PDF, so two exports of an
// unchanged deck differ byte for byte. A workspace full of visibly duplicated slides can contain no
// hash collisions at all.
//
// What actually identifies "the same document" is the file it was imported from. Importing the same
// path twice is someone reaching for import when they meant refresh, which is exactly the situation
// that leaves an annotated copy sitting beside an empty one.

// Two documents belong together when they share a source path or share content, and belonging is
// transitive: a file re-exported to the same path links to one neighbour by path and another by
// content, and all three are one document's history.
export function findDuplicateDocuments(documents = [], { annotationCounts = {}, projectNames = {} } = {}) {
  const usable = documents.filter((document) => document && document.id);
  const parent = new Map(usable.map((document) => [document.id, document.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let walk = id;
    while (parent.get(walk) !== walk) {
      const next = parent.get(walk);
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const linkBy = (key) => {
    const seen = new Map();
    for (const document of usable) {
      const value = normalise(document[key]);
      if (!value) continue;
      if (seen.has(value)) union(seen.get(value), document.id);
      else seen.set(value, document.id);
    }
  };
  linkBy("originalPath");
  linkBy("contentHash");

  const grouped = new Map();
  for (const document of usable) {
    const root = find(document.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(document);
  }

  const groups = [];
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const hashes = new Set(members.map((document) => normalise(document.contentHash)).filter(Boolean));
    const paths = new Set(members.map((document) => normalise(document.originalPath)).filter(Boolean));
    const projects = new Set(members.map((document) => document.projectId));
    groups.push({
      // What the caller can tell the user, in descending order of certainty.
      reason: hashes.size === 1 && members.every((document) => normalise(document.contentHash))
        ? "identical"
        : paths.size === 1
          ? "same_source"
          : "related",
      sourcePath: paths.size === 1 ? [...paths][0] : "",
      sameProject: projects.size === 1,
      documents: members
        .map((document) => ({
          id: document.id,
          name: document.name || "",
          projectId: document.projectId || "",
          projectName: projectNames[document.projectId] || "",
          pageCount: Number(document.pageCount || 0),
          contentHash: normalise(document.contentHash),
          originalPath: normalise(document.originalPath),
          updated: Number(document.updated || 0),
          annotationCount: Number(annotationCounts[document.id] || 0)
        }))
        // The annotated copy first, then the most recently touched: whichever one the user keeps,
        // the one they most likely want is already at the top.
        .sort((a, b) => b.annotationCount - a.annotationCount || b.updated - a.updated)
    });
  }

  // Groups holding real work come first, and a stable tie-break keeps the list from reshuffling
  // between requests.
  return groups.sort((a, b) =>
    totalAnnotations(b) - totalAnnotations(a) ||
    b.documents.length - a.documents.length ||
    a.documents[0].name.localeCompare(b.documents[0].name));
}

// How many annotations a group would put at risk if every copy but one were deleted blindly.
export function annotationsAtRisk(group) {
  return group.documents.slice(1).reduce((total, document) => total + document.annotationCount, 0);
}

function totalAnnotations(group) {
  return group.documents.reduce((total, document) => total + document.annotationCount, 0);
}

function normalise(value) {
  return String(value || "").trim();
}
