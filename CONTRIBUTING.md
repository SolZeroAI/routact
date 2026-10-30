# Contributing

Routact is a JavaScript action. The runner starts `dist/index.js` with Node 24. The entry point is `index.js`, and the logic lives in `src/`. `ncc` bundles both into `dist/`. Commit `dist/` with each source change, because Actions runs it directly. CI fails when `dist/` does not match `nub run build`.

## Toolchain

This repository follows the SolZero Shared Project DNA.

- Node `24.15.0` (`.node-version`, `.nvmrc`, `engines` `>=24.15.0 <25`).
- nub `0.9.6` (`packageManager` and `devEngines.packageManager`). `nub.lock` is the lockfile. Do not add `package-lock.json`.
- oxlint `1.89.0` with `anti-slop`, and oxfmt `0.74.0`. Do not add ESLint, Prettier, or Biome.
- Unit tests use Jest in `__tests__/`. Routact is a library-style action, so unit tests are allowed.

```sh
nub install --frozen-lockfile
nub run check       # lint, format, test, build
nub run check-dist  # build, then fail if dist/ changed
```

`nub run lint:fix` and `nub run format:fix` fix what they can.

Build `dist/` with nub `0.9.6` exactly. ncc derives module ids from the paths in `node_modules`, and another nub version can lay that folder out differently, so the bundle differs and CI's check-dist fails. When that happens, the failed Validate run uploads the expected `dist/` as an artifact.

The source is plain JavaScript, so there is no typecheck step. Two anti-slop rules are warnings, not errors: `no-runtime-typeof` (plain JavaScript has no type predicates for the config parsing in `src/config.js`, `src/checks.js` and `src/maintain.js`) and `no-module-mocking` (`__tests__/index.test.js` mocks the GitHub client). Fix them in a cleanup pull request, then make them errors.

## Pull requests

Open a pull request as a draft. CI does not run on drafts. Run `nub run check` before each push. Mark the pull request ready for review when the work is done, and CI runs then.

## Releases

Tegami owns versions, tags, and GitHub Releases. Do not cut a tag, edit `CHANGELOG.md`, or bump `package.json` by hand.

Add a release entry under `.tegami/` to each pull request that changes the published action:

```md
---
packages:
  "npm:routact": minor
---

## What changed

One short paragraph for users.
```

Use `major` for a breaking change to an input, an output, or routing behavior. Use `minor` for a new feature and `patch` for a fix. When a pull request does not change the published action (CI, docs, dev dependencies), add the `release:none` label instead.

How a release happens:

1. Validate passes on a push to `master`. Then `.github/workflows/release.yml` runs `nub run tegami ci` with a token from the release GitHub App (`RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` in the `release` environment).
2. When `master` has new `.tegami/` entries, Tegami opens or updates the `tegami/version-packages` pull request. It bumps `package.json` and writes `CHANGELOG.md`.
3. Merging that pull request is the release approval. The next run creates the `vX.Y.Z` tag and the GitHub Release (`scripts/action-release.mts`). Then `scripts/move-major-tag.mts` moves the floating major tag (for example `v2`) to that commit. Prereleases do not move it.

The app token is used instead of `GITHUB_TOKEN` so that the version pull request gets CI. Tegami PR Preview and Tegami PR Comment post a release preview on each pull request.

### GitHub Marketplace

Tegami creates the GitHub Release through the API, which does not list a version on the Marketplace. To list a release, open it on GitHub, choose **Edit**, check **Publish this Action to the GitHub Marketplace**, and update the release. Users who pin `@v2` get each release whether or not it is listed.
