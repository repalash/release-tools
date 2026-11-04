// Shared helpers for the npm-release workflow scripts. Pure functions are exported for the tests;
// the functions that touch the file system, git or the npm registry are marked as such.
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'

/**
 * Splits the `packages` input into entries. Entries are separated by whitespace or commas.
 * An entry is a directory (`.`, `types/three`) or a directory followed by `/*` (`packages/*`).
 * An entry starting with `!` leaves out the directories it matches, where `*` stands for any part of
 * one path segment (`!packages/template-*`), as in npm workspaces.
 * @param {string} input
 * @returns {string[]}
 */
export function parsePackagesInput (input) {
    const entries = String(input ?? '').split(/[\s,]+/).filter(Boolean)
    if (!entries.filter(e => !e.startsWith('!')).length) entries.unshift('.')
    for (const entry of entries) {
        const exclude = entry.startsWith('!')
        const e = exclude ? entry.slice(1) : entry
        if (!e || path.isAbsolute(e) || e.split('/').includes('..')) throw new Error(`packages: '${entry}' must be a path inside the repository`)
        const unsupported = exclude ? /\*\*|[?[\]{}]/.test(e) : /[*?[\]{}]/.test(e.replace(/\/\*$/, ''))
        if (unsupported) throw new Error(`packages: '${entry}' is not supported; use a directory, <directory>/*, or !<directory> with * in a segment`)
    }
    return entries
}

/** True when the `packages` input lists more than one directory or uses a glob. */
export function isMultiPackageInput (input) {
    const entries = parsePackagesInput(input).filter(e => !e.startsWith('!'))
    return entries.length > 1 || entries.some(e => e.endsWith('/*'))
}

