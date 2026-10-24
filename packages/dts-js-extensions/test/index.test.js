import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {findDeclarations, fixDtsDirectory, fixDtsImports, rewriteDeclaration} from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'cli.js')

/** Copies a fixture to <tmp>/<name> (the name stays, for specifiers like '../basic/Foo'). */
function fixture (name) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dts-js-ext-')), name)
    fs.cpSync(path.join(here, 'fixtures', name), dir, {recursive: true})
    return dir
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')

const expectedIndex = `export * from './core/index.js';
export { Foo } from './Foo.js';
export { Bar } from './Bar.js';
export type { Baz } from "./Baz.js";
export * from './mod.mjs';
export * from './mod.mjs';
export * as again from '../basic/Foo.js';
import data from './data.json';
import './side.js';
export declare const t: typeof import('./types.js').T;
export declare const u: import( "./core/util/index.js" ).U;
export { x } from 'some-lib/sub';
/**
 * Example in a doc comment, left as it is:
 * import { Foo } from './nowhere'
 */
// import './nowhere'
export { data };
`

const expectedCore = `import type { Foo } from '../index.js';
export * from './util/index.js';
declare module '../Foo.js' {
    interface Foo {
        extra: string;
    }
}
export type { Foo };
`

test('rewrites every kind of relative specifier in a directory', async () => {
    const dir = fixture('basic')
    const {files, changed} = await fixDtsDirectory(dir)
    assert.equal(read(dir, 'index.d.ts'), expectedIndex)
    assert.equal(read(dir, 'core/index.d.ts'), expectedCore)
    assert.equal(files.length, 9, 'the .d.ts and .d.mts files, not .js or .json')
    assert.deepEqual(changed.map(f => path.relative(dir, f)).sort(), ['core/index.d.ts', 'index.d.ts'])
    assert.equal(read(dir, 'runtime.js'), 'export const notADeclaration = "./Foo";\n')
})

test('a second run changes nothing', async () => {
    const dir = fixture('basic')
    await fixDtsDirectory(dir)
    const {changed} = await fixDtsDirectory(dir)
    assert.deepEqual(changed, [])
    assert.equal(read(dir, 'index.d.ts'), expectedIndex)
})

test('check mode reports and writes nothing', async () => {
    const dir = fixture('basic')
    const before = read(dir, 'index.d.ts')
    const {changed} = await fixDtsDirectory(await findDeclarations(dir), {check: true})
    assert.equal(changed.length, 2)
    assert.equal(read(dir, 'index.d.ts'), before)
})

test('works as the vite-plugin-dts afterBuild hook (a Map of emitted files)', async () => {
    const dir = fixture('basic')
    const emitted = new Map([
        [path.join(dir, 'index.d.ts'), ''],
        [path.join(dir, 'runtime.js'), ''],
    ])
    assert.equal(await fixDtsImports(emitted), undefined)
    assert.equal(read(dir, 'index.d.ts'), expectedIndex)
    assert.equal(read(dir, 'core/index.d.ts'), fs.readFileSync(path.join(here, 'fixtures/basic/core/index.d.ts'), 'utf8'), 'files outside the Map are not touched')
})

test('a specifier that matches no declaration throws; the rest is still written', async () => {
    const dir = fixture('missing')
    await assert.rejects(fixDtsDirectory(dir), err => {
        assert.match(err.message, /'\.\/nope' matches no declaration file/)
        return true
    })
    assert.equal(read(dir, 'index.d.ts'), "export * from './nope';\nexport { Here } from './here.js';\n")
})

test('strictSubpaths: deep imports of a listed package need .js unless allowed', () => {
    const text = [
        "import { A } from 'three/src/math/MathUtils';",
        "import { B } from 'three/src/math/Color.js';",
        "import { C } from 'three/addons';",
        "import { D } from 'three';",
        "import { E } from 'other/deep/path';",
    ].join('\n')
    const {errors} = rewriteDeclaration(text, '/x/index.d.ts', () => false, {strictSubpaths: {three: ['addons', 'webgpu', 'tsl']}})
    assert.equal(errors.length, 1)
    assert.match(errors[0], /'three\/src\/math\/MathUtils' needs a \.js extension/)
    assert.deepEqual(rewriteDeclaration(text, '/x/index.d.ts', () => false).errors, [], 'no check without the option')
})

test('rewriteDeclaration: dot specifiers, trailing slash and quote styles', () => {
    const exists = f => ['/p/index.d.ts', '/p/a/index.d.ts', '/p/a/sub/index.d.ts', '/p/a/b.d.ts'].includes(f)
    const {text, errors} = rewriteDeclaration(
        "export * from '.';\nexport * from \"./sub/\";\nexport * from './b';\nexport * from '..';\nexport * from '../';\n",
        '/p/a/c.d.ts', exists)
    assert.deepEqual(errors, [])
    assert.equal(text, "export * from './index.js';\nexport * from \"./sub/index.js\";\nexport * from './b.js';\nexport * from '../index.js';\nexport * from '../index.js';\n")
})

test('rewriteDeclaration: a dotted file name resolves as a file', () => {
    const exists = f => f === '/p/three.module.d.ts'
    assert.equal(rewriteDeclaration("export * from './three.module';", '/p/i.d.ts', exists).text, "export * from './three.module.js';")
})

test('CLI: rewrites, then --check passes', () => {
    const dir = fixture('basic')
    const check1 = spawnSync(process.execPath, [cli, '--check', dir], {encoding: 'utf8'})
    assert.equal(check1.status, 1)
    assert.match(check1.stderr, /2 of 9 declaration files have imports without \.js/)
    const out = execFileSync(process.execPath, [cli, dir], {encoding: 'utf8'})
    assert.match(out, /2 of 9 declaration files rewritten/)
    const check2 = spawnSync(process.execPath, [cli, '--check', dir], {encoding: 'utf8'})
    assert.equal(check2.status, 0, check2.stderr)
})

test('CLI: errors and usage', () => {
    const missing = spawnSync(process.execPath, [cli, fixture('missing')], {encoding: 'utf8'})
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /matches no declaration file/)
    const strict = path.join(fixture('basic'), 'strict.d.ts')
    fs.writeFileSync(strict, "export * from 'three/src/Three.Core';\n")
    const s = spawnSync(process.execPath, [cli, '--strict-subpaths', 'three=addons', strict], {encoding: 'utf8'})
    assert.equal(s.status, 1)
    assert.match(s.stderr, /needs a \.js extension/)
    assert.equal(spawnSync(process.execPath, [cli], {encoding: 'utf8'}).status, 2)
    assert.equal(spawnSync(process.execPath, [cli, '--help'], {encoding: 'utf8'}).status, 0)
})
