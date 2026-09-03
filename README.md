# 批注工作台

批注工作台是一款本地优先的文档审阅应用。它可以导入 PDF、图片、文本和 Office
文档，在页面坐标或 PDF 文字层上添加批注，把项目组织成分组和子项目，导出审阅
结果，并通过本地 MCP 服务与 Codex、Claude Code 等工具逐条交换意见。

当前发行目标是 macOS。应用数据保存在本机，不包含遥测或云端同步。

## 主要能力

### 阅读与批注

- PDF 连续或单页阅读、缩放、旋转和文字选择
- 点标、框选、文字批注、整页备注和对话式回复
- 「复制给 AI」按句子截取上下文，只带走选中的那句话及其前后文，而不是整页
- 遇到没有 ToUnicode 映射、选中即乱码的 PDF 时，按选区调用 OCR 还原引用原文
- 批注可以「归档到历史」，正文标记随之收起，记录仍然保留

### 组织与整理

- 三层结构：分组 → 项目 → 子项目。分组可折叠、可排序，用来区分教学、科研等大类
- 文档可以在项目之间移动，「新建子项目」后把文档归入其中
- 「在访达中显示」直接跳到原始文件所在的文件夹，文档页和列表页都可以
- 「清理重复文档」按原始路径和内容哈希找出同一份文件的多个副本，合并前会说明
  每个副本上有多少条批注会被一起删除
- 「归档」把不再修改的文档收进列表底部的历史区。原文件、批注和版本历史全部保留，
  只清理可以重新生成的渲染缓存，并报告回收了多少空间。归档后的文档不再参与
  「有新版本」提醒和重复检测

### 版本与导出

- 按原始路径刷新，文字批注在新版本上自动重定位，最近 5 个文档版本可随时恢复
- HTML、JSON、完整备份和带批注 PDF 导出；默认排除已解决意见
- 文档全文搜索、原生 PDF 目录、按页 OCR、运行依赖和工作区诊断

扫描版 PDF 和图片在首次进入文字模式时会按页调用本机 Tesseract 建立可选择、
可搜索的文字层；没有安装 OCR 运行时仍可使用点标和框选。

## 安装与首次运行

应用调用本机的命令行工具处理文档，安装包**不包含**它们。干净的 Mac 需要先装
Poppler，否则无法打开任何 PDF。

```bash
brew install poppler
```

其余组件是可选的，缺少时只影响对应功能：

| 组件 | 安装命令 | 缺少时的影响 |
| --- | --- | --- |
| Poppler（必需） | `brew install poppler` | 无法打开任何 PDF，只剩图片和纯文本 |
| Tesseract | `brew install tesseract` | 扫描件仍可点标框选，但无法选中文字或搜索 |
| LibreOffice | `brew install --cask libreoffice` | 无法导入 DOCX、PPTX、XLSX |
| Python 依赖 | `python3 -m pip install pypdf reportlab` | 没有 PDF 目录树，无法导出带批注的 PDF |

处理中文文档时建议一并安装中文语言包，否则选区 OCR 只能识别英文：

```bash
brew install tesseract-lang
```

首次启动时应用会自己检测这些组件，并在顶部列出缺少的项和对应命令。装好之后点
「重新检测」即可，不需要重启。

从 `.dmg` 安装的版本目前没有 Apple Developer ID 签名和公证，macOS 首次打开会
拦截。在「系统设置 → 隐私与安全性」里找到被拦截的提示并选择「仍要打开」。

应用数据保存在 `~/Library/Application Support/批注工作台/`（源码运行时是仓库下的
`app-data/`）。工作区是其中的 `workspace.json`，另有 `backups/workspace-history/`
存放每小时的自动快照，保留最近 20 份。

### 常见错误对照

| 提示 | 原因与处理 |
| --- | --- |
| 导入失败，提示缺少 Poppler | 按上表安装 Poppler，然后点「重新检测」 |
| 端口被另一个本地服务占用 | 退出旧版批注工作台后重试 |
| 工作区文件无法读取 | 应用会进入恢复模式并列出可用快照，选择一个时间点恢复 |
| 工作区由更新版本写入 | 装回新版本，或从完整备份恢复；旧版本不会改写它 |
| 选中文字后提示「批注所在的位置已改变」 | 源文件在打开期间被改写。点顶栏的「刷新」载入最新版本后重试 |
| 引用框里是乱码 | 该 PDF 的字体没有 ToUnicode 映射。应用会自动按选区 OCR 还原，需要 Tesseract |

## 开发环境

- Node.js 22.12 或更高版本
- Python 3 和 `requirements.txt` 中的包
- Poppler：PDF 分析、渲染和文字提取所必需
- Tesseract：扫描 PDF 和图片 OCR，可选；中文文档需要 `chi_sim` 语言包
- LibreOffice：只在导入 DOCX、PPTX、XLSX 等 Office 文件时需要

macOS 可以使用：

```bash
brew install node@22 poppler tesseract tesseract-lang
brew install --cask libreoffice
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npm run check:runtime
npm run dev
```

浏览器开发地址默认是 `http://127.0.0.1:5173/`。本地 API 只监听 loopback
地址，不应通过代理或端口映射暴露到局域网或互联网。

## 构建和测试

```bash
npm run verify
npm test
npm run build
npm run desktop:pack
npm run desktop:dist
```

`npm run verify` 会依次检查公开文件、运行依赖、生产依赖安全、完整测试和构建，
任何一步失败都会中断后面的步骤。默认桌面包不会捆绑 Poppler、LibreOffice 或
Python 运行时。源码开发者和未内置运行时的发行包仍需安装上述依赖。正式发布
macOS 安装包前还需要使用 Apple Developer ID 签名并完成 notarization。

在本机已经存在 Codex workspace runtime 时，App 会把其中的 Python 作为可选
兜底；公开构建不能依赖这一行为，干净环境仍应按上面的标准依赖完成安装。

## MCP

仓库包含 Codex 和 Claude Code 可识别的本地 MCP 配置。完整流程和工具列表见
[`docs/AI_REVIEW_WORKFLOW.md`](docs/AI_REVIEW_WORKFLOW.md)。

隔离审阅任务按唯一任务 ID 读取固定快照，不受 App 后续切换文档影响。任务专属
连接只注册任务工具，普通连接只注册当前文档工具，两个权限面不会混用。审阅任务
目前只通过 MCP 和 HTTP 接口使用，应用界面里没有入口——日常审阅直接打开文档进行。

## 数据与安全

用户文档和批注不属于仓库内容，也不应出现在 issue、测试夹具或提交中。数据
目录、备份行为和已知边界见 [`docs/PRIVACY.md`](docs/PRIVACY.md) 与
[`SECURITY.md`](SECURITY.md)。当前质量状态和后续边界见
[`docs/QUALITY_AUDIT.md`](docs/QUALITY_AUDIT.md)。

## 许可证

源代码按 Apache License 2.0 发布。第三方依赖见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。应用名称和图标不随代码
许可证授权，见 [`TRADEMARKS.md`](TRADEMARKS.md)。
