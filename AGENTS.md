# Project development

- This repository owns the broker, reusable rollback client, core patches, and qualification tools.
- RomM authentication, library access, UI, and save uploads live in the RomM adapter repository.
- Use Node 24 or later. Run `npm test` for transport and rollback changes.
- Emulator qualification needs explicitly prepared external binaries. Never commit commercial ROMs, user saves, credentials, generated cores, or test output.
- Keep compiler parallelism at two. Close isolated Chrome before builds and at task completion; never close the user's browser.
- Use RomM's persistent `scripts/headless-browser.mjs` helper for the optional browser integration harness (`ROMM_SOURCE`).
- Keep source comments and documentation in English. Preserve upstream notices and core source revisions when distributing builds.
- Changes to vendored browser modules must be synchronized through `scripts/sync-romm-client.mjs` and verified with `--check`.
