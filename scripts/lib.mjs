// Shared helpers for the npm-release workflow scripts. Pure functions are exported for the tests;
// the functions that touch the file system, git or the npm registry are marked as such.
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'

/**
 * Splits the `packages` input into entries. Entries are separated by whitespace or commas.
 * An entry is a directory (`.`, `types/three`) or a directory followed by `/*` (`packages/*`).
 * @param {string} input
 * @returns {string[]}
 */
export function parsePackagesInput (input) {
    const entries = String(input ?? '').split(/[\s,]+/).filter(Boolean)
    if (!entries.length) return ['.']
    for (const e of entries) {
        if (path.isAbsolute(e) || e.split('/').includes('..')) throw new Error(`packages: '${e}' must be a path inside the repository`)
        if (/[*?[\]{}]/.test(e.replace(/\/\*$/, ''))) throw new Error(`packages: '${e}' is not supported; use a directory or <directory>/*`)
    }
    return entries
}

/** True when the `packages` input lists more than one directory or uses a glob. */
export function isMultiPackageInput (input) {
    const entries = parsePackagesInput(input)
    return entries.length > 1 || entries.some(e => e.endsWith('/*'))
}

/**
 * The default tag format: `{name}-{version}` when the input can hold more than one package,
 * else `publish@{version}`.
 */
export function defaultTagFormat (input) {
    return isMultiPackageInput(input) ? '{name}-{version}' : 'publish@{version}'
}

/** Normalizes a relative directory to a posix path without a leading `./` (root is `.`). */
function normalizeDir (dir) {
    const n = path.posix.normalize(dir.replaceAll('\\', '/')).replace(/\/$/, '')
    return n === '' ? '.' : n
}

/**
 * Expands the entries of the `packages` input to package directories (file system).
 * A `<dir>/*` entry yields its subdirectories that contain a package.json, sorted by name.
 * A plain entry must contain a package.json.
 * @param {string} root repository root
 * @param {string[]} entries
 * @returns {string[]} directories relative to root
 */
export function expandPackageDirs (root, entries) {
    const dirs = []
    for (const entry of entries) {
        if (entry.endsWith('/*')) {
            const parent = normalizeDir(entry.slice(0, -2))
            const abs = path.join(root, parent)
            if (!fs.existsSync(abs)) throw new Error(`packages: '${parent}' does not exist`)
            const found = fs.readdirSync(abs, {withFileTypes: true})
                .filter(d => d.isDirectory() && fs.existsSync(path.join(abs, d.name, 'package.json')))
                .map(d => normalizeDir(path.posix.join(parent, d.name)))
                .sort()
            dirs.push(...found)
        } else {
            const dir = normalizeDir(entry)
            if (!fs.existsSync(path.join(root, dir, 'package.json'))) throw new Error(`packages: '${dir}' has no package.json`)
            dirs.push(dir)
        }
    }
    return [...new Set(dirs)]
}

/**
 * Sorts packages so that each one comes after the listed packages it depends on
 * (dependencies, peerDependencies, optionalDependencies and devDependencies).
 * Sets `internalDeps` on each package. Throws on a dependency cycle.
 * @template {{name: string, manifest: object}} P
 * @param {P[]} list
 * @returns {(P & {internalDeps: string[]})[]}
 */
export function sortByDependencies (list) {
    const byName = new Map(list.map(p => [p.name, p]))
    for (const p of list) {
        const m = p.manifest
        const deps = {...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies, ...m.devDependencies}
        p.internalDeps = Object.keys(deps).filter(d => byName.has(d) && d !== p.name)
    }
    const sorted = []
    const done = new Set()
    const visit = (p, stack) => {
        if (done.has(p)) return
        if (stack.includes(p)) throw new Error('Dependency cycle: ' + [...stack, p].map(x => x.name).join(' -> '))
        for (const d of p.internalDeps) visit(byName.get(d), [...stack, p])
        done.add(p)
        sorted.push(p)
    }
    for (const p of list) visit(p, [])
    return sorted
}

/**
 * Reads the packages of the `packages` input (file system), in build order.
 * @param {string} root
 * @param {string} input
 * @returns {{name: string, version: string, dir: string, private: boolean, manifest: object, internalDeps: string[]}[]}
 */
