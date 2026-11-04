// Announces a deploy of deploy.yml: it waits for approval, its check failed, or (`--failed`) the deploy after the
// approval failed.
// - Waiting: starts a Claude Code routine session that reviews the deploy (when the event is a push by REVIEW_ACTOR
//   and the routine secrets are set; a failed request is logged and does not fail the step), then posts the Discord
//   notice: the approval link, the review session and the commits since the last successful deployment of the
//   environment. When that commit is not in this history (a force-push), the notice says so and lists the last ones.
// - No notice when DISCORD_WEBHOOK_URL is unset. An error (a failed post) is posted as `the deploy notice failed`
//   when possible, then fails the step.
//
// Env: STATE (`waiting` or `check-failed`; `--failed` sets `deploy-failed`), ENVIRONMENT, NAME, WORKING_DIRECTORY,
// REVIEW_ACTOR, DISCORD_WEBHOOK_URL, CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN, GH_TOKEN (deployments: read; without
// it the last commits are listed), and the GitHub Actions defaults. Waiting runs in a checkout of the caller with history.
import {parseArgs} from 'node:util'
import {
    commitsBetween, deployDiscordText, deployReviewText, failureText, fireReview, hasCommit, lastDeployedSha, postDiscord,
    reviewEligible,
} from './lib.mjs'

const env = process.env
const {values: args} = parseArgs({options: {failed: {type: 'boolean', default: false}}})
const state = args.failed ? 'deploy-failed' : env.STATE || 'waiting'
const repository = env.GITHUB_REPOSITORY
const sha = env.GITHUB_SHA
const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
const environment = env.ENVIRONMENT
const name = env.NAME || `${repository} (${environment})`

/** The commits since the last deploy, and what that range is (for the review). */
function changes () {
    const dir = env.WORKING_DIRECTORY || '.'
    const previous = env.GH_TOKEN ? lastDeployedSha(repository, environment) : ''
    if (previous && !hasCommit('.', previous)) {
        return {dir, previous: `${previous} (not in this history: the last commits instead)`, commits: commitsBetween('.', '', sha, dir)}
    }
    return {dir, previous, commits: commitsBetween('.', previous, sha, dir)}
}

async function notify () {
    let commits = []
    let session = ''
    if (state === 'waiting') {
        const c = changes()
        commits = c.commits
        const {fire, reason} = reviewEligible({
            buildOk: true, event: env.GITHUB_EVENT_NAME, actor: env.GITHUB_ACTOR, reviewActor: env.REVIEW_ACTOR,
            url: env.CLAUDE_REVIEW_FIRE_URL, token: env.CLAUDE_REVIEW_TOKEN,
        })
        if (fire) {
            session = await fireReview({url: env.CLAUDE_REVIEW_FIRE_URL, token: env.CLAUDE_REVIEW_TOKEN,
                text: deployReviewText({repository, sha, runUrl, environment, name, workingDirectory: c.dir, previous: c.previous, commits})})
        } else {
            console.log(`Claude review skipped: ${reason}.`)
        }
    }
    if (!env.DISCORD_WEBHOOK_URL) {
        console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice.')
        return
    }
    await postDiscord(env.DISCORD_WEBHOOK_URL, deployDiscordText({state, repository, runUrl, environment, name, sha, commits, session}))
    console.log('Discord notice sent.')
}

try {
    await notify()
} catch (e) {
    console.error(e)
    if (env.DISCORD_WEBHOOK_URL) {
        await postDiscord(env.DISCORD_WEBHOOK_URL, failureText({what: 'deploy', step: 'notice', error: e.message})).catch(e2 => console.error(e2.message))
    }
    process.exit(1)
}
