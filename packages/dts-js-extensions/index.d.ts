export interface DtsJsExtensionsOptions {
    /** Report the files that need a change, but write nothing. */
    check?: boolean
    /**
     * Packages whose deep imports must end in `.js`, mapped to the subpaths that may omit it
     * (the entries of the package's `exports` map). Example: `{three: ['addons', 'webgpu', 'tsl']}`
     * makes `'three/src/math/MathUtils'` an error, because only node10 resolution finds it.
     */
    strictSubpaths?: Record<string, string[]>
}

export interface DtsJsExtensionsResult {
    /** Absolute paths of the declaration files that were processed. */
    files: string[]
    /** The files that were rewritten (or need a rewrite, with `check`). */
    changed: string[]
}

/**
 * Rewrites relative import specifiers in declaration files to the explicit `.js` form.
 * The vite-plugin-dts `afterBuild` hook: `dts({afterBuild: fixDtsImports})`.
 * Throws when a relative specifier matches no declaration file.
 * @param emittedFiles file paths, or a Map whose keys are file paths
 */
export function fixDtsImports (emittedFiles: Map<string, string> | Iterable<string>, options?: DtsJsExtensionsOptions): Promise<void>

/**
 * {@link fixDtsImports} for every declaration file below the given directories (or the given files).
 * Returns the processed and the changed files.
 */
export function fixDtsDirectory (dirs: string | string[], options?: DtsJsExtensionsOptions): Promise<DtsJsExtensionsResult>

/** The declaration files (.d.ts, .d.mts, .d.cts) below the given directories, without node_modules. */
export function findDeclarations (paths: string | string[]): Promise<string[]>

/**
 * Rewrites the relative specifiers of one declaration file, without file access.
 * @param text contents of the declaration file
 * @param file absolute path of the declaration file
 * @param exists whether a declaration file exists at an absolute path
 */
export function rewriteDeclaration (text: string, file: string, exists: (file: string) => boolean, options?: DtsJsExtensionsOptions): {text: string, errors: string[]}
