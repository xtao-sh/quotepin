# Contributing

## Setup

Follow `README.md`, including the Python environment and Poppler installation.
Run `npm run check:runtime` before diagnosing document-import failures.

## Before submitting a change

```bash
npm test
npm run build
```

Changes to Electron startup or packaging should also pass `npm run
desktop:pack` and `npm run test:desktop` on macOS.

Keep changes scoped to the relevant module. Add regression tests for API,
storage, export, refresh, or MCP behavior. Never commit real documents,
workspace data, local paths, credentials, signing certificates, or generated
release artifacts.

Contributions are accepted under Apache-2.0 unless explicitly marked otherwise.
