# Open-source release checklist

The repository is currently **private** at `XTAO-SH/quotepin`. The items below are
what remains before switching it to public.

## Before making the repository public

- [x] Add an OSI-approved source license.
- [x] Add third-party notices and copy licenses into binary builds.
- [x] Remove private design references and obsolete artwork from tracked files.
- [x] Remove hard-coded local paths from current documentation and source.
- [x] Add README, security policy, contribution guide, privacy notes, and CI.
- [x] Add runtime dependency checks and Python dependency pins.
- [x] Protect the loopback API against DNS rebinding.
- [x] Require local API and task-scoped MCP capability tokens.
- [x] Add CI tests, production dependency audit, backup validation, and public-tree checks.
- [x] Confirm ownership and publication rights for the current icon and product name.
      The icon is the owner's own work. The names 批注工作台 and Quotepin are the owner's
      choice; TRADEMARKS.md reserves both from the code license.
- [x] Choose the public GitHub organization/repository name and update metadata links.
      Published as `XTAO-SH/quotepin`; `repository`, `homepage` and `bugs` are set
      in `package.json`.
- [x] Replace the local Git author email and, before the first push, decide whether to
      rewrite existing author metadata and remove private assets from old commits.
      The pre-publication history was not published: the repository starts from a single
      initial commit authored as `XTAO-SH <101576191+xtao-sh@users.noreply.github.com>`.
      The 35-commit development history is kept only in a local bundle outside the repository.
- [ ] Enable GitHub private vulnerability reporting and branch protection.
      Private vulnerability reporting requires a public repository, so this waits until the
      repository is switched to public.

## Before publishing a desktop binary

- [ ] Decide whether to bundle Poppler, Python, and LibreOffice or require external
      installation; review each bundled binary's redistribution terms.
- [ ] Produce an SBOM and verify the packaged third-party license directory.
- [ ] Resolve or formally accept 16 high-severity, development-only advisories in the
      Electron Builder packaging dependency chain; production dependencies currently
      audit cleanly.
- [ ] Build separate Apple silicon and Intel artifacts, or a tested universal build.
- [ ] Sign with an Apple Developer ID, enable hardened runtime, and notarize the DMG.
- [ ] Test installation on a clean macOS account without Homebrew or Codex runtimes.
- [ ] Publish checksums and release notes.
