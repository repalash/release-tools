import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    changelogEntry, defaultTagFormat, deployDiscordText, deployReviewText, discordText, distTag, entryFiles, firePayload,
    formatTag, hasCommit, isMultiPackageInput, failureText, isPrerelease, missingEntries, parsePackagesInput, partialPlan, pickSecrets,
    readPackages, readRelease, reviewEligible, reviewText, sortByDependencies, splitCommit, tagFormatFor, tagMatchPatterns,
    tarballName, validateTagFormat,
} from '../lib.mjs'

function repo (files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tools-test-'))
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
        fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    return root
}

test('parsePackagesInput', () => {
    assert.deepEqual(parsePackagesInput(''), ['.'])
    assert.deepEqual(parsePackagesInput('.'), ['.'])
    assert.deepEqual(parsePackagesInput('packages/* tools/cli'), ['packages/*', 'tools/cli'])
    assert.deepEqual(parsePackagesInput('a,\nb'), ['a', 'b'])
    assert.throws(() => parsePackagesInput('packages/**'), /not supported/)
    assert.throws(() => parsePackagesInput('pk*/a'), /not supported/)
    assert.throws(() => parsePackagesInput('../x'), /inside the repository/)
    assert.throws(() => parsePackagesInput('/abs'), /inside the repository/)
})

test('multi-package input and default tag format', () => {
    assert.equal(isMultiPackageInput('.'), false)
    assert.equal(isMultiPackageInput('types/three'), false)
    assert.equal(isMultiPackageInput('packages/*'), true)
    assert.equal(isMultiPackageInput('a b'), true)
    assert.equal(defaultTagFormat('.'), 'publish@{version}')
    assert.equal(defaultTagFormat('packages/*'), '{name}-{version}')
})

test('readPackages: single package at the root', () => {
    const root = repo({'package.json': {name: 'solo', version: '1.0.0'}})
    const list = readPackages(root, '.')
    assert.deepEqual(list.map(p => [p.name, p.version, p.dir, p.private]), [['solo', '1.0.0', '.', false]])
})

test('readPackages: a subdirectory', () => {
    const root = repo({'package.json': {name: 'root', version: '0.0.0', private: true}, 'types/three/package.json': {name: 'types-x', version: '0.1.0'}})
    assert.deepEqual(readPackages(root, 'types/three/').map(p => p.dir), ['types/three'])
    assert.throws(() => readPackages(root, 'types'), /has no package.json/)
})

test('readPackages: workspaces in build order, private flagged, folders without package.json ignored', () => {
    const root = repo({
        'packages/a-ui/package.json': {name: 'a-ui', version: '1.0.0', peerDependencies: {core: '^1'}, devDependencies: {core: '*'}},
        'packages/b-react/package.json': {name: 'b-react', version: '0.0.0', private: true, dependencies: {core: '*'}},
        'packages/c-shad/package.json': {name: 'c-shad', version: '0.0.0', dependencies: {'b-react': '*', 'core': '*'}},
        'packages/core/package.json': {name: 'core', version: '1.2.0', dependencies: {'left-pad': '1'}},
        'packages/notes/README.md': 'not a package',
    })
    const list = readPackages(root, 'packages/*')
    assert.deepEqual(list.map(p => p.name), ['core', 'a-ui', 'b-react', 'c-shad'])
    assert.deepEqual(list.find(p => p.name === 'c-shad').internalDeps, ['b-react', 'core'])
    assert.equal(list.find(p => p.name === 'b-react').private, true)
})

test('readPackages: duplicate names fail', () => {
    const root = repo({'a/package.json': {name: 'x', version: '1.0.0'}, 'b/package.json': {name: 'x', version: '1.0.0'}})
    assert.throws(() => readPackages(root, 'a b'), /is in both a and b/)
})

test('sortByDependencies: a cycle fails', () => {
    const list = [
        {name: 'a', manifest: {dependencies: {b: '1'}}},
        {name: 'b', manifest: {dependencies: {a: '1'}}},
    ]
    assert.throws(() => sortByDependencies(list), /Dependency cycle: a -> b -> a/)
})

