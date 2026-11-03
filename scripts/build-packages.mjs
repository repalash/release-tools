// Runs the `package-build` command in the directory of each package the release needs: the released packages (the
// release JSON) and the packages of the `packages` input they depend on, transitively (one that is not released is
// built too: the released ones build against it). In build order (a package after the listed ones it depends on).
//
// Without --partial the first failure stops the run. With --partial a failed package is noted and the run goes on;
// a package whose listed dependency failed or was skipped is skipped. The packages that did not build are written to
// --failed-file as [{name, version, error}]; pack.mjs leaves them out of the release.
//
// Usage: node build-packages.mjs [--root <dir>] [--packages <input>] [--partial --failed-file <file>]
// Env: PACKAGE_BUILD (the command, run with bash), RELEASE_FILE or RELEASE (the JSON from check.mjs), and PACKAGES,
// PARTIAL, FAILED_FILE for the options.
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {blockingDep, buildClosure, parseRelease, readPackages, readRelease} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'root': {type: 'string', default: '.'},
        'packages': {type: 'string', default: process.env.PACKAGES || '.'},
        'partial': {type: 'boolean', default: process.env.PARTIAL === 'true'},
        'failed-file': {type: 'string', default: process.env.FAILED_FILE || ''},
    },
})
const command = process.env.PACKAGE_BUILD
if (!command) throw new Error('PACKAGE_BUILD is empty')
if (args.partial && !args['failed-file']) throw new Error('--partial needs --failed-file')

const root = path.resolve(args.root)
const list = readPackages(root, args.packages)
const need = buildClosure(list, parseRelease(readRelease()).packages.map(p => p.name))
const failed = []
const out = new Set()
for (const p of list.filter(x => need.has(x.name))) {
    const dep = blockingDep(p, out)
    if (dep) {
        out.add(p.name)
        failed.push({name: p.name, version: p.version, error: `depends on ${dep}, which did not build`})
        console.log(`\n✗ ${p.name} (${p.dir}): skipped, it depends on ${dep}`)
        continue
    }
    console.log(`\n▶ ${p.name} (${p.dir}): ${command}`)
    const res = spawnSync('bash', ['-eo', 'pipefail', '-c', command], {cwd: path.join(root, p.dir), stdio: 'inherit'})
    if (res.status === 0) continue
    if (!args.partial) process.exit(res.status ?? 1)
    out.add(p.name)
    failed.push({name: p.name, version: p.version, error: `package-build exited with ${res.status ?? res.signal}`})
    console.log(`::warning::${p.name} did not build (exit ${res.status ?? res.signal}); a partial release leaves it out`)
}
if (args.partial) {
    fs.mkdirSync(path.dirname(path.resolve(args['failed-file'])), {recursive: true})
    fs.writeFileSync(args['failed-file'], JSON.stringify(failed))
}
console.log(failed.length ? `\n${failed.length} package(s) did not build: ${failed.map(f => f.name).join(', ')}` : '\nEvery package built.')
