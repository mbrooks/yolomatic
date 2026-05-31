# Changelog

## Unreleased

### Breaking Changes
- **Default admin port changed from `3000` to `6767`** to avoid common port conflicts with local development services (Node.js/Express, Create React App, Vite, etc.). Users relying on the previous default should explicitly set `PORT=3000` in their environment or update their deployment configurations accordingly.

### Updated
- Default `port` setting updated to `6767` in `src/settings/model.ts`
- Default fallback port in `src/config.ts` updated to `6767`
- README local development instructions updated to reference `ngrok http 6767`
- `scripts/update-tars-if-needed.sh` default port updated to `6767`
