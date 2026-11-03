import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const script = path.join(import.meta.dirname, '..', 'pack.mjs')
const run = promisify(execFile)

function repo (files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pack-'))
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
        fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    return root
}

const pkg = (name, extra = {}) => ({name, version: '1.0.0', dir: `packages/${name}`, tarball: `${name}-1.0.0.tgz`, internalDeps: [], ...extra})

test('--partial packs what built and leaves out the rest, with what depends on it', async () => {
    const root = repo({
        'packages/a/package.json': {name: 'a', version: '1.0.0', main: 'dist/index.js', files: ['dist']},
        'packages/a/dist/index.js': 'export {}',
        'packages/b/package.json': {name: 'b', version: '1.0.0', main: 'dist/index.js', files: ['dist']},
        'packages/c/package.json': {name: 'c', version: '1.0.0', main: 'index.js', dependencies: {b: '*'}},
        'packages/c/index.js': 'export {}',
    })
    try {
        const release = {packages: [pkg('a'), pkg('b'), pkg('c', {internalDeps: ['b']})]}
        const out = path.join(root, 'out'), failedFile = path.join(root, 'failed', 'failed.json')
        await run(process.execPath, [script, '--root', root, '--out', out, '--partial', '--failed-file', failedFile],
            {env: {PATH: process.env.PATH, HOME: os.homedir(), RELEASE: JSON.stringify(release)}})
        assert.deepEqual(fs.readdirSync(out), ['a-1.0.0.tgz'])
        assert.deepEqual(JSON.parse(fs.readFileSync(failedFile, 'utf8')), [
            {name: 'b', version: '1.0.0', error: 'not built: the tarball has no dist/index.js'},
            {name: 'c', version: '1.0.0', error: 'depends on b, which is not built'},
        ])
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})

test('--partial fails when nothing was built', async () => {
    const root = repo({'packages/b/package.json': {name: 'b', version: '1.0.0', main: 'dist/index.js'}})
    try {
        const env = {PATH: process.env.PATH, HOME: os.homedir(), RELEASE: JSON.stringify({packages: [pkg('b')]})}
        await assert.rejects(run(process.execPath, [script, '--root', root, '--out', path.join(root, 'out'), '--partial', '--failed-file', path.join(root, 'f.json')], {env}), {code: 1})
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})
