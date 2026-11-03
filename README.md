# release-tools

Bump the version and push. You get a Discord message, you approve, and the package is on npm with provenance. No npm token is stored anywhere.

<img src="media/release-flow.webp" alt="Animation: git push, the version check on npm, build and pack, the Discord message with the approve link and a Claude review, the approval, npm publish with provenance, and the tag" width="100%">

- **Version-driven**: a package is released when its `version` is not on npm yet. Any other push stops after the check.
- **Approval first**: publishing waits for you on the `npm-publish` environment, and publishes the tarballs that were built and checked before.
- **No npm tokens**: npm trusted publishing (OIDC), with a provenance statement for each version.
- **One package or a monorepo**: a root package, a subfolder, or all npm workspaces in dependency order; with `partial`, a monorepo publishes the packages that built when another one's build fails.
- **Release notes**: the `CHANGELOG.md` section of the version becomes the GitHub release.
- **Deploys too**: [`deploy.yml`](#deploys) runs the same check, notice, review and approval before a deploy command.

## The flow

<img src="media/release-flow-graph.png" alt="The seven steps: git push, check npm, build and pack, Discord asks you, you approve, npm publish with provenance and no npm token, tag" width="100%">

A version that is already on npm ends the run after the check. A failed check, build or pack posts a ❌ notice instead, and nothing is published.

## Discord notice

A release that waits for approval, or that fails, posts a message to your channel:

> 📦 repalash/ts-browser-helpers: **ts-browser-helpers@0.21.1** is built and waits for approval to publish to npm.<br>
> Approve: https://github.com/repalash/ts-browser-helpers/actions/runs/…<br>
> 🤖 Claude review: https://claude.ai/code/session_…<br>
> <br>
> \- `a1b2c3d` choose: default answer<br>
> \- `e4f5a6b` docs: README

> ❌ repalash/ts-browser-helpers: the check, build or pack of **ts-browser-helpers@0.21.1** failed; nothing is published.<br>
> Log: https://github.com/repalash/ts-browser-helpers/actions/runs/…<br>
> \- ts-browser-helpers@0.21.1: no CHANGELOG.md section

Any other failure of a release step (the check script, the notice itself, the publish after approval) posts the error with the log link:

> ❌ repalash/ts-browser-helpers: the release publish failed<br>
> Log: https://github.com/repalash/ts-browser-helpers/actions/runs/…

The list shows the commits since the previous release of the package. The Claude review line appears when a Claude Code routine is set up: the workflow starts a session that reviews the release while it waits for you.

## Quick start

1. Add the workflow, `.github/workflows/publish.yml`:

   ```yaml
   name: Publish to npm
   on:
     push:
       branches: [master]
     workflow_dispatch:
   permissions:
     contents: read
   concurrency:
     group: publish
     cancel-in-progress: false # never cancel a publish half-way
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

   `secrets: inherit` works when your repository and release-tools have the same owner. In a repository of another account or organization, pass the secrets by name, and set `review-actor` to your GitHub user (the default is `repalash`):

   ```yaml
       with:
         build: npm ci && npm test
         review-actor: <your-github-user>
       secrets:
         DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
         CLAUDE_REVIEW_FIRE_URL: ${{ secrets.CLAUDE_REVIEW_FIRE_URL }}
         CLAUDE_REVIEW_TOKEN: ${{ secrets.CLAUDE_REVIEW_TOKEN }}
   ```

   Without the secrets the release still works, with no Discord notice and no review.

2. Set up the repository once, before the first push: the `npm-publish` environment with you as required reviewer, the Discord and Claude secrets, and the npm trusted publisher. From a clone of this repository, one command does all three and is safe to run again:

   ```sh
   scripts/setup-repos.sh <owner>/<repo>:publish.yml:<npm-package>
   ```

3. Release: bump `version` in `package.json`, push, and open the link in Discord.

More callers (a package in a subfolder, workspaces, GitHub releases, a monorepo with partial releases and a deploy): [`examples/`](examples).

## Deploys

`deploy.yml` runs a deploy command after the same approval: a check with no secrets, the Discord notice with the
approval link, the Claude review and the commits since the last successful deployment, then the deploy in a GitHub
environment that requires you as reviewer.

```yaml
name: Deploy
on:
  push:
    branches: [production]
    paths: ['services/api/**']
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: false # never cancel a deploy half-way
jobs:
  deploy:
    permissions:
      contents: read
      deployments: read # the commits since the last deployment
    uses: repalash/release-tools/.github/workflows/deploy.yml@v1
    with:
      environment: production
      working-directory: services/api
      check: npm ci && npm test
      deploy: npm ci && npm run deploy
      secrets-env: CLOUDFLARE_API_TOKEN
    secrets: inherit
```

| Input | Default | |
|---|---|---|
| `environment` | (required) | The GitHub environment of the deploy. It must have a required reviewer, or the check stops. |
| `deploy` | (required) | Command run in `working-directory` after the approval. |
| `check` | | Command run in `working-directory` before the approval, with no secrets. |
| `working-directory` | `.` | The deployed project; the commit list covers it. |
| `secrets-env` | | Secrets the deploy command gets as environment variables, and the only ones it gets: a step of this repository puts them in the job's environment before your command runs. Put them on the environment, so only an approved run sees them. A missing one stops the deploy before it runs. |
| `name` | `<repository> (<environment>)` | What is deployed, in the notices. |
| `node-version` | `24` | Node.js for the check and the deploy. |
| `review-actor` | `repalash` | Only pushes by this user start the Claude review. |

The Discord and Claude secrets are the same as for releases. The review routine gets a request that starts with
`deploy review` (the release requests start with `npm release review`), so its instructions should cover both.

## Configuration

| Input | Default | |
|---|---|---|
| `packages` | `.` | Package directory, or `<dir>/*` for every package below it. Several: separate with spaces. `!<dir>` leaves directories out, with `*` in a segment: `. plugins/* !plugins/template-*`. |
| `build` | `npm ci` | Command run before packing. Empty: no build. |
| `package-build` | | Command run in each package directory of `packages`, in build order, after `build` (`npm run build`). |
| `post-build` | | Command run at the root after the builds that must succeed, also with `partial`: a type check of the result. |
| `node-version` | `24` | Node.js for the build. |
| `clean-package` | `false` | Pack with the package's [clean-package](https://www.npmjs.com/package/clean-package). |
| `require-changelog` | `false` | Fail when the version has no `CHANGELOG.md` section. |
| `tag-format` | `publish@{version}` | `{name}-{version}` when there are several packages. |
| `root-tag-format` | | The tag of the package at `.` when `packages` lists others too, like `v{version}`. Empty: `tag-format`. |
| `partial` | `false` | Publish what built (needs `package-build`): a package whose `package-build` fails, or whose tarball lacks a file its manifest points at (`main`, `module`, `types`, `exports`, `bin`), is left out with each package that depends on it. The notice lists them, the others are published. The notice and the publish both take what is left out from the tarballs. |
| `github-release` | `false` | A GitHub release with the tarball instead of a plain tag. |
| `review-actor` | `repalash` | Only pushes by this user start the Claude review. |

| Secret (optional) | |
|---|---|
| `DISCORD_WEBHOOK_URL` | Channel webhook for the notice. |
| `CLAUDE_REVIEW_FIRE_URL`, `CLAUDE_REVIEW_TOKEN` | Fire URL and token of the Claude Code routine. |

To rotate one secret in several repositories: `scripts/setup-repos.sh --set-secret CLAUDE_REVIEW_TOKEN <owner>/<repo> ...`

<details>
<summary><b>Details</b>: tags, changelog, prereleases, setup by hand, security</summary>

### Tags and changelog

- With a `/*` entry or several entries in `packages`, the tag format must contain `{name}`. The previous release is the latest tag in that format reachable from the commit. For a format without `{name}`, `v1.2.3` tags also count.
- A CHANGELOG section starts at a heading (`#` to `###`) whose first word is the version: `## [1.2.3] - 2026-01-01`, `## v1.2.3`, `# [1.2.3](link) (date)`. An empty section counts as missing.
- A prerelease (`1.0.0-beta.1`) gets the dist-tag `next`, unless `publishConfig.tag` sets another one, and a prerelease GitHub release.
- In workspaces, private packages are skipped, and `build` must build every package that the released ones need.
- Output: `release`, the JSON of the release (`packages` is empty when nothing was pending). GitHub empties a job output that contains a string it masks, which a changelog can mention, so the jobs of the workflow pass the JSON as the artifact `npm-release-plan` instead, and `release` can be empty.

### Setup by hand

1. Create the environment `npm-publish` with you as required reviewer: `https://github.com/<owner>/<repo>/settings/environments`. Do it before the first run: GitHub creates a missing environment without protection, so the check job stops when `npm-publish` has no required reviewer.
2. Optional: add the secrets at `https://github.com/<owner>/<repo>/settings/secrets/actions`.
3. Add a trusted publisher at `https://www.npmjs.com/package/<name>/access`: GitHub Actions, `<owner>`, `<repo>`, the file name of the **calling** workflow (for example `publish.yml`, not `npm-release.yml`), environment `npm-publish`.

The calling job must grant `contents: write` and `id-token: write`: a called workflow cannot get more permissions than its caller. With `cancel-in-progress: false`, runs queue: a newer run waits until the one before it is approved, rejected or cancelled. The tarballs are kept for 14 days, the window for the approval. A publish job can run again: a version that is on npm is not published again, and an existing tag on the same commit is kept.

### Security

- The check job runs your build with no secrets and a read-only token, and stops when `npm-publish` has no required reviewer.
- The notify job holds the secrets and runs only the scripts of this repository, never your code. The publish job gets only `DISCORD_WEBHOOK_URL`, for the notice that it failed.
- The publish job runs only the scripts of this repository and publishes the checked tarballs with `npm publish --ignore-scripts`.
- Deploys: the check job runs your check with no secrets and a read-only token; the notify job runs only these scripts (it reads your history for the commit list); after the approval, a script of this repository puts the secrets in `secrets-env` in the deploy job's environment, then your deploy command runs with those only; the notice of a failed deploy comes from a job of its own.
- Partial releases: the build runs your code, so a build could write anything; what the notice lists and what is published both come from the tarballs the check job uploaded, never from a list the build could rewrite.
- Pin callers to a tag (`@v1`) or a commit SHA. The jobs check out these scripts at the commit of the called workflow (`job.workflow_repository`, `job.workflow_sha`), so the workflow and its scripts always match. These contexts are not available on GitHub Enterprise Server.

### Development

`npm install && npm test`. [actionlint](https://github.com/rhysd/actionlint) checks the workflows; `.github/actionlint.yaml` ignores its messages about `job.workflow_repository` and `job.workflow_sha`, which version 1.7.12 does not know yet. The scripts also run locally: `npm run release:check -- --root ../my-repo --packages 'packages/*'`.

</details>

## Also in this repository

[`dts-js-extensions`](packages/dts-js-extensions): rewrites relative imports in emitted `.d.ts` files to explicit `.js` paths, for `moduleResolution: node16 | nodenext`.

Used by [threepipe](https://github.com/repalash/threepipe) (releases and the cloud deploy), [ts-browser-helpers](https://github.com/repalash/ts-browser-helpers), [uiconfig.js](https://github.com/repalash/uiconfig.js), [three-ts-types](https://github.com/repalash/three-ts-types), [three.js-modded](https://github.com/repalash/three.js-modded) and [tweakpane-image-plugin](https://github.com/repalash/tweakpane-image-plugin).

## License

MIT
