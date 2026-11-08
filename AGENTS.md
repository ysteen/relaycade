# Project development

- This repository owns the broker, reusable rollback client, core patches, and qualification tools.
- The administration UI lives in this repository. RomM authentication, library/player integration and save uploads live in the RomM adapter repository.
- Use Node 24 or later. Run `npm test` for transport and rollback changes.
- Emulator qualification needs explicitly prepared external binaries. Never commit commercial ROMs, user saves, credentials, generated cores, or test output.
- Keep compiler parallelism at two. Close isolated Chrome before builds and at task completion; never close the user's browser.
- Use RomM's persistent `scripts/headless-browser.mjs` helper for the optional browser integration harness (`ROMM_SOURCE`).
- Keep source comments and documentation in English. Preserve upstream notices and core source revisions when distributing builds.
- Changes to vendored browser modules must be synchronized through `scripts/sync-romm-client.mjs` and verified with `--check`.
- Do not run native emulator qualification under WSL. The rejoin harness coincided with repeated RAM/swap exhaustion on 2026-11-02. Use a separate Linux runner with a hard cgroup memory limit and at most two CPUs. Keep local transport tests serial and image builds in CI until native rejoin memory growth is diagnosed.
