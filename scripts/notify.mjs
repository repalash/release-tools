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
// A partial release (PARTIAL): the packages it leaves out are decided as publish.mjs decides them, from the tarballs
// in TARBALLS_DIR (partialPlan), so the approver sees what will be published; FAILED_FILE (from pack.mjs) only gives
// the reason of each.
//
// Env: RELEASE_FILE or RELEASE (JSON from check.mjs), PARTIAL, TARBALLS_DIR, FAILED_FILE, BUILD_OK ('true'),
// REVIEW_ACTOR, DISCORD_WEBHOOK_URL, CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN, and the GitHub Actions defaults.
import fs from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {discordText, failureText, fireReview, parseRelease, partialPlan, postDiscord, readRelease, reviewEligible, reviewText} from './lib.mjs'

const env = process.env
const discord = content => postDiscord(env.DISCORD_WEBHOOK_URL, content)

/** The packages a partial release leaves out: those publish.mjs will skip, with pack.mjs's reason when it gave one. */
function leftOut (release) {
    if (env.PARTIAL !== 'true') return []
    const dir = env.TARBALLS_DIR || ''
    const built = new Set(release.packages.filter(p => dir && fs.existsSync(path.join(dir, p.tarball))).map(p => p.name))
    const reasons = new Map((env.FAILED_FILE && fs.existsSync(env.FAILED_FILE) ? JSON.parse(fs.readFileSync(env.FAILED_FILE, 'utf8')) : [])
        .map(f => [f.name, String(f.error)]))
    return partialPlan(release.packages, built).skipped.map(({name, reason}) => ({
        name, version: release.packages.find(p => p.name === name).version, error: reasons.get(name) ?? reason,
    }))
}

async function startReview (release, buildOk, failed) {
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
    return fireReview({url: env.CLAUDE_REVIEW_FIRE_URL, token: env.CLAUDE_REVIEW_TOKEN, text: reviewText(release, failed)})
}

async function notify () {
    const buildOk = env.BUILD_OK === 'true'
    const json = readRelease(env)
    // the check job failed before it wrote the release (no packages listed, nothing built)
    if (!buildOk && !json) {
        if (env.DISCORD_WEBHOOK_URL) await discord(failureText({step: 'check'}))
        else console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice that the check failed.')
        return
    }
    const release = parseRelease(json)
    const failed = buildOk ? leftOut(release) : []
    const session = await startReview(release, buildOk, failed)
    if (!env.DISCORD_WEBHOOK_URL) {
        console.log('::warning::DISCORD_WEBHOOK_URL is not set; no notice. Repository setup: https://github.com/repalash/release-tools#repository-setup')
        return
    }
    await discord(discordText({ok: buildOk, repository: release.repository, runUrl: release.runUrl, packages: release.packages, errors: release.errors, failed, session}))
    console.log('Discord notice sent.')
}

const {values: args} = parseArgs({options: {failed: {type: 'string'}}})
try {
    if (!args.failed) await notify()
    else if (env.DISCORD_WEBHOOK_URL) await discord(failureText({step: args.failed}))
    else console.log(`::warning::DISCORD_WEBHOOK_URL is not set; no notice that the ${args.failed} failed.`)
} catch (e) {
    console.error(e)
    if (!args.failed && env.DISCORD_WEBHOOK_URL) {
        await discord(failureText({step: 'notice', error: e.message})).catch(e2 => console.error(e2.message))
    }
    process.exit(1)
}