test('changelogEntry: heading styles', () => {
    const text = [
        '# Changelog',
        '',
        '## [Unreleased]',
        '- wip',
        '',
        '## [1.2.10] - 2026-02-01',
        '- ten',
        '',
        '## [1.2.3](https://example.com/compare) (2026-01-01)',
        '### Bug fixes',
        '- fixed a thing',
        '',
        '## v1.2.2',
        '- two',
        '## 1.2.1',
        '',
        '## 1.2.0 - empty below',
        '',
    ].join('\n')
    assert.equal(changelogEntry(text, '1.2.3'), '### Bug fixes\n- fixed a thing')
    assert.equal(changelogEntry(text, '1.2.10'), '- ten')
    assert.equal(changelogEntry(text, '1.2.2'), '- two')
    assert.equal(changelogEntry(text, '1.2.1'), null, 'an empty section is missing')
    assert.equal(changelogEntry(text, '1.2.0'), null)
    assert.equal(changelogEntry(text, '1.2'), null, 'a version prefix does not match')
    assert.equal(changelogEntry(text, '9.9.9'), null)
})

test('changelogEntry: prerelease versions and CRLF', () => {
    const text = '## 2.0.0-beta.1\r\n- beta\r\n## 2.0.0-beta.10\r\n- beta ten\r\n'
    assert.equal(changelogEntry(text, '2.0.0-beta.1'), '- beta')
    assert.equal(changelogEntry(text, '2.0.0-beta.10'), '- beta ten')
})

test('tag formats', () => {
    assert.equal(formatTag('publish@{version}', {name: 'x', version: '1.0.0'}), 'publish@1.0.0')
    assert.equal(formatTag('{name}-{version}', {name: '@scope/pkg', version: '2.0.0-rc.1'}), '@scope/pkg-2.0.0-rc.1')
    assert.deepEqual(tagMatchPatterns('publish@{version}', 'x'), ['publish@[0-9]*', 'v[0-9]*'])
    assert.deepEqual(tagMatchPatterns('{name}-{version}', 'uiconfig.js'), ['uiconfig.js-[0-9]*'])
    assert.doesNotThrow(() => validateTagFormat('publish@{version}', false))
    assert.throws(() => validateTagFormat('release', false), /must contain \{version\}/)
    assert.throws(() => validateTagFormat('v{version}', true), /must contain \{name\}/)
})

test('prerelease and dist-tag', () => {
    assert.equal(isPrerelease('1.0.0'), false)
    assert.equal(isPrerelease('1.0.0+build-5'), false)
    assert.equal(isPrerelease('0.1.0-dev.15'), true)
    assert.equal(distTag({version: '1.0.0'}), '')
    assert.equal(distTag({version: '1.0.0-beta.1'}), 'next')
    assert.equal(distTag({version: '1.0.0-beta.1', publishConfig: {tag: 'beta'}}), 'beta')
    assert.equal(distTag({version: '1.0.0', publishConfig: {tag: 'legacy'}}), 'legacy')
})

test('tarballName matches npm pack', () => {
    assert.equal(tarballName('ts-browser-helpers', '0.21.0'), 'ts-browser-helpers-0.21.0.tgz')
    assert.equal(tarballName('@scope/pkg', '1.0.0-rc.1'), 'scope-pkg-1.0.0-rc.1.tgz')
})

test('splitCommit', () => {
    assert.deepEqual(splitCommit('abc1234 Fix: a thing'), {hash: 'abc1234', subject: 'Fix: a thing'})
    assert.deepEqual(splitCommit('abc1234'), {hash: 'abc1234', subject: ''})
})

const pkgA = {name: 'core', version: '1.2.0', dir: 'packages/core', tag: 'core-1.2.0', distTag: '', previousTag: 'core-1.1.0', commits: ['aaa1111 core: add x', 'bbb2222 core: fix y']}
const pkgB = {name: 'ui', version: '2.0.0-beta.1', dir: 'packages/ui', tag: 'ui-2.0.0-beta.1', distTag: 'next', previousTag: '', commits: []}
const release = {repository: 'owner/repo', sha: 'f00d', runUrl: 'https://github.com/owner/repo/actions/runs/1', packages: [pkgA, pkgB]}

