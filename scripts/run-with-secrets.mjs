// Runs a command with some of the job's secrets as environment variables (deploy.yml): the reusable workflow cannot
// name the caller's secrets, so it passes them all as JSON and this picks the listed ones.
//
// Env: SECRETS_JSON (`toJSON(secrets)`), SECRETS_ENV (names, separated by spaces or commas), COMMAND (run with bash).
// Fails before running when a listed secret is missing or empty.
import {spawnSync} from 'node:child_process'
import {pickSecrets} from './lib.mjs'

const {SECRETS_JSON, SECRETS_ENV, COMMAND} = process.env
if (!COMMAND) throw new Error('COMMAND is empty')
const picked = pickSecrets(JSON.parse(SECRETS_JSON || '{}'), SECRETS_ENV)
const env = {...process.env, ...picked}
delete env.SECRETS_JSON
const res = spawnSync('bash', ['-eo', 'pipefail', '-c', COMMAND], {stdio: 'inherit', env})
process.exit(res.status ?? 1)
