import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const pack = path.join(import.meta.dirname, '..', 'pack.mjs')
const build = path.join(import.meta.dirname, '..', 'build-packages.mjs')
const run = promisify(execFile)

function repo (files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pack-'))
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
        fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    return root
}
const env = extra => ({PATH: process.env.PATH, HOME: os.homedir(), ...extra})
const pkg = (name, extra = {}) => ({name, version: '1.0.0', dir: `packages/${name}`, tarball: `${name}-1.0.0.tgz`, internalDeps: [], ...extra})
const manifest = (name, extra = {}) => ({name, version: '1.0.0', main: 'dist/index.js', files: ['dist'], ...extra})

test('pack --partial: leaves out a failed build, a tarball without its entry files, and what depends on them', async () => {
    const root = repo({
        'packages/a/package.json': manifest('a'), 'packages/a/dist/index.js': 'export {}',
        'packages/b/package.json': manifest('b'), 'packages/b/dist/index.js': 'export {}', // built, but its package-build failed
        'packages/c/package.json': manifest('c', {dependencies: {b: '*'}}), 'packages/c/dist/index.js': 'export {}',
        'packages/d/package.json': manifest('d'), // no dist: the tarball lacks dist/index.js
        'packages/e/package.json': manifest('e', {dependencies: {d: '*'}}), 'packages/e/dist/index.js': 'export {}',
        'build.json': [{name: 'b', version: '1.0.0', error: 'package-build exited with 1'}],
    })
    try {
        const release = {packages: [pkg('a'), pkg('b'), pkg('c', {internalDeps: ['b']}), pkg('d'), pkg('e', {internalDeps: ['d']})]}
        const out = path.join(root, 'out'), failedFile = path.join(root, 'failed', 'failed.json')
        await run(process.execPath, [pack, '--root', root, '--out', out, '--partial', '--failed-file', failedFile, '--build-failed-file', path.join(root, 'build.json')],
            {env: env({RELEASE: JSON.stringify(release)})})
        assert.deepEqual(fs.readdirSync(out), ['a-1.0.0.tgz']) // c and e not even packed: what they need is out
        assert.deepEqual(JSON.parse(fs.readFileSync(failedFile, 'utf8')), [
            {name: 'b', version: '1.0.0', error: 'package-build exited with 1'},
            {name: 'c', version: '1.0.0', error: 'depends on b, which is not published'},
            {name: 'd', version: '1.0.0', error: 'not built: the tarball has no dist/index.js'},
            {name: 'e', version: '1.0.0', error: 'depends on d, which is not published'},
        ])
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})

test('pack --partial: another error stops the run (here: no clean-package), as without --partial', async () => {
    const root = repo({'packages/a/package.json': manifest('a'), 'packages/a/dist/index.js': 'export {}'})
    try {
        await assert.rejects(run(process.execPath, [pack, '--root', root, '--out', path.join(root, 'out'), '--clean-package', '--partial', '--failed-file', path.join(root, 'f.json')],
            {env: env({RELEASE: JSON.stringify({packages: [pkg('a')]})})}), e => /clean-package is not installed/.test(e.stderr))
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})

test('pack --partial fails when nothing is left', async () => {
    const root = repo({'packages/b/package.json': manifest('b')})
    try {
        await assert.rejects(run(process.execPath, [pack, '--root', root, '--out', path.join(root, 'out'), '--partial', '--failed-file', path.join(root, 'f.json')],
            {env: env({RELEASE: JSON.stringify({packages: [pkg('b')]})})}), {code: 1})
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})

test('build-packages: what the release needs, in build order; --partial goes on after a failure', async () => {
    const root = repo({
        'packages/a/package.json': {name: 'a', version: '1.0.0', dependencies: {b: '*'}},
        'packages/b/package.json': {name: 'b', version: '1.0.0'},
        'packages/c/package.json': {name: 'c', version: '1.0.0'},
        'packages/d/package.json': {name: 'd', version: '1.0.0'}, // not released, not needed: not built
        'packages/b/FAIL': '',
    })
    try {
        const failedFile = path.join(root, 'build.json')
        const cmd = 'echo "$(basename "$PWD")" >> ../../order; test ! -e FAIL'
        const release = JSON.stringify({packages: [{name: 'a'}, {name: 'c'}]}) // b is not released, but a needs it
        await run(process.execPath, [build, '--root', root, '--packages', 'packages/*', '--partial', '--failed-file', failedFile], {env: env({PACKAGE_BUILD: cmd, RELEASE: release})})
        assert.equal(fs.readFileSync(path.join(root, 'order'), 'utf8'), 'b\na\nc\n') // a after b, tried anyway; d not needed
        assert.deepEqual(JSON.parse(fs.readFileSync(failedFile, 'utf8')), [{name: 'b', version: '1.0.0', error: 'package-build exited with 1'}])
        // without --partial the first failure stops it
        await assert.rejects(run(process.execPath, [build, '--root', root, '--packages', 'packages/*'], {env: env({PACKAGE_BUILD: cmd, RELEASE: release})}), {code: 1})
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})
