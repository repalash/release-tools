# release-tools

Publish npm packages from GitHub Actions by bumping a version and pushing. A reviewer approves each release, npm gets it with provenance, and no npm token is stored anywhere.

```yaml
jobs:
  release:
    permissions: {contents: write, id-token: write}
    uses: repalash/release-tools/.github/workflows/npm-release.yml@v1
    secrets: inherit
```

## Features

- **Version-driven.** A package is released when its `version` is not on npm yet. Any other push ends after a quick check, so the workflow can run on every push to the release branch.
- **Approval before publish.** The publish job waits for a reviewer on the `npm-publish` environment. The tarballs that the reviewer approves are the ones built and checked before.
- **No npm tokens.** Publishing uses npm trusted publishing (OIDC), and every version gets a provenance statement.
- **One package or many.** It handles a package at the root, in a subfolder, or every package of npm workspaces, published in dependency order.
- **Changelog-aware.** It can require a `CHANGELOG.md` section for each version, and it uses that section as the notes of the GitHub release.
- **Release notice.** A Discord message links the approval page, the commits since the previous release and an optional Claude Code review of the release.
- **Separated jobs.** The job that runs your build has no secrets. The jobs that hold secrets or publish never run your code. A failed or cancelled publish can run again safely.
- **Setup script.** `scripts/setup-repos.sh` sets up the environment, the secrets and the npm trusted publishers for several repositories at once.

The repository also holds [`dts-js-extensions`](packages/dts-js-extensions), an npm package that rewrites relative imports in emitted `.d.ts` files to explicit `.js` paths, for `moduleResolution: node16 | nodenext`.