test('reviewText lists every package with its commits', () => {
    assert.equal(reviewText(release), [
        'npm release review',
        'repository: owner/repo',
        'commit: f00d',
        'run (approval pending): https://github.com/owner/repo/actions/runs/1',
        'packages (2, in publish order):',
        '- core@1.2.0',
        '  directory: packages/core',
        '  release tag: core-1.2.0',
        '  previous release tag: core-1.1.0',
        '  commits since the previous release:',
        '    aaa1111 core: add x',
        '    bbb2222 core: fix y',
        '- ui@2.0.0-beta.1 (dist-tag next)',
        '  directory: packages/ui',
        '  release tag: ui-2.0.0-beta.1',
        '  previous release tag: none',
        '  commits since the previous release: none',
        '',
    ].join('\n'))
    assert.deepEqual(firePayload('hi'), {text: 'hi'})
})

test('discordText: waiting for approval, one package', () => {
    const text = discordText({ok: true, repository: 'owner/repo', runUrl: 'RUN', packages: [pkgA], session: 'https://claude.ai/code/session_x'})
    assert.equal(text, [
        '📦 owner/repo: **core@1.2.0** is built and waits for approval to publish to npm.',
        'Approve: RUN',
        '🤖 Claude review: https://claude.ai/code/session_x',
        '',
        '- `aaa1111` core: add x',
        '- `bbb2222` core: fix y',
    ].join('\n'))
})

test('discordText: several packages get a commit list each', () => {
    const text = discordText({ok: true, repository: 'owner/repo', runUrl: 'RUN', packages: [pkgA, {...pkgB, commits: ['ccc3333 ui: beta']}]})
    assert.match(text, /\*\*core@1\.2\.0\*\*, \*\*ui@2\.0\.0-beta\.1 \(dist-tag next\)\*\* are built and wait for approval/)
    assert.match(text, /\ncore:\n- `aaa1111` core: add x\n- `bbb2222` core: fix y\n\nui:\n- `ccc3333` ui: beta$/)
    assert.doesNotMatch(text, /Claude review/)
})

test('discordText: failure with errors, no session link', () => {
    const text = discordText({ok: false, repository: 'owner/repo', runUrl: 'RUN', packages: [pkgB], errors: ['ui@2.0.0-beta.1: no section'], session: 'S'})
    assert.equal(text, '❌ owner/repo: the check, build or pack of **ui@2.0.0-beta.1 (dist-tag next)** failed; nothing is published.\nLog: RUN\n- ui@2.0.0-beta.1: no section')
})

test('discordText stays within the Discord limit', () => {
    const many = {...pkgA, commits: Array.from({length: 200}, (_, i) => `${String(i).padStart(7, '0')} ${'x'.repeat(60)}`)}
    assert.ok(discordText({ok: true, repository: 'r', runUrl: 'RUN', packages: [many]}).length <= 2000)
})

test('reviewEligible', () => {
    const base = {buildOk: true, event: 'push', actor: 'owner', reviewActor: 'owner', url: 'u', token: 't'}
    assert.deepEqual(reviewEligible(base), {fire: true, reason: ''})
    assert.equal(reviewEligible({...base, buildOk: false}).fire, false)
    assert.equal(reviewEligible({...base, url: ''}).fire, false)
    assert.equal(reviewEligible({...base, token: ''}).fire, false)
    assert.equal(reviewEligible({...base, event: 'workflow_dispatch'}).fire, false)
    assert.equal(reviewEligible({...base, actor: 'someone'}).fire, false)
    assert.equal(reviewEligible({...base, reviewActor: '', actor: ''}).fire, false)
})

test('readRelease: the file RELEASE_FILE first, else env RELEASE', () => {
    const root = repo({'release.json': '{"packages":[1]}'})
    const file = path.join(root, 'release.json')
    assert.equal(readRelease({RELEASE_FILE: file, RELEASE: '{"packages":[2]}'}), '{"packages":[1]}')
    assert.equal(readRelease({RELEASE_FILE: path.join(root, 'missing.json'), RELEASE: '{"packages":[2]}'}), '{"packages":[2]}')
    assert.equal(readRelease({}), '')
})

