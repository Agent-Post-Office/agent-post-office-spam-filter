# Releasing

Publishing uses npm Trusted Publishing (OIDC) from `.github/workflows/publish.yml`. This repository has no npm token.

## One-time npm setup

On npmjs.com, open the `@agent-post-office/spam-filter` package **Settings**.

1. **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `Agent-Post-Office`
   - Repository: `agent-post-office-spam-filter`
   - Workflow filename: `publish.yml` (filename only)
   - Environment name: leave empty
   - Allow direct `npm publish`. Publishers created after 3 Sep 2026 default to `npm stage publish` only, and this workflow does not stage.
2. **Publishing access** → **Require two-factor authentication and disallow tokens**. Save.

v0.1.0 is already published on npm, so the one-time publish from a maintainer account is done. Do not add an npm token to GitHub.

A new trusted publisher must publish successfully within 2 days or it expires. `publish.yml` must already be on the default branch. `package.json` `repository.url` must keep pointing at `https://github.com/Agent-Post-Office/agent-post-office-spam-filter` (provenance checks it).

## Release

1. Bump `version` in `package.json` and `package-lock.json`. Commit that change.
2. Tag the commit `vX.Y.Z`, where `X.Y.Z` is exactly the `package.json` version.
3. Push the tag: `git push origin vX.Y.Z`.

The tag push runs tests and the build, fails unless the tag matches the package version, then runs `npm publish --provenance --access public`. Authentication is the GitHub Actions OIDC token. Do not set `NODE_AUTH_TOKEN` or `NPM_TOKEN`.
