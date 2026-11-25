// Publishes the tarballs of the release (the JSON from check.mjs: file RELEASE_FILE or env RELEASE) in the listed order,
// then marks each published commit: a GitHub release with the tarball (--github-release) or a tag.
//
// - Authentication is npm trusted publishing (OIDC): the job needs `id-token: write`, npm >= 11.5.1.
// - `npm publish <tarball> --provenance --access public --ignore-scripts`, with `--tag <dist-tag>`
//   for a prerelease (`next`) or a package that sets publishConfig.tag.
// - A version that is on npm already is not published again, so a re-run continues a partial release. Its tag and
//   GitHub release go on the commit that its npm provenance names, the commit of the run that published it (two
//   queued runs that both listed the version), not on this run's commit.
// - The first publish failure stops the run: a package is never published without the listed
//   packages it depends on. Tag and release failures are collected and fail the run at the end.
// - Tags and releases use the GitHub API through `gh` (env GH_TOKEN, `contents: write`).
// - --partial: a package with no tarball (pack.mjs left it out) is skipped, and so is each package that depends on a
//   skipped one; the others are published.
//
// Usage: node publish.mjs --tarballs <dir> [--github-release] [--partial] [--dry-run]
// --dry-run runs `npm publish --dry-run` and prints the GitHub commands instead of running them.
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {isPublished, parseRelease, provenanceCommit, readRelease, tagAction, tarballPlan} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'tarballs': {type: 'string'},
        'github-release': {type: 'boolean', default: process.env.GITHUB_RELEASE === 'true'},
        'partial': {type: 'boolean', default: process.env.PARTIAL === 'true'},
        'dry-run': {type: 'boolean', default: false},
    },
})
if (!args.tarballs) throw new Error('--tarballs is required')

const release = parseRelease(readRelease())
const dryRun = args['dry-run']
const repo = process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
if (!dryRun && (!repo || !sha)) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA must be set')

const run = (cmd, argv) => execFileSync(cmd, argv, {stdio: 'inherit'})
const ok = (cmd, argv) => {
    try {
        execFileSync(cmd, argv, {stdio: 'ignore'})
        return true
    } catch {
        return false
    }
}
const gh = argv => {
    if (dryRun) console.log(`[dry run] gh ${argv.join(' ')}`)
    else run('gh', argv)
}

function checkNpmVersion () {
    const v = execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim()
    const [a, b, c] = v.split('.').map(Number)
    if (a < 11 || (a === 11 && (b < 5 || (b === 5 && c < 1)))) {
        throw new Error(`npm ${v} cannot use trusted publishing; it needs npm 11.5.1 or later`)
    }
}

function releaseNotes (p) {
    if (p.changelog) return p.changelog
    if (p.commits.length) return [`Commits since ${p.previousTag || 'the start'}:`, '', ...p.commits.map(c => `- ${c}`)].join('\n')
    return ''
}

async function markRelease (p, tarball, publishedBefore) {
    // a version on npm before this run belongs on the commit that published it (its provenance), not on this one
    const publishedCommit = publishedBefore ? await provenanceCommit(p.name, p.version) : ''
    if (args['github-release']) {
        if (!dryRun && ok('gh', ['release', 'view', p.tag, '--repo', repo])) {
            console.log(`The GitHub release ${p.tag} exists; skipped`)
            return
        }
        const notes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'notes.md')
        fs.writeFileSync(notes, releaseNotes(p))
        gh(['release', 'create', p.tag, tarball, '--repo', repo, '--target', publishedCommit || sha, '--title', `${p.name}@${p.version}`,
            '--notes-file', notes, ...(p.prerelease ? ['--prerelease'] : [])])
        console.log(`✓ GitHub release ${p.tag}`)
        return
    }
    let target = publishedCommit || sha
    if (!dryRun) {
        let existing = ''
        try {
            existing = execFileSync('gh', ['api', `repos/${repo}/git/ref/tags/${p.tag}`, '--jq', '.object.sha'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
        } catch { /* the tag does not exist */ }
        const t = tagAction({existing, sha, publishedBefore, publishedCommit, tag: p.tag})
        if (t.action === 'skip') {
            if (t.unverified) console.log(`::warning::The tag ${p.tag} is on ${existing}; kept, as ${p.name}@${p.version} has no provenance that names the commit it was built from`)
            else console.log(`The tag ${p.tag} exists on ${existing}${existing === sha ? '' : ', the commit that published it'}; skipped`)
            return
        }
        target = t.target
    }
    gh(['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${p.tag}`, '-f', `sha=${target}`, '--silent'])
    console.log(`✓ Tag ${p.tag}${target === sha ? '' : ` on ${target}, the commit that published it`}`)
}

if (!dryRun) checkNpmVersion()
let packages = release.packages
if (args.partial) {
    const plan = tarballPlan(packages, path.resolve(args.tarballs))
    for (const s of plan.skipped) console.log(`${s.name}: skipped, ${s.reason}`)
    packages = plan.publish
}
const markErrors = []
for (const p of packages) {
    const tarball = path.resolve(args.tarballs, p.tarball)
    if (!fs.existsSync(tarball)) throw new Error(`${p.tarball} is not in ${args.tarballs}`)
    const publishedBefore = !dryRun && isPublished(p.name, p.version)
    if (publishedBefore) {
        console.log(`\n${p.name}@${p.version} is on npm already; not published again`)
    } else {
        console.log(`\nPublishing ${p.name}@${p.version}${p.distTag ? ` with dist-tag ${p.distTag}` : ''}`)
        run('npm', ['publish', tarball, '--access', 'public', '--ignore-scripts',
            ...(dryRun ? ['--dry-run'] : ['--provenance']),
            ...(p.distTag ? ['--tag', p.distTag] : [])])
        console.log(`✓ ${p.name}@${p.version}${dryRun ? ' (dry run)' : ''}`)
    }
    try {
        await markRelease(p, tarball, publishedBefore)
    } catch (e) {
        console.error(`! ${p.name}@${p.version} is published, but ${p.tag} was not created: ${e.message}`)
        markErrors.push(p.tag)
    }
}
if (markErrors.length) {
    console.error(`\nCreate these tags by hand on ${sha}: ${markErrors.join(', ')}`)
    process.exit(1)
}
