import path from 'node:path'
import {existsSync} from 'node:fs'
import {readdir, readFile, stat, writeFile} from 'node:fs/promises'

// `from '…'`, `import('…')`, side-effect `import '…'` and `declare module '…'`
const specifierRE = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+(?=['"])|\bdeclare\s+module\s+)(['"])([^'"\n]+)\2/g
// Extensions that a relative specifier can carry and that resolve to a declaration file.
const codeExtRE = /\.(d\.ts|d\.mts|d\.cts|tsx?|mts|cts|jsx?|mjs|cjs)$/
const declarationRE = /\.d\.(ts|mts|cts)$/

const isRelative = spec => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')

/**
 * Rewrites the relative specifiers of one declaration file (pure).
 * @param {string} text contents of the declaration file
 * @param {string} file absolute path of the declaration file
 * @param {(file: string) => boolean} exists whether a declaration file exists
 * @param {import('./index.js').DtsJsExtensionsOptions} [options]
 * @returns {{text: string, errors: string[]}}
 */
export function rewriteDeclaration (text, file, exists, options = {}) {
    const strict = options.strictSubpaths ?? {}
    const errors = []
    const out = text.replace(specifierRE, (match, head, quote, spec, offset) => {
        const line = text.slice(text.lastIndexOf('\n', offset) + 1, offset)
        if (/^\s*(\*|\/\/)/.test(line)) return match // example code in a doc comment
        if (isRelative(spec)) {
            const fixed = resolveRelative(spec, path.dirname(file), exists)
            if (fixed === null) errors.push(`${file}: '${spec}' matches no declaration file`)
            return head + quote + (fixed ?? spec) + quote
        }
        const error = checkBare(spec, strict)
        if (error) errors.push(`${file}: ${error}`)
        return match
    })
    return {text: out, errors}
}

/**
 * The explicit form of a relative specifier, `spec` when it needs no change, or null when it
 * matches no declaration file.
 */
function resolveRelative (spec, dir, exists) {
    const trimmed = spec.replace(/\/+$/, '') || spec // './' -> '.'
    const asDir = spec.endsWith('/') || /(^|\/)\.\.?$/.test(trimmed)
    const ext = asDir ? '' : (trimmed.match(codeExtRE)?.[1] ?? '')
    const bare = ext ? trimmed.slice(0, -(ext.length + 1)) : trimmed
    const base = path.resolve(dir, bare)
    if (!asDir) {
        // A specifier written as .mjs/.mts (or .cjs/.cts) prefers the matching declaration flavor.
        const order = /(^|\.)m/.test(ext) ? ['mjs', 'js', 'cjs'] : /(^|\.)c/.test(ext) ? ['cjs', 'js', 'mjs'] : ['js', 'mjs', 'cjs']
        for (const js of order) {
            if (exists(base + {js: '.d.ts', mjs: '.d.mts', cjs: '.d.cts'}[js])) return `${bare}.${js}`
        }
    }
    if (exists(path.join(base, 'index.d.ts'))) return `${bare}/index.js`
    // A non-code file (`./data.json`, `./style.css`) is left as it is.
    if (!asDir && !ext && /\.[A-Za-z0-9]+$/.test(path.posix.basename(bare))) return spec
    return null
}

/** An error for `<pkg>/<subpath>` without `.js` when `pkg` is in strictSubpaths and the subpath is not allowed. */
function checkBare (spec, strict) {
    for (const [pkg, allowed] of Object.entries(strict)) {
        if (!spec.startsWith(pkg + '/') || spec.endsWith('.js')) continue
        const sub = spec.slice(pkg.length + 1)
        if ((allowed ?? []).includes(sub)) continue
        return `'${spec}' needs a .js extension (only node10 resolution finds it without one)`
    }
    return ''
}

/** Rewrites the given declaration files; returns the processed and the changed files. */
async function processDeclarations (paths, options) {
    const files = paths.map(f => path.resolve(f)).filter(f => declarationRE.test(f))
    const known = new Set(files)
    const exists = f => known.has(f) || existsSync(f)
    const changed = []
    const errors = []
    for (const file of files) {
        const text = await readFile(file, 'utf8')
        const result = rewriteDeclaration(text, file, exists, options)
        errors.push(...result.errors)
        if (result.text === text) continue
        changed.push(file)
        if (!options.check) await writeFile(file, result.text)
    }
    if (errors.length) throw new Error('Declaration imports that consumers cannot resolve:\n' + errors.join('\n'))
    return {files, changed}
}

/**
 * Rewrites relative import specifiers in declaration files to the explicit `.js` form, for
 * consumers on `moduleResolution: node16 | nodenext`.
 *
 * The vite-plugin-dts `afterBuild` hook: `dts({afterBuild: fixDtsImports})`.
 * Throws when a relative specifier matches no declaration file, or a strict subpath has no `.js`;
 * the files that resolve are written before it throws.
 *
 * @param {Map<string, string> | Iterable<string>} emittedFiles file paths (the keys of a Map); only `.d.ts`, `.d.mts`, `.d.cts` files are processed
 * @param {import('./index.js').DtsJsExtensionsOptions} [options]
 * @returns {Promise<void>}
 */
export async function fixDtsImports (emittedFiles, options = {}) {
    await processDeclarations(emittedFiles instanceof Map ? [...emittedFiles.keys()] : [...emittedFiles], options)
}

/**
 * Lists the declaration files below the given directories (or the given files), skipping node_modules.
 * @param {string | string[]} paths
 * @returns {Promise<string[]>}
 */
export async function findDeclarations (paths) {
    const out = []
    const walk = async p => {
        const entries = await readdir(p, {withFileTypes: true})
        for (const e of entries) {
            const full = path.join(p, e.name)
            if (e.isDirectory()) {
                if (e.name !== 'node_modules') await walk(full)
            } else if (declarationRE.test(e.name)) {
                out.push(full)
            }
        }
    }
    for (const p of Array.isArray(paths) ? paths : [paths]) {
        if (!existsSync(p)) throw new Error(`${p} does not exist`)
        if ((await stat(p)).isDirectory()) await walk(p)
        else if (declarationRE.test(p)) out.push(p)
    }
    return out.sort()
}

/**
 * {@link fixDtsImports} for every declaration file below the given directories (or the given
 * files), such as the output directory of `tsc`.
 * @param {string | string[]} dirs
 * @param {import('./index.js').DtsJsExtensionsOptions} [options]
 * @returns {Promise<{files: string[], changed: string[]}>}
 */
export async function fixDtsDirectory (dirs, options = {}) {
    return processDeclarations(await findDeclarations(dirs), options)
}
