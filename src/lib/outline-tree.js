export function addOutlineDisplayNumbers(items) {
  const counters = [0, 0, 0, 0];
  return items.map((item) => {
    const level = outlineLevel(item);
    const title = String(item.title || "").trim();
    if ((item.type || "section") !== "section") return { ...item, level, displayTitle: title };

    counters[level - 1] += 1;
    for (let index = level; index < counters.length; index += 1) counters[index] = 0;
    for (let index = 0; index < level - 1; index += 1) {
      if (!counters[index]) counters[index] = 1;
    }

    const number = counters.slice(0, level).join(".");
    const displayTitle = hasOutlineNumber(title) ? title : `${number} ${title}`;
    return { ...item, level, number, displayTitle };
  });
}

export function buildOutlineTree(items) {
  const roots = [];
  const stack = [];

  items.forEach((item, index) => {
    const level = outlineLevel(item);
    const node = {
      ...item,
      level,
      treeKey: item.id || `${item.page || 0}-${level}-${item.title || index}`,
      children: []
    };
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  });

  return roots;
}

function outlineLevel(item) {
  return Math.max(1, Math.min(4, Number(item?.level || 1)));
}

function hasOutlineNumber(title) {
  return /^\s*(?:\d+(?:\.\d+){0,3}|[A-Z]|[IVXLCDM]+)\.?\s+\S/i.test(title);
}
