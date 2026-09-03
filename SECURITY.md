# Security policy

## Supported version

Until the first public release, only the latest `main` revision is supported.
After publication, security fixes will target the latest released minor version.

## Reporting

Do not publish document samples, local file paths, workspace backups, or exploit
details in a public issue. Use GitHub private vulnerability reporting after it
is enabled for the repository. Before the repository is public, report issues
directly to the project owner.

## Local security boundary

The application API is designed for `127.0.0.1` only. It validates both the
HTTP Host header and browser Origin and must never be exposed through a public
reverse proxy. Electron runs with context isolation, renderer sandboxing, and
Node integration disabled.

Electron protects non-health API routes with a random local capability token.
Task-scoped MCP connections additionally use a task ID and a separate random
task token. A task connection registers only frozen-task tools; an unscoped
connection registers only current-document tools. Neither token is returned by
the health or diagnostics endpoints.

Task-specific MCP configurations do not receive the desktop-wide API token.
Their task token is accepted only on URLs for that exact task and cannot read
the live workspace or another task.

MCP limits data returned by this application, but it cannot revoke unrelated
filesystem permissions already granted to an IDE. Treat access to the MCP
process and the declared task working paths as sensitive local access.

## Sensitive data

Imported documents, annotations, full backups, and tracked source paths may
contain confidential information. Do not attach them to bug reports without
redaction. See `docs/PRIVACY.md` for storage details.

Full-backup restore validates archive size, entry paths, file counts and the
workspace manifest before replacing live data. A pre-restore rollback copy is
retained locally.
