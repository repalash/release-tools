# dts-js-extensions

Rewrites the relative import specifiers in emitted TypeScript declaration files to the explicit
`.js` form, so that consumers on `moduleResolution: node16` or `nodenext` can resolve them.

```ts
// dist/index.d.ts, as tsc emits it        // after dts-js-extensions
export * from './core'                     export * from './core/index.js'
export { Foo } from './Foo'                export { Foo } from './Foo.js'
declare module '../IObject' { … }          declare module '../IObject.js' { … }
```

## Why

tsc copies import specifiers into `.d.ts` files as they are written in the source. In a package
with `"type": "module"`, TypeScript with `moduleResolution: node16 | nodenext` does not resolve
extensionless relative imports in declaration files. For those consumers the exports of the
package go missing, and `declare module` augmentations stop applying. The `.js` form works with
`node10`, `node16`, `nodenext` and `bundler` resolution.

## Install

```sh
npm install --save-dev dts-js-extensions
```

Node.js 20 or later. No dependencies.

## With vite-plugin-dts

```js
// vite.config.js
import dts from 'vite-plugin-dts'
import {fixDtsImports} from 'dts-js-extensions'

export default {
    plugins: [
        dts({tsconfigPath: './tsconfig.json', afterBuild: fixDtsImports}),
    ],
}
```

With options:

```js
dts({afterBuild: files => fixDtsImports(files, {strictSubpaths: {three: ['addons', 'webgpu', 'tsl']}})})
```

## With tsc

Add the CLI after the compile step in `package.json`:

```json
{
  "scripts": {
    "compile": "tsc -p . && dts-js-extensions lib/esm",
    "check:dts": "dts-js-extensions --check dist lib"
  }
}
```

```
Usage: dts-js-extensions [options] <dir|file>...

  --check                     Write nothing; exit 1 when a file needs a change.
  --strict-subpaths <spec>    <pkg>[=<sub>,<sub>]: a '<pkg>/<subpath>' import without .js is an
                              error unless <subpath> is listed. Repeatable.
```

## What it rewrites

The specifiers of `from '…'`, `import('…')`, side-effect `import '…'` and `declare module '…'`
in `.d.ts`, `.d.mts` and `.d.cts` files:

| Specifier | Declaration file | Result |
|---|---|---|
| `./Foo` | `Foo.d.ts` | `./Foo.js` |
| `./core`, `./core/` | `core/index.d.ts` | `./core/index.js` |
| `.`, `..` | `index.d.ts` | `./index.js`, `../index.js` |
| `./Foo.js`, `./Foo.ts`, `./Foo.d.ts` | `Foo.d.ts` | `./Foo.js` |
| `./mod` | `mod.d.mts` | `./mod.mjs` |
| `./data.json`, `./style.css` | — | unchanged |
| `some-lib/sub` | — | unchanged |

- A file wins over a folder of the same name, as in TypeScript resolution.
- Lines in comments (`*` or `//` before the specifier) are left as they are.
- A relative specifier that matches no declaration file is an error.
- The run is idempotent.

## API

```ts
import {fixDtsImports, fixDtsDirectory, findDeclarations, rewriteDeclaration} from 'dts-js-extensions'
```

- `fixDtsImports(files, options?)`: rewrites the given files (a `Map` whose keys are paths, or an
  iterable of paths). Returns `Promise<void>`, the vite-plugin-dts `afterBuild` signature.
- `fixDtsDirectory(dirs, options?)`: the same for every declaration file below the given
  directories (or the given files). Returns `{files, changed}`.
- `findDeclarations(dirs)`: the declaration files below the directories, without `node_modules`.
- `rewriteDeclaration(text, file, exists, options?)`: the rewrite of one file's text, without
  file access. Returns `{text, errors}`.

Options:

- `check`: report the files that need a change (`changed`), but write nothing.
- `strictSubpaths`: packages whose deep imports must end in `.js`, mapped to the subpaths that
  may omit it (the entries of the package's `exports` map). `{three: ['addons']}` makes
  `'three/src/math/MathUtils'` an error, because only `node10` resolution finds it.

Errors are collected over all files and thrown together; the files that resolve are written first.

## License

MIT
