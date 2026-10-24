# Changelog

## [0.1.0] - 2026-10-24

- `fixDtsImports`: rewrites relative specifiers in `.d.ts`, `.d.mts` and `.d.cts` files to the
  explicit `.js` form (`./Foo.js`, `./core/index.js`, `./mod.mjs`). Usable as the
  vite-plugin-dts `afterBuild` hook.
- `fixDtsDirectory` and `findDeclarations` for the output directory of `tsc`.
- CLI `dts-js-extensions <dir|file>...` with `--check` and `--strict-subpaths`.
- A relative specifier that matches no declaration file is an error. Non-code files such as
  `./data.json` are left as they are.
