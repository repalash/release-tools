// Announces a release that waits for approval, or a failed check/build/pack.
// 1. Starts a Claude Code routine session that reviews the release (once, for all packages), when
//    the build succeeded, the event is a push by REVIEW_ACTOR and the routine secrets are set.
//    A failed request is logged and does not fail the step.
// 2. Posts a Discord notice with the approval link, the review session link and the commits.
//    No notice when DISCORD_WEBHOOK_URL is unset. A failed post fails the step.
// Any error (RELEASE missing, a failed request) is posted to Discord too, then fails the step.
// `--failed <step>`: only posts that the release <step> failed, for the jobs that have no notice of
// their own (the workflow runs it when such a job fails).
//
// Env: RELEASE_FILE or RELEASE (JSON from check.mjs), BUILD_OK ('true'), REVIEW_ACTOR, DISCORD_WEBHOOK_URL,
// CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN, and the GitHub Actions defaults.
import {discordText, failureText, firePayload, parseRelease, readRelease, reviewEligible, reviewText} from './lib.mjs'

const env = process.env

async function postDiscord (content) {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content, allowed_mentions: {parse: []}}),
    })
    if (!res.ok) throw new Error(`Discord webhook: HTTP ${res.status}`)
}

async function startReview (release, buildOk) {
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

async function notify () {
    const buildOk = env.BUILD_OK === 'true'
    const json = readRelease(env)
    // the check job failed before it wrote the release (no packages listed, nothing built)
    if (!buildOk && !json) {
        if (env.DISCORD_WEBHOOK_URL) await postDiscord(failureText({step: 'check'}))
        else console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice that the check failed.')
        return
    }
    const release = parseRelease(json)
    const session = await startReview(release, buildOk)
    if (!env.DISCORD_WEBHOOK_URL) {
        console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice. Repository setup: https://github.com/repalash/release-tools#repository-setup')
        return
    }
    await postDiscord(discordText({ok: buildOk, repository: release.repository, runUrl: release.runUrl, packages: release.packages, errors: release.errors, session}))
    console.log('Discord notice sent.')
}

const failedAt = process.argv.indexOf('--failed')
try {
    if (failedAt < 0) await notify()
    else if (env.DISCORD_WEBHOOK_URL) await postDiscord(failureText({step: process.argv[failedAt + 1] || 'run'}))
} catch (e) {
    console.error(e)
    if (failedAt < 0 && env.DISCORD_WEBHOOK_URL) {
        await postDiscord(failureText({step: 'notice', error: e.message})).catch(e2 => console.error(e2.message))
    }
    process.exit(1)
}
