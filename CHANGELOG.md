# Changelog

## Unreleased

### Added
- Session state and session logs are now persisted in SQLite (`memory/bot-state.sqlite`), consistent with the existing `SettingsStore`, `SkillStore`, and `GitHubEventStore`. Sessions resume across restarts from SQLite instead of per-issue `.state.json` files.
- On startup, existing file-backed sessions are migrated into SQLite once (`SessionStore.migrateFromFileStoreIfNeeded`); the original `.state.json` files are preserved as a rollback path and are not deleted.
- New `session_logs` table durably stores the per-session log stream so logs survive restarts; they are reloaded into the in-memory read path on boot.
- Manual repository management in `tarsadmin`: admins can add repositories by owner/name from the repository inventory page via `POST /api/repos`.
- Public repositories can only be added manually; `POST /api/repos/scan` now auto-discovers private/internal repositories and reports skipped public repositories in a `skipped` array.

### Breaking Changes
- **Default admin port changed from `3000` to `6767`** to avoid common port conflicts with local development services (Node.js/Express, Create React App, Vite, etc.). Users relying on the previous default should explicitly set `PORT=3000` in their environment or update their deployment configurations accordingly.

### Updated
- Default `port` setting updated to `6767` in `src/settings/model.ts`
- Default fallback port in `src/config.ts` updated to `6767`
- README local development instructions updated to reference `ngrok http 6767`
- `scripts/update-tars-if-needed.sh` default port updated to `6767`
