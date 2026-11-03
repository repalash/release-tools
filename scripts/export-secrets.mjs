// Gives a deploy command some of the job's secrets (deploy.yml): writes the secrets named in SECRETS_ENV from
// SECRETS_JSON (`toJSON(secrets)`, all of them) to $GITHUB_ENV, so the next steps have only those. It runs as its own
// step before any caller code, so the caller's deploy command never sees the others (not even in a parent process's
// environment). Fails when a listed secret is missing or empty.
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
