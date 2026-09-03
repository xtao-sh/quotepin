# Quality audit

Last reviewed: 2026-07-29

## Completed

- Refresh reads the tracked source path, reports missing or newer sources, preserves the
  display name, and can clear either the current page or the whole document.
- Changed PDFs retain five recoverable local versions. Text annotations use quote context
  to relocate after refresh; unmatched anchors are hidden and offered for manual relinking.
- Page writes use revision checks and conflict UI. Destructive actions flush pending edits,
  browser-side pending edits survive restart in IndexedDB, and workspace writes retain
  recovery snapshots. SSE events have IDs, bounded replay and reconnect reconciliation.
- Export supports annotated-only or all PDF pages, unresolved-only or complete history,
  latest reply or full conversation. Resolved annotations are excluded by default.
- AI replies, change evidence and status controls are consolidated. Resolved cards collapse
  by default and their document overlays disappear.
- Document and project review tasks contain frozen artifacts, a Markdown checklist, unique
  task IDs and task tokens. Task MCP and current-document MCP expose disjoint tool sets;
  task configurations do not contain the desktop-wide API token.
- PDF rendering uses bounded high-resolution canvases, a small document cache and viewport
  virtualization in continuous mode. Zoom supports 50% through 500% and trackpad gestures.
- Native PDF outlines and chunked full-text search are used when available. Scanned or
  partially selectable documents report their text-layer status explicitly. PDF and image
  pages can build and cache an OCR layer on demand when Tesseract is installed. Large PDF
  imports open after basic metadata is ready and finish structure/text analysis in the background.
- Refresh and full-backup restore use recovery journals so an interrupted directory swap is
  rolled back on next launch. Stored workspaces carry an explicit schema version.
- Structured exports hide absolute document paths by default, guard CSV cells against
  spreadsheet formulas, retain conversations, and bound HTML preview rendering concurrency.
- Loopback Host/Origin validation, Electron context isolation, navigation restrictions,
  IPC sender checks, archive validation and bounded uploads are covered by tests.
- The desktop UI has keyboard-aware dialogs, inert hidden drawers, outside-click menus,
  compact annotation cards and a runtime diagnostics entry.

## Verified

- Full Node test suite, including API, refresh, export, backup, MCP, PDF and corruption cases.
- Production build and bundled MCP build.
- Public-tree and runtime dependency checks.
- Production dependency audit with zero known vulnerabilities.
- Desktop, narrow-window and continuous-scroll visual checks without document mutation.

## Current boundaries

- OCR is local and optional, but the Tesseract binary and requested language packs are not
  bundled. The default language is English and can be changed with `REVIEW_OCR_LANGS`.
- Office conversion depends on LibreOffice. PDF analysis and annotated-PDF export depend on
  Poppler and the pinned Python packages.
- MCP is request/response integration. Automatically waking an idle AI client would require
  a separate local agent service and an explicit permission model.
- Quote reanchoring is best effort. Duplicate passages, major rewrites and scanned pages can
  require manual relinking.
- The macOS binary still needs Developer ID signing, notarization and clean-machine testing
  before public distribution.
- Publication rights for the product name and current icon must be confirmed before opening
  the repository.
- The main React module and API module remain large. Splitting them by viewer, review,
  export, ingestion and task domains is recommended before multi-contributor development,
  but was intentionally not mixed into this behavioral repair.
- Electron Builder's development-only packaging chain currently reports 16 high-severity
  upstream advisories; production dependencies audit cleanly with zero findings. Do not
  force incompatible transitive overrides.

## Recommended next product work

1. OCR language selection and batch progress controls in the UI.
2. Side-by-side document-version comparison before applying a refresh.
3. Bulk selection and status changes for large review queues.
4. A permissioned local agent queue for explicitly approved automatic AI task pickup.
5. Thumbnail virtualization and a disk-backed search index for documents with thousands of pages.
