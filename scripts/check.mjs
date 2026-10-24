// Lists the packages to publish: public packages of the `packages` input whose version is not on
// npm, in build order (a package after the listed packages it depends on). With
// --require-changelog, each of them needs a CHANGELOG.md section for its version.
//
// Usage: node check.mjs [--root <dir>] [--packages <input>] [--tag-format <format>] [--require-changelog]
// The options fall back to the env vars PACKAGES, TAG_FORMAT and REQUIRE_CHANGELOG ('true').
//
// GitHub outputs:
//   pending=true|false  there are packages to publish (also set when the changelog check fails)
//   release=<JSON>      {repository, sha, runUrl, packages: [...], errors: [...]}
// Exits 1 when a changelog section is missing.
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import {
    commitsSince, defaultTagFormat, distTag, formatTag, isMultiPackageInput, isPrerelease, isPublished,
    previousTag, readChangelogEntry, readPackages, setOutputs, tagMatchPatterns, tarballName, validateTagFormat,
} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'root': {type: 'string', default: '.'},
        'packages': {type: 'string', default: process.env.PACKAGES || '.'},
        'tag-format': {type: 'string', default: process.env.TAG_FORMAT || ''},
        'require-changelog': {type: 'boolean', default: process.env.REQUIRE_CHANGELOG === 'true'},
    },
})

const root = path.resolve(args.root)
const input = args.packages
const format = args['tag-format'] || defaultTagFormat(input)
validateTagFormat(format, isMultiPackageInput(input))

const {GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA} = process.env
const release = {
    repository: GITHUB_REPOSITORY || path.basename(root),
    sha: GITHUB_SHA || '',
    runUrl: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : '',
    packages: [],
    errors: [],
}

console.log(`Packages: ${input}; tag format: ${format}${args['require-changelog'] ? '; CHANGELOG entry required' : ''}`)
for (const p of readPackages(root, input)) {
    if (p.private) {
        console.log(`  ${p.name} (${p.dir}) is private; skipped`)
        continue
    }
    if (isPublished(p.name, p.version)) {
        console.log(`  ${p.name}@${p.version} is on npm`)
        continue
    }
    const changelog = readChangelogEntry(root, p.dir, p.version)
    if (args['require-changelog'] && !changelog) {
        release.errors.push(`${p.name}@${p.version}: no section for ${p.version} in ${path.posix.join(p.dir, 'CHANGELOG.md')}`)
    }
    const prev = previousTag(root, tagMatchPatterns(format, p.name))
    release.packages.push({
        name: p.name,
        version: p.version,
        dir: p.dir,
        tag: formatTag(format, p),
        distTag: distTag(p.manifest),
        prerelease: isPrerelease(p.version),
        tarball: tarballName(p.name, p.version),
        previousTag: prev,
        commits: commitsSince(root, prev, p.dir),
        changelog: changelog ? changelog.slice(0, 20000) : '',
    })
    console.log(`→ ${p.name}@${p.version} is not on npm (tag ${formatTag(format, p)}, previous ${prev || 'none'})`)
}

const pending = release.packages.length > 0
setOutputs({pending, release: JSON.stringify(release)})

if (process.env.GITHUB_STEP_SUMMARY && pending) {
    const rows = release.packages.map(p => `| ${p.name} | ${p.version} | ${p.distTag || 'latest'} | \`${p.tag}\` | ${p.commits.length} |`)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        ['### Packages to publish', '', '| package | version | dist-tag | tag | commits |', '|---|---|---|---|---|', ...rows, ''].join('\n'))
}

if (release.errors.length) {
    console.error('\n' + release.errors.join('\n'))
    process.exit(1)
}
console.log(pending ? `\n${release.packages.length} package(s) to publish.` : '\nNothing to publish.')
