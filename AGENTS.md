# AGENTS.md

## Repository

This repository is the GitHub Action Routact. It routes jobs to idle self-hosted runners and falls back to a runner of the same OS and architecture. It is a library-style action, not an application. Read `CONTRIBUTING.md` for the toolchain and the release process.

- Use nub (`nub install`, `nub run <script>`). Do not use npm, and do not add `package-lock.json`.
- After a change to `index.js` or `src/`, run `nub run build` and commit `dist/`.
- Unit tests use Jest in `__tests__/`. Do not add tester-army/e2e, Vitest, or Playwright.
- Fork pull requests always get the fallback. Do not change that.
- Do not print tokens. Do not add debug output with request headers.
- `action.yml` descriptions are evaluated by Actions, so never write `${{ }}` in them.
- Public repository: workflows use GitHub-hosted runners only. Never use self-hosted runners in this repository's own workflows.

## Releases

- Add a `.tegami/` release entry to each pull request that changes the published action. Use the `release:none` label for a change with no effect on users, and say why in the pull request.
- Do not edit `CHANGELOG.md`, the `package.json` version, or `.tegami/publish-lock.yaml` on a feature branch. The Tegami version pull request owns those files.
- Do not create or move tags, and do not publish to the Marketplace.

## Pull requests

- Open a pull request as a draft. CI does not run on drafts.
- Before each push, run `nub run check` and `nub run check-dist`. Run `actionlint` when it is available.
- When the work is done, mark the pull request ready for review.