Used by [ts-browser-helpers](https://github.com/repalash/ts-browser-helpers), [uiconfig.js](https://github.com/repalash/uiconfig.js), [three-ts-types](https://github.com/repalash/three-ts-types), [three.js-modded](https://github.com/repalash/three.js-modded) and [tweakpane-image-plugin](https://github.com/repalash/tweakpane-image-plugin).

## The release flow

To release, bump `version` in `package.json` (and add the CHANGELOG section if required), then
push to the release branch. Each push runs the workflow:

1. **check**: lists the public packages whose `name@version` is not on npm, dependencies first.
   With `require-changelog`, each needs a `CHANGELOG.md` section for its version. Then it runs
   the `build` command, packs each package into a tarball, and keeps the tarballs as an artifact.
   When every version is on npm, the run ends here.
2. **notify** (optional): starts a Claude Code routine session that reviews the release, and posts
   a Discord notice with the approval link, the review link and the commits since the previous
   release. A failed check or build also gets a notice.
3. **publish**: waits for approval of the `npm-publish` environment. Then it publishes each
   tarball with npm trusted publishing and provenance, and tags the commit (or creates a GitHub
   release with the tarball).

## Usage

### One package at the repository root

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: publish
  cancel-in-progress: false

jobs:
  release:
    permissions:
      contents: write # tags and GitHub releases
      id-token: write # npm trusted publishing
    uses: repalash/release-tools/.github/workflows/npm-release.yml@v1
    with:
      build: npm ci && npm test
    secrets: inherit
```

### One package in a subdirectory, with a GitHub release

```yaml
    with:
      packages: types/three
      build: '' # no build step
      github-release: true
```

### npm workspaces

```yaml
    with:
      packages: packages/*
      build: npm ci && npm run build
      require-changelog: true
      tag-format: '{name}-{version}'
```

Each public package below `packages/` whose version is not on npm is published, after the listed
packages it depends on. Private packages are skipped. The `build` command must build every
package that the released packages need, also the ones that are not released this time.

More callers: [`examples/`](examples).

### Inputs

| Input | Default | Description |
|---|---|---|
| `packages` | `.` | A package directory, or `<dir>/*` for every directory below `<dir>` that has a `package.json`. Separate several entries with spaces. |
| `build` | `npm ci` | Shell command run at the repository root before packing. Empty: no build step. |
| `node-version` | `24` | Node.js version for the build. The publish job always uses Node.js 24. |
| `clean-package` | `false` | Pack with the package's [clean-package](https://www.npmjs.com/package/clean-package): `npm run prepack --if-present`, `clean-package`, `npm pack --ignore-scripts`, `clean-package restore`. clean-package usually removes `scripts`, so `npm pack` cannot run `prepack` itself. Without this input: plain `npm pack`. |
| `require-changelog` | `false` | Fail when a package has no `CHANGELOG.md` section for its version. |
| `tag-format` | see below | Release tag. `{name}` and `{version}` are replaced. |
| `github-release` | `false` | Create a GitHub release with the tarball for each package, instead of a plain tag. A prerelease version gets a prerelease. |
| `review-actor` | `repalash` | GitHub user whose pushes start the Claude review. Empty: never. |

The default `tag-format` is `publish@{version}`. When `packages` has a `/*` entry or several
entries, it is `{name}-{version}`, and a format without `{name}` is an error. The previous release
tag of a package is the latest tag in that format reachable from the commit. For a format without
`{name}`, `v1.2.3` tags also count.

A CHANGELOG section starts at a heading (`#` to `###`) whose first word is the version:
`## [1.2.3] - 2026-01-01`, `## v1.2.3`, `## 1.2.3`, `# [1.2.3](link) (date)`. An empty section
counts as missing. The section becomes the notes of the GitHub release.

A prerelease version (`1.0.0-beta.1`) is published with the dist-tag `next`, unless
`publishConfig.tag` in its `package.json` sets another one.

Output: `release`, the JSON of the release (`packages` is empty when nothing was pending).

### Secrets

All are optional. With `secrets: inherit` the workflow reads them from the calling repository.

| Secret | Use |
|---|---|
| `DISCORD_WEBHOOK_URL` | Discord webhook for the notice. No notice when unset. |
| `CLAUDE_REVIEW_FIRE_URL` | Fire URL of a Claude Code routine. The workflow POSTs the release facts (`{"text": …}`) and links the session it returns. |
| `CLAUDE_REVIEW_TOKEN` | Bearer token of that routine. |

The review starts only when the build succeeded, the event is a `push`, the actor is
`review-actor`, and both routine secrets are set.

## Repository setup

`scripts/setup-repos.sh` does steps 1 to 3 for several repositories at once. It checks first and
skips what is set, asks for each secret value once (hidden), and runs `npm trust github` in your
terminal. It needs `gh` with admin rights on the repositories, `jq`, and `npm` logged in:

```sh
scripts/setup-repos.sh <owner>/<repo>:<calling-workflow-file>:<package>[,<package>] ...
```

To rotate one secret in several repositories, without other changes:

```sh
scripts/setup-repos.sh --set-secret CLAUDE_REVIEW_TOKEN <owner>/<repo> <owner>/<repo> ...
```

The steps, by hand, once per calling repository:

1. Create the environment `npm-publish` and add yourself as a required reviewer:
   `https://github.com/<owner>/<repo>/settings/environments`. Do this before the first run:
   GitHub creates a missing environment on first use without protection rules, so the check job
   stops when `npm-publish` has no required reviewer (reading the environment works with the
   default token in public repositories).
2. Optional: add the secrets above at `https://github.com/<owner>/<repo>/settings/secrets/actions`.
3. Add a trusted publisher on npmjs.com for each package
   (`https://www.npmjs.com/package/<name>/access`):

   | Field | Value |
   |---|---|
   | Publisher | GitHub Actions |
   | Organization or user | `<owner>` |
   | Repository | `<repo>` |
   | Workflow filename | the file name of the **calling** workflow, for example `publish.yml` |
   | Environment | `npm-publish` |

   npm checks the name of the calling workflow, not `npm-release.yml`. When a repository moves to
   this workflow, keep the file name of its current publish workflow, or update the trusted
   publisher.
4. Grant `contents: write` and `id-token: write` to the calling job, as in the examples. A called
   workflow cannot get more permissions than its caller.
5. Use a concurrency group with `cancel-in-progress: false` in the calling workflow. With `true`, a
   newer push cancels the running publish job too, possibly between `npm publish` and the tag.
   With `false` the runs queue: a newer run waits until the one before it is approved, rejected or
   cancelled by hand. The tarball artifact is kept for 14 days, the window for the approval.

The publish job can run again: a version that is on npm is not published again, and an existing
tag on the same commit is kept. A run that is cancelled during the publish job can thus be re-run.

## Versioning of this workflow

Pin the workflow in callers to a tag (`@v1`) or a full commit SHA. The jobs check out the scripts
of this repository at the commit of the called workflow file (the `job.workflow_repository` and
`job.workflow_sha` contexts), so the workflow and its scripts always match. These contexts are not
available on GitHub Enterprise Server.

## Security

- The check job runs the caller's build. It gets no secrets, and its token is read-only. It fails
  before the build when `npm-publish` has no required reviewer, so nothing is published without
  approval.
- The notify job holds the secrets. It runs only the scripts of this repository and does not check
  out the caller's code.
- The publish job runs only the scripts of this repository. It publishes the tarballs from the
  check job with `npm publish --ignore-scripts`.

## Development

```sh
npm install
npm test
```

[actionlint](https://github.com/rhysd/actionlint) checks the workflows. Version 1.7.12 does not
know `job.workflow_repository` and `job.workflow_sha` yet; `.github/actionlint.yaml` ignores those
two messages for `npm-release.yml`.

The scripts can run outside GitHub Actions, for example against another checkout:

```sh
npm run release:check -- --root ../my-repo --packages 'packages/*' --require-changelog
```

## License

MIT
