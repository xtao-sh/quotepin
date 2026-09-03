# Third-party notices

批注工作台 is licensed under Apache-2.0. It includes or bundles the following
third-party components under their own licenses:

| Component | License | Use |
|---|---|---|
| PDF.js / `pdfjs-dist` | Apache-2.0 | PDF rendering and text layers |
| React and React DOM | MIT | User interface |
| Lucide | ISC | Interface icons |
| Onest | SIL Open Font License 1.1 | User-interface font |
| JetBrains Mono | SIL Open Font License 1.1 | Monospace font |
| Model Context Protocol SDK | MIT | Local AI/MCP integration |
| Express, Multer, Archiver, Unzipper and Zod | MIT | Local API, validation and archives |

The production build copies the applicable full license texts into
`dist/licenses/`. Packaged runtime dependencies retain the license files from
their npm packages inside the application archive.

PDF conversion can optionally call separately installed Poppler and
LibreOffice executables. They are not bundled with this repository or the
default desktop package. Their licenses apply when users install or redistribute
those programs separately.

Python PDF export uses separately installed `pypdf` (BSD-3-Clause) and
ReportLab (BSD). See `requirements.txt` for the tested versions.
