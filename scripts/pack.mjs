// Packs each package of the release (the JSON from check.mjs: file RELEASE_FILE or env RELEASE) into <out>/<tarball>,
// in the listed order.
//
// Without --clean-package: `npm pack` (it runs the package's prepack, prepare and postpack scripts).
// With --clean-package: `npm run prepack --if-present`, then `clean-package`, then
// `npm pack --ignore-scripts`, then `clean-package restore`. clean-package usually removes
// "scripts" from package.json, so npm pack could not run prepack itself.
// The clean-package binary is looked up in node_modules/.bin from the package directory up to the root.
//
// With --partial (a release that publishes what built): a package that fails to pack, or whose tarball lacks a file
// its manifest points at (main, module, types, exports, bin: a build that failed), is left out, and so is each
// package that depends on one left out. They are written to --failed-file as [{name, version, error}]. Fails only
// when no package is left.
//
// Usage: node pack.mjs --out <dir> [--root <dir>] [--clean-package] [--partial --failed-file <file>]
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {missingEntries, parseRelease, readRelease} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'root': {type: 'string', default: '.'},
        'out': {type: 'string'},
        'clean-package': {type: 'boolean', default: process.env.CLEAN_PACKAGE === 'true'},
        'partial': {type: 'boolean', default: process.env.PARTIAL === 'true'},
        'failed-file': {type: 'string', default: process.env.FAILED_FILE || ''},
    },
})
if (!args.out) throw new Error('--out is required')
if (args.partial && !args['failed-file']) throw new Error('--partial needs --failed-file')

const root = path.resolve(args.root)
const out = path.resolve(args.out)
fs.mkdirSync(out, {recursive: true})
const release = parseRelease(readRelease())
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, {cwd, stdio: 'inherit'})

function cleanPackageBin (dir) {
    for (let d = dir; ; d = path.dirname(d)) {
        const bin = path.join(d, 'node_modules', '.bin', 'clean-package')
        if (fs.existsSync(bin)) return bin
        if (d === root || d === path.dirname(d)) break
    }
    throw new Error(`clean-package is not installed for ${path.relative(root, dir) || '.'} (add it to devDependencies)`)
}

/** Packs one package into <out>/<tarball>; with --partial, also checks its entry files are in the tarball. */
function pack (p) {
    const cwd = path.join(root, p.dir)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-pack-'))
    try {
        if (args['clean-package']) {
            const bin = cleanPackageBin(cwd)
            run('npm', ['run', 'prepack', '--if-present'], cwd)
            run(bin, [], cwd)
            try {
                run('npm', ['pack', '--ignore-scripts', '--pack-destination', tmp], cwd)
            } finally {
                run(bin, ['restore'], cwd)
            }
        } else {
            run('npm', ['pack', '--pack-destination', tmp], cwd)
        }
        const files = fs.readdirSync(tmp).filter(f => f.endsWith('.tgz'))
        if (files.length !== 1) throw new Error(`npm pack wrote ${files.length} tarballs for ${p.name}`)
        const tarball = path.join(tmp, files[0])
        // The packed manifest must still be the version that check.mjs listed (a build step may not bump it).
        const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {encoding: 'utf8'}))
        if (manifest.name !== p.name || manifest.version !== p.version) {
            throw new Error(`the tarball is ${manifest.name}@${manifest.version}, expected ${p.name}@${p.version}`)
        }
        if (args.partial) {
            const missing = missingEntries(manifest, execFileSync('tar', ['-tzf', tarball], {encoding: 'utf8'}).split('\n').filter(Boolean))
            if (missing.length) throw new Error(`not built: the tarball has no ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`)
        }
        fs.copyFileSync(tarball, path.join(out, p.tarball))
        console.log(`✓ ${path.join(out, p.tarball)}`)
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true})
    }
}

const failed = []
for (const p of release.packages) {
    console.log(`\nPacking ${p.name}@${p.version} (${p.dir})`)
    if (!args.partial) {
        pack(p)
        continue
    }
    const dep = (p.internalDeps ?? []).find(d => failed.some(f => f.name === d))
    if (dep) {
        failed.push({name: p.name, version: p.version, error: `depends on ${dep}, which is not built`})
        console.log(`✗ left out: it depends on ${dep}`)
        continue
    }
    try {
        pack(p)
    } catch (e) {
        failed.push({name: p.name, version: p.version, error: e.message.split('\n')[0].slice(0, 300)})
        console.log(`✗ left out: ${e.message}`)
    }
}
if (args.partial) {
    fs.mkdirSync(path.dirname(path.resolve(args['failed-file'])), {recursive: true})
    fs.writeFileSync(args['failed-file'], JSON.stringify(failed))
    if (failed.length) console.log(`\n${failed.length} of ${release.packages.length} package(s) left out: ${failed.map(f => f.name).join(', ')}`)
    if (failed.length === release.packages.length) {
        console.error('No package was built.')
        process.exit(1)
    }
}
