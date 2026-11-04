// Fails unless a GitHub environment requires a reviewer. GitHub creates a missing environment on first use, without
// protection rules, so a job in it would run without the approval that the release or deploy relies on.
//
// Usage: node require-reviewer.mjs <environment>
// Env: GH_TOKEN, GITHUB_REPOSITORY.
import {execFileSync} from 'node:child_process'

const environment = process.argv[2]
if (!environment) throw new Error('usage: require-reviewer.mjs <environment>')
const repository = process.env.GITHUB_REPOSITORY
let reviewers = 0
try {
    reviewers = Number(execFileSync('gh', ['api', `repos/${repository}/environments/${encodeURIComponent(environment)}`,
        '--jq', '[.protection_rules[]? | select(.type == "required_reviewers")] | length'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim())
} catch (e) {
    console.log(`The environment could not be read: ${String(e.stderr || e.message).split('\n')[0]}`)
}
if (!reviewers) {
    console.log(`::error::The ${environment} environment of ${repository} is missing or has no required reviewer. Set it up first: https://github.com/repalash/release-tools#repository-setup`)
    process.exit(1)
}
console.log(`${environment} requires a reviewer.`)
