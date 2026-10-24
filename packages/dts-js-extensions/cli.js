#!/usr/bin/env node
import path from 'node:path'
import {parseArgs} from 'node:util'
import {fixDtsDirectory} from './index.js'

const usage = `Usage: dts-js-extensions [options] <dir|file>...

Rewrites relative import specifiers in .d.ts/.d.mts/.d.cts files to the explicit .js form
(./foo -> ./foo.js, ./dir -> ./dir/index.js) for moduleResolution node16/nodenext.

Options:
  --check                     Write nothing; exit 1 when a file needs a change.
  --strict-subpaths <spec>    <pkg>[=<sub>,<sub>]: a '<pkg>/<subpath>' import without .js is an
                              error unless <subpath> is listed. Repeatable.
                              Example: --strict-subpaths three=addons,webgpu,tsl
  -h, --help                  Show this help.`

let parsed
try {
    parsed = parseArgs({
        allowPositionals: true,
        options: {
            'check': {type: 'boolean', default: false},
            'strict-subpaths': {type: 'string', multiple: true, default: []},
            'help': {type: 'boolean', short: 'h', default: false},
        },
    })
} catch (e) {
    console.error(`${e.message}\n\n${usage}`)
    process.exit(2)
}
const {values, positionals} = parsed
if (values.help || !positionals.length) {
    console.log(usage)
    process.exit(values.help ? 0 : 2)
}

const strictSubpaths = {}
for (const spec of values['strict-subpaths']) {
    const [pkg, subs = ''] = spec.split('=')
    strictSubpaths[pkg] = subs.split(',').filter(Boolean)
}

try {
    const {files, changed} = await fixDtsDirectory(positionals, {check: values.check, strictSubpaths})
    const rel = changed.map(f => path.relative(process.cwd(), f))
    if (values.check) {
        if (changed.length) {
            console.error(`${changed.length} of ${files.length} declaration files have imports without .js:\n${rel.join('\n')}`)
            process.exit(1)
        }
        console.log(`${files.length} declaration files checked; all relative imports are explicit.`)
    } else {
        console.log(`${changed.length} of ${files.length} declaration files rewritten.`)
    }
} catch (e) {
    console.error(e.message)
    process.exit(1)
}