export function readPackages (root, input) {
    const list = expandPackageDirs(root, parsePackagesInput(input)).map(dir => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'))
        if (!manifest.name || !manifest.version) throw new Error(`${dir}/package.json has no name or version`)
        return {name: manifest.name, version: manifest.version, dir, private: !!manifest.private, manifest}
    })
    const names = new Map()
    for (const p of list) {
        if (names.has(p.name)) throw new Error(`Package name ${p.name} is in both ${names.get(p.name)} and ${p.dir}`)
        names.set(p.name, p.dir)
    }
    return sortByDependencies(list)
}

const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The CHANGELOG section of a version, or null when it is missing or empty.
 * A section starts at a heading (`#` to `###`) whose first word is the version, optionally in
 * brackets and with a `v` prefix: `## [1.2.3] - 2026-01-01`, `## v1.2.3`, `# [1.2.3](link) (date)`.
 * It ends at the next heading of the same or a higher level.
 * @param {string} text
 * @param {string} version
 * @returns {string|null}
 */
export function changelogEntry (text, version) {
    const lines = String(text).split(/\r?\n/)
    const head = new RegExp(`^(#{1,3})[ \\t]+\\[?v?${escapeRE(version)}\\]?(?=$|[\\s(])`)
    const start = lines.findIndex(l => head.test(l))
    if (start < 0) return null
    const level = lines[start].match(/^#+/)[0].length
    const body = []
    for (const line of lines.slice(start + 1)) {
        const h = line.match(/^(#{1,6})[ \t]/)
        if (h && h[1].length <= level) break
        body.push(line)
    }
    const entry = body.join('\n').trim()
    return entry || null
}

/** Reads the CHANGELOG.md section of a package version (file system), or null. */
export function readChangelogEntry (root, dir, version) {
    const file = path.join(root, dir, 'CHANGELOG.md')
    return fs.existsSync(file) ? changelogEntry(fs.readFileSync(file, 'utf8'), version) : null
}

/**
 * Checks a tag format: it must contain `{version}`, and `{name}` when more than one package
 * can be released with it.
 */
export function validateTagFormat (format, multiPackage) {
    if (!format.includes('{version}')) throw new Error(`tag-format '${format}' must contain {version}`)
    if (multiPackage && !format.includes('{name}')) throw new Error(`tag-format '${format}' must contain {name} when packages lists more than one package`)
}

/** The release tag of a package version: `{name}` and `{version}` replaced. */
export function formatTag (format, {name, version}) {
    return format.replaceAll('{name}', name).replaceAll('{version}', version)
}

/**
 * The `git describe --match` patterns that find the previous release tag of a package.
 * A format without `{name}` (single package) also matches the common `v1.2.3` tags.
 */
export function tagMatchPatterns (format, name) {
    const own = format.replaceAll('{name}', name).replaceAll('{version}', '[0-9]*')
    return format.includes('{name}') ? [own] : [own, 'v[0-9]*']
}

/** True for a semver prerelease version (`1.0.0-beta.1`; build metadata after `+` is ignored). */
export function isPrerelease (version) {
    return /^[^+]*-/.test(version)
}

/** The npm dist-tag to publish with: publishConfig.tag, else `next` for a prerelease, else '' (npm's `latest`). */
export function distTag (manifest) {
    if (manifest.publishConfig?.tag) return manifest.publishConfig.tag
    return isPrerelease(manifest.version) ? 'next' : ''
}

/** The tarball file name that `npm pack` gives a package version. */
export function tarballName (name, version) {
    return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

/** True when this exact version is on the npm registry (network). */
export function isPublished (name, version) {
    try {
        const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
        return out !== '' && JSON.parse(out) === version
    } catch (e) {
        // A missing package or version is E404. With --json (or a silent log level) the error is
        // a JSON object on stdout, else it is on stderr.
        const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
        if (/\bE404\b|404 Not Found/.test(output)) return false
        throw new Error(`npm view ${name}@${version} failed: ${output.trim() || e.message}`)
    }
}

/** The previous release tag reachable from HEAD, or '' (git). */
export function previousTag (root, patterns) {
    try {
        return execFileSync('git', ['describe', '--tags', '--abbrev=0', ...patterns.flatMap(p => ['--match', p]), 'HEAD'],
            {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
    } catch {
        return ''
    }
}

/** Up to `limit` non-merge commits that touch `dir` since `prev` (or all), as `git log --oneline` lines (git). */
export function commitsSince (root, prev, dir, limit = 20) {
    try {
        const out = execFileSync('git', ['log', '--oneline', '--no-merges', `-${limit}`, prev ? `${prev}..HEAD` : 'HEAD', '--', dir],
            {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
        return out ? out.split('\n') : []
    } catch {
        return []
    }
}

/** Splits a `git log --oneline` line into its short hash and subject. */
export function splitCommit (line) {
    const i = line.indexOf(' ')
    return i < 0 ? {hash: line, subject: ''} : {hash: line.slice(0, i), subject: line.slice(i + 1)}
}

/** `name@version` with the dist-tag when it is not `latest`. */
function label (p) {
    return `${p.name}@${p.version}${p.distTag ? ` (dist-tag ${p.distTag})` : ''}`
}

/**
 * The text of the review request sent to the Claude Code routine.
 * @param {{repository: string, sha: string, runUrl: string, packages: object[]}} release
 */
export function reviewText ({repository, sha, runUrl, packages}) {
    const lines = [
        'npm release review',
        `repository: ${repository}`,
        `commit: ${sha}`,
        `run (approval pending): ${runUrl}`,
        `packages (${packages.length}, in publish order):`,
    ]
    for (const p of packages) {
        lines.push(`- ${label(p)}`, `  directory: ${p.dir}`, `  release tag: ${p.tag}`, `  previous release tag: ${p.previousTag || 'none'}`)
        if (p.commits.length) lines.push('  commits since the previous release:', ...p.commits.map(c => `    ${c}`))
        else lines.push('  commits since the previous release: none')
    }
    return lines.join('\n') + '\n'
}

/**
 * The Discord notice: the packages wait for approval, or the run failed.
 * @param {{ok: boolean, repository: string, runUrl: string, packages: object[], errors?: string[], session?: string}} n
 * @returns {string} at most 2000 characters (the Discord limit)
 */
export function discordText ({ok, repository, runUrl, packages, errors = [], session = ''}) {
    const names = packages.map(p => `**${label(p)}**`).join(', ')
    const lines = ok
        ? [`📦 ${repository}: ${names} ${packages.length > 1 ? 'are' : 'is'} built and ${packages.length > 1 ? 'wait' : 'waits'} for approval to publish to npm.`, `Approve: ${runUrl}`]
        : [`❌ ${repository}: the check, build or pack of ${names || 'the release'} failed; nothing is published.`, `Log: ${runUrl}`]
    if (!ok && errors.length) lines.push(...errors.map(e => `- ${e}`))
    if (ok && session) lines.push(`🤖 Claude review: ${session}`)
    for (const p of packages) {
        if (!p.commits?.length) continue
        if (packages.length > 1) lines.push('', `${p.name}:`)
        else lines.push('')
        lines.push(...p.commits.map(c => {
            const {hash, subject} = splitCommit(c)
            return `- \`${hash}\` ${subject}`
        }))
    }
    const text = lines.join('\n')
    return text.length > 2000 ? text.slice(0, 1990) + '\n…' : text
}

/** The body of the routine fire request. */
export function firePayload (text) {
    return {text}
}

/**
 * Whether to start the Claude review: the build succeeded, the run is a push by the review actor,
 * and both routine secrets are set. Returns the reason when not.
 * @returns {{fire: boolean, reason: string}}
 */
export function reviewEligible ({buildOk, event, actor, reviewActor, url, token}) {
    if (!buildOk) return {fire: false, reason: 'the build failed'}
    if (!url || !token) return {fire: false, reason: 'no review routine is set up (CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN)'}
    if (event !== 'push') return {fire: false, reason: `the event is ${event}, not push`}
    if (!reviewActor || actor !== reviewActor) return {fire: false, reason: `the actor ${actor} is not the review actor`}
    return {fire: true, reason: ''}
}

/** Appends `key=value` lines to $GITHUB_OUTPUT (single-line values only). No-op outside GitHub Actions. */
export function setOutputs (values) {
    const file = process.env.GITHUB_OUTPUT
    if (!file) return
    const lines = Object.entries(values).map(([k, v]) => {
        const s = String(v)
        if (s.includes('\n')) throw new Error(`output ${k} must be a single line`)
        return `${k}=${s}\n`
    })
    fs.appendFileSync(file, lines.join(''))
}

/** Parses the RELEASE JSON that check.mjs writes. */
export function parseRelease (json) {
    const release = JSON.parse(json || '{}')
    if (!Array.isArray(release.packages)) throw new Error('RELEASE has no packages array')
    return release
}
