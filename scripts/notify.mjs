// Announces a release that waits for approval, or a failed check/build/pack.
// 1. Starts a Claude Code routine session that reviews the release (once, for all packages), when
//    the build succeeded, the event is a push by REVIEW_ACTOR and the routine secrets are set.
//    A failed request is logged and does not fail the step.
// 2. Posts a Discord notice with the approval link, the review session link and the commits.
//    No notice when DISCORD_WEBHOOK_URL is unset. A failed post fails the step.
//
// Env: RELEASE (JSON from check.mjs), BUILD_OK ('true'), REVIEW_ACTOR, DISCORD_WEBHOOK_URL,
// CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN, and the GitHub Actions defaults.
import {discordText, firePayload, parseRelease, reviewEligible, reviewText} from './lib.mjs'

const env = process.env
const release = parseRelease(env.RELEASE)
const buildOk = env.BUILD_OK === 'true'

async function startReview () {
    const {fire, reason} = reviewEligible({
        buildOk,
        event: env.GITHUB_EVENT_NAME,
        actor: env.GITHUB_ACTOR,
        reviewActor: env.REVIEW_ACTOR,
        url: env.CLAUDE_REVIEW_FIRE_URL,
        token: env.CLAUDE_REVIEW_TOKEN,
    })
    if (!fire) {
        console.log(`Claude review skipped: ${reason}.`)
        return ''
    }
    try {
        const res = await fetch(env.CLAUDE_REVIEW_FIRE_URL, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${env.CLAUDE_REVIEW_TOKEN}`,
                'anthropic-beta': 'experimental-cc-routine-2026-04-01',
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify(firePayload(reviewText(release))),
        })
        const body = await res.json().catch(() => ({}))
        if (res.ok && body.claude_code_session_url) {
            console.log(`Claude review session: ${body.claude_code_session_url}`)
            return body.claude_code_session_url
        }
        console.log(`Claude review request failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`)
    } catch (e) {
        console.log(`Claude review request failed: ${e.message}`)
    }
    return ''
}

const session = await startReview()

if (!env.DISCORD_WEBHOOK_URL) {
    console.log('DISCORD_WEBHOOK_URL is not set; no notice.')
    process.exit(0)
}
const content = discordText({ok: buildOk, repository: release.repository, runUrl: release.runUrl, packages: release.packages, errors: release.errors, session})
const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({content, allowed_mentions: {parse: []}}),
})
if (!res.ok) {
    console.error(`Discord webhook: HTTP ${res.status}`)
    process.exit(1)
}
console.log('Discord notice sent.')