/** A test for the directories an exclusion entry (`!dir`, `!dir/prefix-*`) leaves out. */
function excludeTest (entry) {
    const pattern = normalizeDir(entry.slice(1)).split('*').map(escapeRE).join('[^/]*')
    const re = new RegExp(`^${pattern}$`)
    return dir => re.test(dir)
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
    const excluded = entries.filter(e => e.startsWith('!')).map(excludeTest)
    for (const entry of entries.filter(e => !e.startsWith('!'))) {
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
    return [...new Set(dirs)].filter(dir => !excluded.some(test => test(dir)))
}

/**
 * Sorts packages so that each one comes after the listed packages it depends on
 * (dependencies, peerDependencies, optionalDependencies and devDependencies).
 * Sets `internalDeps` on each package (all four kinds: the build order) and `runtimeDeps` (without devDependencies:
 * what a published package needs, for partial releases). Throws on a dependency cycle.
 * @template {{name: string, manifest: object}} P
 * @param {P[]} list
 * @returns {(P & {internalDeps: string[], runtimeDeps: string[]})[]}
 */
export function sortByDependencies (list) {
    const byName = new Map(list.map(p => [p.name, p]))
    for (const p of list) {
        const m = p.manifest
        const runtime = {...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies}
        const internal = names => Object.keys(names).filter(d => byName.has(d) && d !== p.name)
        p.internalDeps = internal({...runtime, ...m.devDependencies})
        p.runtimeDeps = internal(runtime)
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
 * @returns {{name: string, version: string, dir: string, private: boolean, manifest: object, internalDeps: string[], runtimeDeps: string[]}[]}
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

/**
 * The tag format of a package: `rootFormat` for the package at the repository root when it is set
 * (a monorepo whose root package keeps `v{version}` tags), else `format`.
 */
export function tagFormatFor (dir, format, rootFormat = '') {
    return dir === '.' && rootFormat ? rootFormat : format
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

/** The exports conditions a consumer resolves; others (`source`, `development`, custom ones) may point outside `files`. */
const RUNTIME_CONDITIONS = new Set(['import', 'require', 'default', 'node', 'browser', 'module', 'types', 'deno', 'worker', 'module-sync'])

/**
 * The files a package's manifest points at, as Node resolves them: `main` and `browser` with the legacy lookup (the path,
 * or with `.js`, or `/index.js`; `.` is `index.js`), as alternatives of one group; `module`, `types`, `typings`, `bin`
 * and the `exports` targets of the conditions consumers resolve exactly. In an exports fallback array the first target
 * that is a path counts (Node does not go on to the next one when that file is missing). Targets with `*` and
 * directory targets (ending in `/`) are left out. A group is there when one of its paths is.
 * @param {object} manifest
 * @returns {string[][]} sorted by their first path
 */
export function entryTargets (manifest) {
    const groups = new Map()
    const exact = v => [path.posix.normalize(v).replace(/^\.\//, '')]
    const legacy = v => {
        const n = exact(v)[0]
        return n === '.' || n === '' ? ['index.js'] : [n, `${n}.js`, `${n}/index.js`]
    }
    const usable = v => typeof v === 'string' && !v.includes('*') && !v.endsWith('/')
    const group = paths => groups.set(paths.join('|'), paths)
    const condition = k => k.startsWith('.') || RUNTIME_CONDITIONS.has(k)
    const add = v => {
        if (Array.isArray(v)) {
            // the first target Node can use: a path, or a condition object (resolved as one)
            const first = v.find(x => typeof x === 'string' ? x.startsWith('./') : x && typeof x === 'object')
            if (first !== undefined) add(first)
        } else if (usable(v)) {
            group(exact(v))
        } else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) if (condition(k)) add(x)
        }
    }
    for (const k of ['main', 'browser']) if (usable(manifest[k])) group(legacy(manifest[k]))
    for (const k of ['module', 'types', 'typings']) if (usable(manifest[k])) group(exact(manifest[k]))
    if (usable(manifest.bin)) group(exact(manifest.bin))
    else if (manifest.bin && typeof manifest.bin === 'object') for (const x of Object.values(manifest.bin)) if (usable(x)) group(exact(x))
    add(manifest.exports)
    // a legacy group whose path is also required exactly says nothing more
    const all = [...groups.values()]
    return all.filter(g => g.length === 1 || !groups.has(g[0])).sort((a, b) => a[0].localeCompare(b[0]))
}

/** The entry targets (entryTargets) not in a tarball, given its file list (`package/…` paths), by their first path. */
export function missingEntries (manifest, tarballFiles) {
    const files = new Set(tarballFiles.map(f => f.replace(/^package\//, '')))
    return entryTargets(manifest).filter(g => !g.some(f => files.has(f))).map(g => g[0])
}

/**
 * The first of the listed packages a published package needs (runtimeDeps: not its devDependencies; internalDeps for
 * a release JSON written before runtimeDeps) that is in `out`, or undefined.
 */
export function blockingDep (p, out) {
    return (p.runtimeDeps ?? p.internalDeps ?? []).find(d => out.has(d))
}

/**
 * The packages to build for a release: the released ones (`names`) and the listed packages they need, transitively.
 * @param {{name: string, internalDeps: string[]}[]} list every package of the input
 * @param {Iterable<string>} names
 * @returns {Set<string>}
 */
export function buildClosure (list, names) {
    const byName = new Map(list.map(p => [p.name, p]))
    const need = new Set()
    const visit = n => {
        if (need.has(n) || !byName.has(n)) return
        need.add(n)
        for (const d of byName.get(n).internalDeps) visit(d)
    }
    for (const n of names) visit(n)
    return need
}

/**
 * The packages of a release that can be published, in order, given which ones have a tarball (`built`): a package
 * without a tarball is left out, and so is each package that depends on one left out (internalDeps).
 * @param {{name: string, internalDeps?: string[]}[]} packages in publish order
 * @param {Set<string>} built the names with a tarball
 * @returns {{publish: object[], skipped: {name: string, reason: string}[]}}
 */
export function partialPlan (packages, built) {
    const publish = []
    const skipped = []
    const out = new Set()
    for (const p of packages) {
        const dep = blockingDep(p, out)
        if (!built.has(p.name) || dep) {
            out.add(p.name)
            skipped.push({name: p.name, reason: dep ? `depends on ${dep}, which is not published` : 'not built'})
        } else {
            publish.push(p)
        }
    }
    return {publish, skipped}
}

/** partialPlan from the tarballs in `dir` (file system): what publish.mjs publishes, and what the notice lists. */
export function tarballPlan (packages, dir) {
    if (!fs.existsSync(dir)) throw new Error(`the tarballs are not in ${dir}`)
    return partialPlan(packages, new Set(packages.filter(p => fs.existsSync(path.join(dir, p.tarball))).map(p => p.name)))
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

/** Up to `limit` non-merge commits that touch `dir` from `from` (exclusive; '' for the last `limit`) to `to` (git). */
export function commitsBetween (root, from, to, dir, limit = 20) {
    try {
        const out = execFileSync('git', ['log', '--oneline', '--no-merges', `-${limit}`, from ? `${from}..${to}` : to, '--', dir],
            {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
        return out ? out.split('\n') : []
    } catch {
        return []
    }
}

/** Up to `limit` non-merge commits that touch `dir` since `prev` (or all), as `git log --oneline` lines (git). */
export function commitsSince (root, prev, dir, limit = 20) {
    return commitsBetween(root, prev, 'HEAD', dir, limit)
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
export function reviewText ({repository, sha, runUrl, packages}, failed = []) {
    const gone = new Set(failed.map(f => f.name))
    const lines = [
        'npm release review',
        `repository: ${repository}`,
        `commit: ${sha}`,
        `run (approval pending): ${runUrl}`,
        `packages (${packages.length - gone.size}, in publish order):`,
    ]
    for (const p of packages.filter(x => !gone.has(x.name))) {
        lines.push(`- ${label(p)}`, `  directory: ${p.dir}`, `  release tag: ${p.tag}`, `  previous release tag: ${p.previousTag || 'none'}`)
        if (p.commits.length) lines.push('  commits since the previous release:', ...p.commits.map(c => `    ${c}`))
        else lines.push('  commits since the previous release: none')
    }
    if (failed.length) lines.push('not built, left out of this release:', ...failed.map(f => `- ${f.name}@${f.version}: ${f.error}`))
    return lines.join('\n') + '\n'
}

/**
 * The text of the review request for a deploy (deploy.yml).
 * @param {{repository: string, sha: string, runUrl: string, environment: string, name: string, workingDirectory: string, previous: string, commits: string[]}} d
 */
export function deployReviewText ({repository, sha, runUrl, environment, name, workingDirectory, previous, commits}) {
    return [
        'deploy review',
        `repository: ${repository}`,
        `what: ${name}`,
        `directory: ${workingDirectory}`,
        `environment: ${environment}`,
        `commit: ${sha}`,
        `deployed before: ${previous || 'none'}`,
        `run (approval pending): ${runUrl}`,
        ...commits.length ? ['commits since the last deploy:', ...commits.map(c => `  ${c}`)] : ['commits since the last deploy: none'],
    ].join('\n') + '\n'
}

/**
 * The Discord notice of a deploy (deploy.yml). state: `waiting` (checked, waits for approval), `check-failed`
 * (nothing is deployed) or `deploy-failed` (after the approval).
 * @returns {string} at most 2000 characters (the Discord limit)
 */
export function deployDiscordText ({state, repository, runUrl, environment, name, sha, commits = [], session = ''}) {
    const what = `**${name}** \`${sha.slice(0, 7)}\``
    const ok = state === 'waiting'
    const lines = ok
        ? [`🚀 ${repository}: ${what} is checked and waits for approval to deploy (${environment}).`, `Approve: ${runUrl}`]
        : state === 'check-failed'
            ? [`❌ ${repository}: the check of ${what} failed; nothing is deployed.`, `Log: ${runUrl}`]
            : [`❌ ${repository}: the deploy of ${what} (${environment}) failed after the approval.`, `Log: ${runUrl}`]
    if (ok && session) lines.push(`🤖 Claude review: ${session}`)
    if (ok && commits.length) {
        lines.push('', ...commits.map(c => {
            const {hash, subject} = splitCommit(c)
            return `- \`${hash}\` ${subject}`
        }))
    }
    const text = lines.join('\n')
    return text.length > 2000 ? text.slice(0, 1990) + '\n…' : text
}

/**
 * The Discord notice: the packages wait for approval, or the run failed. A partial release lists the packages it
 * leaves out (`failed`: {name, version, error}).
 * @param {{ok: boolean, repository: string, runUrl: string, packages: object[], errors?: string[], failed?: object[], session?: string}} n
 * @returns {string} at most 2000 characters (the Discord limit)
 */
export function discordText ({ok, repository, runUrl, packages, errors = [], failed = [], session = ''}) {
    // failed: the packages a partial release leaves out ({name, version, error}); the others are built
    const gone = new Set(failed.map(f => f.name))
    const built = packages.filter(p => !gone.has(p.name))
    const names = (ok ? built : packages).map(p => `**${label(p)}**`).join(', ')
    const lines = ok
        ? [`📦 ${repository}: ${names} ${built.length > 1 ? 'are' : 'is'} built and ${built.length > 1 ? 'wait' : 'waits'} for approval to publish to npm.`, `Approve: ${runUrl}`]
        : [`❌ ${repository}: the check, build or pack of ${names || 'the release'} failed; nothing is published.`, `Log: ${runUrl}`]
    if (failed.length) lines.push(`${ok ? '⚠️ Not built, not published' : 'Not built'}:`, ...failed.map(f => `- ${f.name}@${f.version}: ${f.error}`))
    if (!ok && errors.length) lines.push(...errors.map(e => `- ${e}`))
    if (ok && session) lines.push(`🤖 Claude review: ${session}`)
    const listed = ok ? built : packages
    for (const p of listed) {
        if (!p.commits?.length) continue
        if (listed.length > 1) lines.push('', `${p.name}:`)
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
    if (!json) throw new Error('the release JSON is missing (RELEASE_FILE or RELEASE)')
    const release = JSON.parse(json)
    if (!Array.isArray(release.packages)) throw new Error('the release JSON has no packages array')
    return release
}

/** The release JSON text: the file RELEASE_FILE when it exists, else env RELEASE, else ''. */
export function readRelease (env = process.env) {
    if (env.RELEASE_FILE && fs.existsSync(env.RELEASE_FILE)) return fs.readFileSync(env.RELEASE_FILE, 'utf8')
    return env.RELEASE || ''
}

/**
 * The Discord notice for a release step that failed without its own notice: the check script, the
 * notice itself, or the publish after approval. Reads only the GitHub Actions defaults, not RELEASE.
 * @returns {string} at most 2000 characters (the Discord limit)
 */
export function failureText ({step, error = '', what = 'release', env = process.env}) {
    const {GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID} = env
    // the error is cut, not the log link
    const detail = error.length > 1500 ? `: ${error.slice(0, 1500)}…` : error ? `: ${error}` : ''
    return `❌ ${GITHUB_REPOSITORY}: the ${what} ${step} failed${detail}\nLog: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

/**
 * The secrets named in `names` (spaces or commas) from the `secrets` context as JSON, for a command's environment.
 * Throws when one is missing or empty, so a deploy never runs half configured.
 * @param {Record<string, string>} secrets
 * @param {string} names
 * @returns {Record<string, string>}
 */
export function pickSecrets (secrets, names) {
    const list = String(names ?? '').split(/[\s,]+/).filter(Boolean)
    const missing = list.filter(n => !secrets[n])
    if (missing.length) throw new Error(`missing secret(s): ${missing.join(', ')} (set them on the environment or the repository)`)
    return Object.fromEntries(list.map(n => [n, secrets[n]]))
}

/** Posts a message to a Discord webhook, with no mentions (network). Throws when Discord refuses it. */
export async function postDiscord (url, content) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content, allowed_mentions: {parse: []}}),
    })
    if (!res.ok) throw new Error(`Discord webhook: HTTP ${res.status}`)
}

/**
 * Starts a Claude Code routine session with `text` (network). Returns its URL, or '' when the request failed (logged:
 * a review is optional and never fails a release or a deploy).
 */
export async function fireReview ({url, token, text}) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${token}`,
                'anthropic-beta': 'experimental-cc-routine-2026-04-01',
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify(firePayload(text)),
        })
        const body = await res.json().catch(() => ({}))
        if (res.ok && body.claude_code_session_url) {
            console.log(`Claude review session: ${body.claude_code_session_url}`)
            return body.claude_code_session_url
        }
        console.log(`Claude review request failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`)
    } catch (e) {
        console.log(`Claude review request failed: ${e.message}`)
    }
    return ''
}

/**
 * The commit of the last successful deployment to a GitHub environment, or '' (network, `gh`; the job needs
 * `deployments: read`). GitHub records a deployment for each job that runs in an environment; one that succeeded has
 * a SUCCESS status (a later one marks it inactive, a cancelled or rejected one never had it).
 */
export function lastDeployedSha (repository, environment) {
    const [owner, name] = repository.split('/')
    const query = `query($owner: String!, $name: String!, $env: String!) { repository(owner: $owner, name: $name) {
        deployments(environments: [$env], first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { commitOid statuses(first: 20) { nodes { state } } } } } }`
    try {
        const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `env=${environment}`,
            '--jq', '[.data.repository.deployments.nodes[] | select(any(.statuses.nodes[]; .state == "SUCCESS"))][0].commitOid // ""'],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
        return out.trim()
    } catch (e) {
        console.log(`The last deployment could not be read: ${String(e.stderr || e.message).split('\n')[0]}`)
        return ''
    }
}

/** True when `sha` is a commit in the clone at `root` (git). */
export function hasCommit (root, sha) {
    try {
        execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {cwd: root, stdio: 'ignore'})
        return true
    } catch {
        return false
    }
}

