// The app shells out to Poppler, Tesseract, LibreOffice and Python. None of them ship with the
// desktop build, so a clean Mac can open the app and then fail on its very first import. This
// module turns the /api/health "tools" flags into something a first-time user can act on.

export const RUNTIME_REQUIREMENTS = [
  {
    id: "poppler",
    name: "Poppler",
    tools: ["pdf", "text"],
    required: true,
    purpose: "阅读 PDF：页面渲染、文字层、全文搜索与批注重定位",
    consequence: "没有它就无法打开任何 PDF，只能使用图片和纯文本文档。",
    install: "brew install poppler"
  },
  {
    id: "tesseract",
    name: "Tesseract",
    tools: ["ocr"],
    required: false,
    purpose: "扫描版 PDF 和图片的按页 OCR",
    consequence: "扫描件仍可点标和框选，但无法选中文字或搜索。",
    install: "brew install tesseract"
  },
  {
    id: "libreoffice",
    name: "LibreOffice",
    tools: ["office"],
    required: false,
    purpose: "导入 DOCX、PPTX、XLSX 等 Office 文档",
    consequence: "导入 Office 文件会失败，PDF 和图片不受影响。",
    install: "brew install --cask libreoffice"
  },
  {
    id: "python-pdf",
    name: "Python 文档依赖",
    tools: ["outline", "pdfExport"],
    required: false,
    purpose: "读取 PDF 原生目录，导出带批注的 PDF",
    consequence: "侧栏没有目录树，导出时无法生成带批注的 PDF。",
    install: "python3 -m pip install pypdf reportlab"
  }
];

const TOOL_REQUIREMENT_IDS = {
  pdfinfo: "poppler",
  pdftoppm: "poppler",
  pdftotext: "poppler",
  tesseract: "tesseract",
  soffice: "libreoffice",
  python3: "python-pdf"
};

export function runtimeReadiness(tools) {
  const available = tools && typeof tools === "object" ? tools : {};
  const groups = RUNTIME_REQUIREMENTS.map((requirement) => ({
    ...requirement,
    missingTools: requirement.tools.filter((tool) => available[tool] !== true)
  })).map((requirement) => ({ ...requirement, missing: requirement.missingTools.length > 0 }));
  const missing = groups.filter((group) => group.missing);
  return {
    groups,
    missing,
    // Only Poppler stops the app being useful at all. Everything else degrades one feature.
    blocked: missing.some((group) => group.required),
    ready: missing.length === 0
  };
}

// The API reports which executable it could not find; name the package the user actually installs.
export function requirementForTool(tool) {
  const id = TOOL_REQUIREMENT_IDS[String(tool || "")];
  return RUNTIME_REQUIREMENTS.find((requirement) => requirement.id === id) || null;
}

export function missingToolMessage(detail, tool) {
  const requirement = requirementForTool(tool);
  if (!requirement) return String(detail || "这一步需要的本机组件不可用。");
  return `${requirement.name} 未安装，${requirement.purpose}需要它。在终端运行：${requirement.install}`;
}
