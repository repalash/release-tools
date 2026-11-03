// Gives a deploy command some of the job's secrets (deploy.yml): writes the secrets named in SECRETS_ENV from
// SECRETS_JSON (`toJSON(secrets)`, all of them) to $GITHUB_ENV, so the next steps get those in their environment. It
// runs as its own step, so the others are not in the deploy command's environment, nor in its parent's. This is not a
// boundary against the caller's code: install and deploy run on the same runner, as the same user, and can change what
// later steps run. Pass the reusable workflow only the secrets the job needs. Fails when a listed secret is missing.
//
// Env: SECRETS_JSON, SECRETS_ENV (names, separated by spaces or commas), GITHUB_ENV.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {pickSecrets} from './lib.mjs'

const picked = pickSecrets(JSON.parse(process.env.SECRETS_JSON || '{}'), process.env.SECRETS_ENV)
const file = process.env.GITHUB_ENV
if (!file) throw new Error('GITHUB_ENV is not set')
// the multiline form, with a delimiter no value contains
const lines = Object.entries(picked).map(([name, value]) => {
    let eof
    do eof = `EOF_${crypto.randomBytes(8).toString('hex')}`; while (value.includes(eof))
    return `${name}<<${eof}\n${value}\n${eof}\n`
})
fs.appendFileSync(file, lines.join(''))
console.log(`Secrets for the deploy: ${Object.keys(picked).join(', ') || 'none'}`)
