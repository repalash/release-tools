// Announces a deploy of deploy.yml: it waits for approval, its check failed, or (`--failed`) the deploy after the
// approval failed.
// 1. Waiting: starts a Claude Code routine session that reviews the deploy (when the event is a push by REVIEW_ACTOR
//    and the routine secrets are set; a failed request is logged and does not fail the step), then posts the Discord
//    notice: the approval link, the review session and the commits since the last successful deployment of the
//    environment (GitHub records one per job that runs in it).
// 2. No notice when DISCORD_WEBHOOK_URL is unset. A failed post fails the step.
//
// Env: STATE (`waiting` or `check-failed`; `--failed` sets `deploy-failed`), ENVIRONMENT, NAME, WORKING_DIRECTORY,
// REVIEW_ACTOR, DISCORD_WEBHOOK_URL, CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN, GH_TOKEN (deployments: read),
// and the GitHub Actions defaults. Runs in a checkout with history (the commit list).
import {parseArgs} from 'node:util'
import {commitsBetween, deployDiscordText, deployReviewText, fireReview, lastDeployedSha, postDiscord, reviewEligible} from './lib.mjs'

const env = process.env
const {values: args} = parseArgs({options: {failed: {type: 'boolean', default: false}}})
const state = args.failed ? 'deploy-failed' : env.STATE || 'waiting'
const repository = env.GITHUB_REPOSITORY
const sha = env.GITHUB_SHA
const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
const environment = env.ENVIRONMENT
const name = env.NAME || `${repository} (${environment})`

let commits = []
let session = ''
if (state === 'waiting') {
    // without a token (a local run) the commits are the last ones of the directory
    const previous = env.GH_TOKEN ? lastDeployedSha(repository, environment) : ''
    const dir = env.WORKING_DIRECTORY || '.'
    commits = commitsBetween('.', previous, sha, dir)
    const {fire, reason} = reviewEligible({
        buildOk: true,
        event: env.GITHUB_EVENT_NAME,
        actor: env.GITHUB_ACTOR,
        reviewActor: env.REVIEW_ACTOR,
        url: env.CLAUDE_REVIEW_FIRE_URL,
        token: env.CLAUDE_REVIEW_TOKEN,
    })
    if (fire) {
        session = await fireReview({url: env.CLAUDE_REVIEW_FIRE_URL, token: env.CLAUDE_REVIEW_TOKEN,
            text: deployReviewText({repository, sha, runUrl, environment, name, workingDirectory: dir, previous, commits})})
    } else {
        console.log(`Claude review skipped: ${reason}.`)
    }
}
if (!env.DISCORD_WEBHOOK_URL) {
    console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice.')
} else {
    await postDiscord(env.DISCORD_WEBHOOK_URL, deployDiscordText({state, repository, runUrl, environment, name, sha, commits, session}))
    console.log('Discord notice sent.')
}