test('failureText cuts a long error and keeps the log link', () => {
    const env = {GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7'}
    const text = failureText({step: 'notice', error: 'x'.repeat(5000), env})
    assert.ok(text.length <= 2000)
    assert.ok(text.endsWith('…\nLog: https://github.com/o/r/actions/runs/7'))
})

test('parsePackagesInput: exclusion entries', () => {
    assert.deepEqual(parsePackagesInput('. plugins/* !plugins/plugin-template-*'), ['.', 'plugins/*', '!plugins/plugin-template-*'])
    assert.deepEqual(parsePackagesInput('!x'), ['.', '!x']) // only exclusions: the root, minus them
    assert.throws(() => parsePackagesInput('!a/**'), /not supported/)
    assert.throws(() => parsePackagesInput('!../x'), /inside the repository/)
    assert.throws(() => parsePackagesInput('!'), /inside the repository/)
    assert.equal(isMultiPackageInput('. !x'), false)
    assert.equal(isMultiPackageInput('. plugins/* !plugins/t-*'), true)
})

test('readPackages: exclusion entries leave out the directories they match', () => {
    const root = repo({
        'package.json': {name: 'core', version: '1.0.0'},
        'plugins/a/package.json': {name: 'a', version: '1.0.0', peerDependencies: {core: '*'}},
        'plugins/plugin-template-vite/package.json': {name: 'tpl', version: '1.0.0'},
        'plugins/plugin-templates/package.json': {name: 'tpls', version: '1.0.0'},
    })
    assert.deepEqual(readPackages(root, '. plugins/* !plugins/plugin-template-*').map(p => p.dir), ['.', 'plugins/a', 'plugins/plugin-templates'])
    assert.deepEqual(readPackages(root, 'plugins/* !plugins/a').map(p => p.dir), ['plugins/plugin-template-vite', 'plugins/plugin-templates'])
})

test('tagFormatFor: the root package can keep its own format', () => {
    assert.equal(tagFormatFor('.', '{name}-{version}', 'v{version}'), 'v{version}')
    assert.equal(tagFormatFor('plugins/a', '{name}-{version}', 'v{version}'), '{name}-{version}')
    assert.equal(tagFormatFor('.', '{name}-{version}', ''), '{name}-{version}')
    assert.deepEqual(tagMatchPatterns('v{version}', 'core'), ['v[0-9]*', 'v[0-9]*'])
})

test('entryFiles and missingEntries', () => {
    const manifest = {
        main: 'dist/index.js', module: './dist/index.mjs', types: 'dist/index.d.ts', bin: {cli: './bin/cli.js'},
        exports: {'.': {types: './lib/index.d.ts', import: './lib/index.js', require: './dist/index.js'}, './dist/': './dist/', './*': './lib/*.js', './package.json': './package.json'},
    }
    assert.deepEqual(entryFiles(manifest), ['bin/cli.js', 'dist/index.d.ts', 'dist/index.js', 'dist/index.mjs', 'lib/index.d.ts', 'lib/index.js', 'package.json'])
    const all = ['package/package.json', 'package/bin/cli.js', 'package/dist/index.js', 'package/dist/index.mjs', 'package/dist/index.d.ts', 'package/lib/index.js', 'package/lib/index.d.ts']
    assert.deepEqual(missingEntries(manifest, all), [])
    assert.deepEqual(missingEntries(manifest, all.filter(f => !f.startsWith('package/dist/'))), ['dist/index.d.ts', 'dist/index.js', 'dist/index.mjs'])
    assert.deepEqual(missingEntries({main: 'dist'}, ['package/dist/index.js']), []) // Node resolves main to dist/index.js
    assert.deepEqual(entryFiles({name: 'x'}), [])
})

test('partialPlan leaves out what has no tarball and what depends on it', () => {
    const list = [{name: 'core'}, {name: 'ui', internalDeps: ['core']}, {name: 'other'}, {name: 'app', internalDeps: ['ui']}]
    const {publish, skipped} = partialPlan(list, new Set(['ui', 'other', 'app']))
    assert.deepEqual(publish.map(p => p.name), ['other'])
    assert.deepEqual(skipped, [
        {name: 'core', reason: 'not built'},
        {name: 'ui', reason: 'depends on core, which is not published'},
        {name: 'app', reason: 'depends on ui, which is not published'},
    ])
    assert.deepEqual(partialPlan(list, new Set(['core', 'ui', 'other', 'app'])).publish.map(p => p.name), ['core', 'ui', 'other', 'app'])
})

test('discordText and reviewText: a partial release lists what it leaves out', () => {
    const failed = [{name: 'ui', version: '2.0.0-beta.1', error: 'not built: the tarball has no dist/index.js'}]
    const text = discordText({ok: true, repository: 'owner/repo', runUrl: 'RUN', packages: [pkgA, pkgB], failed})
    assert.equal(text, [
        '📦 owner/repo: **core@1.2.0** is built and waits for approval to publish to npm.',
        'Approve: RUN',
        '⚠️ Not built, not published:',
        '- ui@2.0.0-beta.1: not built: the tarball has no dist/index.js',
        '',
        '- `aaa1111` core: add x',
        '- `bbb2222` core: fix y',
    ].join('\n'))
    const review = reviewText(release, failed)
    assert.match(review, /packages \(1, in publish order\):\n- core@1\.2\.0\n/)
    assert.doesNotMatch(review, /directory: packages\/ui/)
    assert.match(review, /not built, left out of this release:\n- ui@2\.0\.0-beta\.1: not built/)
})

const deploy = {repository: 'owner/repo', sha: 'abcdef1234567', runUrl: 'RUN', environment: 'cloud-deploy', name: 'threepipe cloud'}

test('deployReviewText', () => {
    assert.equal(deployReviewText({...deploy, workingDirectory: 'services/cloud', previous: '1234567', commits: ['aaa1111 cloud: x']}), [
        'deploy review',
        'repository: owner/repo',
        'what: threepipe cloud',
        'directory: services/cloud',
        'environment: cloud-deploy',
        'commit: abcdef1234567',
        'deployed before: 1234567',
        'run (approval pending): RUN',
        'commits since the last deploy:',
        '  aaa1111 cloud: x',
        '',
    ].join('\n'))
    assert.match(deployReviewText({...deploy, workingDirectory: '.', previous: '', commits: []}), /deployed before: none\n.*\ncommits since the last deploy: none\n$/)
})

test('deployDiscordText: waiting, check failed, deploy failed', () => {
    assert.equal(deployDiscordText({...deploy, state: 'waiting', commits: ['aaa1111 cloud: x'], session: 'S'}), [
        '🚀 owner/repo: **threepipe cloud** `abcdef1` is checked and waits for approval to deploy (cloud-deploy).',
        'Approve: RUN',
        '🤖 Claude review: S',
        '',
        '- `aaa1111` cloud: x',
    ].join('\n'))
    assert.equal(deployDiscordText({...deploy, state: 'check-failed', commits: ['aaa1111 x'], session: 'S'}),
        '❌ owner/repo: the check of **threepipe cloud** `abcdef1` failed; nothing is deployed.\nLog: RUN')
    assert.equal(deployDiscordText({...deploy, state: 'deploy-failed'}),
        '❌ owner/repo: the deploy of **threepipe cloud** `abcdef1` (cloud-deploy) failed after the approval.\nLog: RUN')
})

test('pickSecrets', () => {
    assert.deepEqual(pickSecrets({A: '1', B: '2', C: '3'}, 'A, C'), {A: '1', C: '3'})
    assert.deepEqual(pickSecrets({A: '1'}, ''), {})
    assert.throws(() => pickSecrets({A: '1', B: ''}, 'A B D'), /missing secret\(s\): B, D/)
})

test('failureText: what failed', () => {
    const env = {GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '3'}
    assert.equal(failureText({step: 'publish', env}), '❌ o/r: the release publish failed\nLog: https://github.com/o/r/actions/runs/3')
    assert.equal(failureText({what: 'deploy', step: 'notice', error: 'x', env}), '❌ o/r: the deploy notice failed: x\nLog: https://github.com/o/r/actions/runs/3')
})

test('hasCommit', () => {
    assert.equal(hasCommit('.', 'HEAD'), true)
    assert.equal(hasCommit('.', '0123456789abcdef0123456789abcdef01234567'), false)
})
