export const ACCENT = "#5b4ce2";

export const TAGS = {
  todo: { label: "待解决", bg: "#fbeedb", fg: "#b26a0e", dot: "#e0932a" },
  question: { label: "疑问", bg: "#e5eefb", fg: "#245fc0", dot: "#2f7fe5" },
  resolved: { label: "已解决", bg: "#e2f3e9", fg: "#1c8a51", dot: "#25a965" }
};

export const DOCTYPE = {
  pdf: { icon: "picture_as_pdf", fg: "#d1453b", soft: "#fbe9e7" },
  office: { icon: "co_present", fg: "#c0641a", soft: "#fbeee0" },
  image: { icon: "image", fg: "#1c8a51", soft: "#e2f3e9" },
  markdown: { icon: "description", fg: "#5b4ce2", soft: "#ecebfc" },
  html: { icon: "code", fg: "#245fc0", soft: "#e5eefb" },
  file: { icon: "draft", fg: "#5b616c", soft: "#eef0f3" }
};

const now = Date.now();
const min = 60 * 1000;
const hour = 60 * min;
const day = 24 * hour;

export const seedProjects = [
  {
    id: "p1",
    name: "第三季度业务评审",
    path: "~/Reviews/Q3-2026",
    color: "#5b4ce2",
    docIds: ["d1", "d2", "d3", "d4"],
    updated: now - 2 * hour
  },
  {
    id: "p2",
    name: "产品设计走查",
    path: "~/Design/walkthrough",
    color: "#1c8a51",
    docIds: ["d5", "d6"],
    updated: now - day
  },
  {
    id: "p3",
    name: "论文初稿批注",
    path: "~/Papers/draft-v2",
    color: "#c0641a",
    docIds: ["d7"],
    updated: now - 4 * day
  }
];

export const seedDocuments = {
  d1: doc("d1", "p1", "Q3-上半场.pdf", "pdf", 12, [
    "封面",
    "议程",
    "变化一：从对话到执行",
    "本季数据概览",
    "用户增长",
    "留存与流失",
    "变化二：组织提效",
    "成本结构",
    "竞争格局",
    "风险与对策",
    "下季度目标",
    "结语"
  ]),
  d2: doc("d2", "p1", "产品路线图.pptx", "office", 8, ["封面", "产品愿景", "用户旅程", "功能路线图", "里程碑", "资源规划", "风险清单", "附录"]),
  d3: doc("d3", "p1", "竞品分析.png", "image", 1, ["竞品能力对比"]),
  d4: doc("d4", "p1", "需求说明.md", "markdown", 3, ["需求背景", "功能清单", "验收标准"]),
  d5: doc("d5", "p2", "首页改版稿.pdf", "pdf", 6, ["首页现状", "问题梳理", "新版首页", "组件规范", "响应式", "走查结论"]),
  d6: doc("d6", "p2", "交互说明.html", "html", 1, ["交互说明"]),
  d7: doc("d7", "p3", "论文初稿.pdf", "pdf", 18, ["摘要", "引言", "相关工作", "方法", "实验", "分析", "结论", "参考文献"])
};

export const seedAnnotations = {
  "d1:2": [pin(31, 42, "议程第 3 项和第 5 项内容重叠，可以合并", "todo", now - 90 * min)],
  "d1:3": [
    note("这页信息太密，一屏塞了三个论点，建议拆成两页讲。", "todo", now - day),
    region(8, 9, 47, 15, "主标题和正文字号几乎一样，层级不清", "todo", now - 50 * min),
    pin(63, 39, "这个环比数字要更新为 Q3 实际值", "todo", now - day),
    pin(22, 73, "这里的数据来源没有标注", "question", now - 70 * min)
  ],
  "d1:5": [note("增长曲线不错，但缺一条同比参照线。", "question", now - 3 * hour), pin(52, 56, "补一条去年同期的虚线", "todo", now - 3 * hour)],
  "d1:7": [note("结构清晰，这页暂无大问题。", "resolved", now - 6 * hour)],
  "d1:9": [region(54, 28, 32, 44, "竞品象限图里 A 和 B 的位置反了", "question", now - 4 * hour)],
  "d2:4": [note("路线图时间轴缺了 Q4，补上。", "todo", now - 5 * hour)],
  "d3:1": [pin(42, 48, "这张图分辨率偏低，换成高清版", "todo", now - day)]
};

export const seedHistory = {
  "d1:3": [
    history("snapshot", "第二轮评审快照", now - 30 * min, "v2"),
    history("edit", "修改标记① 的文字", now - 35 * min),
    history("create", "新增框选 A：标题层级问题", now - 50 * min),
    history("create", "新增标记②：数据来源缺失", now - 70 * min),
    history("snapshot", "首轮评审快照", now - day, "v1")
  ]
};

function doc(id, projectId, name, type, pageCount, titles) {
  const ext = name.split(".").pop().toUpperCase();
  return {
    id,
    projectId,
    name,
    type,
    ext,
    renderMode: type === "markdown" || type === "html" ? "text" : "raster",
    pageCount,
    titles,
    updated: now - (id.charCodeAt(1) % 5) * hour
  };
}

function baseAnno(type, text, tag, createdAt) {
  return { id: `a-${Math.random().toString(36).slice(2, 9)}`, type, text, tag, createdAt, updatedAt: createdAt };
}

function note(text, tag, createdAt) {
  return baseAnno("note", text, tag, createdAt);
}

function pin(x, y, text, tag, createdAt) {
  return { ...baseAnno("pin", text, tag, createdAt), x, y };
}

function region(x, y, w, h, text, tag, createdAt) {
  return { ...baseAnno("region", text, tag, createdAt), x, y, w, h };
}

function history(action, label, ts, rev = "") {
  return { id: `h-${Math.random().toString(36).slice(2, 9)}`, action, label, ts, rev };
}
