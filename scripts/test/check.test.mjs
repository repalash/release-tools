import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const script = path.join(import.meta.dirname, '..', 'check.mjs')
const run = promisify(execFile)

test('writes the release JSON to RELEASE_FILE (a private package: no npm lookup)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'))
    try {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'x', version: '1.0.0', private: true}))
        const file = path.join(root, 'out', 'release.json')
        await run(process.execPath, [script, '--root', root], {env: {PATH: process.env.PATH, GITHUB_REPOSITORY: 'owner/repo', RELEASE_FILE: file}})
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {repository: 'owner/repo', sha: '', runUrl: '', packages: [], errors: []})
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})
