// Packs each package of the release (the JSON from check.mjs: file RELEASE_FILE or env RELEASE) into <out>/<tarball>,
// in the listed order.
//
// Without --clean-package: `npm pack` (it runs the package's prepack, prepare and postpack scripts).
// With --clean-package: `npm run prepack --if-present`, then `clean-package`, then
// `npm pack --ignore-scripts`, then `clean-package restore`. clean-package usually removes
// "scripts" from package.json, so npm pack could not run prepack itself.
// The clean-package binary is looked up in node_modules/.bin from the package directory up to the root.
//
// With --partial (a release that publishes what built), a package is left out when its package-build failed
// (--build-failed-file, from build-packages.mjs) or its tarball lacks a file its manifest points at (main, module,
// types, exports, bin), and so is each package that depends on one left out (partialPlan, as publish.mjs). Their
// tarballs are not in <out>, and they are written to --failed-file as [{name, version, error}] for the notice. Any
// other error stops the run, as without --partial. Fails when no package is left.
//
// Usage: node pack.mjs --out <dir> [--root <dir>] [--clean-package]
//                      [--partial --failed-file <file> [--build-failed-file <file>]]
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {blockingDep, missingEntries, parseRelease, partialPlan, readRelease} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'root': {type: 'string', default: '.'},
        'out': {type: 'string'},
        'clean-package': {type: 'boolean', default: process.env.CLEAN_PACKAGE === 'true'},
        'partial': {type: 'boolean', default: process.env.PARTIAL === 'true'},
        'failed-file': {type: 'string', default: process.env.FAILED_FILE || ''},
        'build-failed-file': {type: 'string', default: process.env.BUILD_FAILED_FILE || ''},
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

/** A package that was not built: a partial release leaves it out instead of failing. */
class NotBuilt extends Error {}

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
            if (missing.length) throw new NotBuilt(`not built: the tarball has no ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`)
        }
        fs.copyFileSync(tarball, path.join(out, p.tarball))
        console.log(`✓ ${path.join(out, p.tarball)}`)
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true})
    }
}

if (!args.partial) {
    for (const p of release.packages) {
        console.log(`\nPacking ${p.name}@${p.version} (${p.dir})`)
        pack(p)
    }
    process.exit(0)
}

// --partial: the reason each left-out package is not built, by name
const reasons = new Map()
const buildFailed = args['build-failed-file'] && fs.existsSync(args['build-failed-file'])
    ? JSON.parse(fs.readFileSync(args['build-failed-file'], 'utf8')) : []
for (const f of buildFailed) reasons.set(f.name, f.error)
const built = new Set()
for (const p of release.packages) {
    console.log(`\nPacking ${p.name}@${p.version} (${p.dir})`)
    if (reasons.has(p.name)) {
        console.log(`✗ left out: ${reasons.get(p.name)}`)
        continue
    }
    // not packed when a package it needs is out already (its own pack could fail on that)
    const dep = blockingDep(p, new Set(reasons.keys()))
    if (dep) {
        reasons.set(p.name, `depends on ${dep}, which is not published`)
        console.log(`✗ left out: it depends on ${dep}`)
        continue
    }
    try {
        pack(p)
        built.add(p.name)
    } catch (e) {
        if (!(e instanceof NotBuilt)) throw e
        reasons.set(p.name, e.message)
        console.log(`✗ left out: ${e.message}`)
    }
}
const {publish, skipped} = partialPlan(release.packages, built)
const failed = skipped.map(({name, reason}) => {
    const p = release.packages.find(x => x.name === name)
    // a tarball packed before its dependency was left out is not part of the release either
    fs.rmSync(path.join(out, p.tarball), {force: true})
    return {name, version: p.version, error: reasons.get(name) ?? reason}
})
fs.mkdirSync(path.dirname(path.resolve(args['failed-file'])), {recursive: true})
fs.writeFileSync(args['failed-file'], JSON.stringify(failed))
if (failed.length) console.log(`\n${failed.length} of ${release.packages.length} package(s) left out: ${failed.map(f => f.name).join(', ')}`)
if (!publish.length) {
    console.error('No package was built.')
    process.exit(1)
}
