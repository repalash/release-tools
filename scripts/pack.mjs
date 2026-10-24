// Packs each package of the release (env RELEASE, the JSON from check.mjs) into <out>/<tarball>,
// in the listed order.
//
// Without --clean-package: `npm pack` (it runs the package's prepack, prepare and postpack scripts).
// With --clean-package: `npm run prepack --if-present`, then `clean-package`, then
// `npm pack --ignore-scripts`, then `clean-package restore`. clean-package usually removes
// "scripts" from package.json, so npm pack could not run prepack itself.
// The clean-package binary is looked up in node_modules/.bin from the package directory up to the root.
//
// Usage: node pack.mjs --out <dir> [--root <dir>] [--clean-package]
import {parseArgs} from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {execFileSync} from 'node:child_process'
import {parseRelease} from './lib.mjs'

const {values: args} = parseArgs({
    options: {
        'root': {type: 'string', default: '.'},
        'out': {type: 'string'},
        'clean-package': {type: 'boolean', default: process.env.CLEAN_PACKAGE === 'true'},
    },
})
if (!args.out) throw new Error('--out is required')

const root = path.resolve(args.root)
const out = path.resolve(args.out)
fs.mkdirSync(out, {recursive: true})
const release = parseRelease(process.env.RELEASE)
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, {cwd, stdio: 'inherit'})

function cleanPackageBin (dir) {
    for (let d = dir; ; d = path.dirname(d)) {
        const bin = path.join(d, 'node_modules', '.bin', 'clean-package')
        if (fs.existsSync(bin)) return bin
        if (d === root || d === path.dirname(d)) break
    }
    throw new Error(`clean-package is not installed for ${path.relative(root, dir) || '.'} (add it to devDependencies)`)
}

for (const p of release.packages) {
    const cwd = path.join(root, p.dir)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-pack-'))
    console.log(`\nPacking ${p.name}@${p.version} (${p.dir})`)
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
    // The packed manifest must still be the version that check.mjs listed (a build step may not bump it).
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path.join(tmp, files[0]), 'package/package.json'], {encoding: 'utf8'}))
    if (manifest.name !== p.name || manifest.version !== p.version) {
        throw new Error(`the tarball is ${manifest.name}@${manifest.version}, expected ${p.name}@${p.version}`)
    }
    fs.copyFileSync(path.join(tmp, files[0]), path.join(out, p.tarball))
    fs.rmSync(tmp, {recursive: true, force: true})
    console.log(`✓ ${path.join(out, p.tarball)}`)
}
