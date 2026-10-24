import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const script = path.join(import.meta.dirname, '..', 'notify.mjs')
const run = promisify(execFile)

/** A local server that records requests; /fire answers with a session URL. */
async function server () {
    const requests = []
    const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            requests.push({url: req.url, headers: req.headers, body: JSON.parse(body)})
            res.setHeader('content-type', 'application/json')
            if (req.url === '/fire') res.end(JSON.stringify({claude_code_session_url: 'https://claude.ai/code/session_test'}))
            else res.end('{}')
        })
    })
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    return {requests, base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close()}
}

const release = {
    repository: 'owner/repo',
    sha: 'f00d',
    runUrl: 'https://github.com/owner/repo/actions/runs/1',
    packages: [{name: 'pkg', version: '1.0.1', dir: '.', tag: 'publish@1.0.1', distTag: '', previousTag: 'publish@1.0.0', commits: ['abc1234 Fix a thing']}],
    errors: [],
}

function env (base, extra) {
    return {
        PATH: process.env.PATH,
        RELEASE: JSON.stringify(release),
        BUILD_OK: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_ACTOR: 'owner',
        REVIEW_ACTOR: 'owner',
        CLAUDE_REVIEW_FIRE_URL: `${base}/fire`,
        CLAUDE_REVIEW_TOKEN: 'test-token',
        DISCORD_WEBHOOK_URL: `${base}/discord`,
        ...extra,
    }
}

test('fires the review routine, then posts the notice with the session link', async () => {
    const s = await server()
    try {
        await run(process.execPath, [script], {env: env(s.base)})
        assert.equal(s.requests.length, 2)
        const [fire, discord] = s.requests
        assert.equal(fire.url, '/fire')
        assert.equal(fire.headers.authorization, 'Bearer test-token')
        assert.equal(fire.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01')
        assert.equal(fire.headers['anthropic-version'], '2023-06-01')
        assert.deepEqual(Object.keys(fire.body), ['text'])
        assert.match(fire.body.text, /^npm release review\nrepository: owner\/repo\n/)
        assert.match(fire.body.text, /- pkg@1\.0\.1\n {2}directory: \.\n/)
        assert.equal(discord.url, '/discord')
        assert.match(discord.body.content, /Approve: https:\/\/github\.com\/owner\/repo\/actions\/runs\/1\n🤖 Claude review: https:\/\/claude\.ai\/code\/session_test\n/)
        assert.deepEqual(discord.body.allowed_mentions, {parse: []})
    } finally {
        s.close()
    }
})

test('a failed build gets a notice and no review', async () => {
    const s = await server()
    try {
        await run(process.execPath, [script], {env: env(s.base, {BUILD_OK: 'false'})})
        assert.deepEqual(s.requests.map(r => r.url), ['/discord'])
        assert.match(s.requests[0].body.content, /^❌ owner\/repo: the check, build or pack of \*\*pkg@1\.0\.1\*\* failed/)
    } finally {
        s.close()
    }
})

test('another actor gets no review; no webhook means no notice', async () => {
    const s = await server()
    try {
        const {stdout} = await run(process.execPath, [script], {env: env(s.base, {GITHUB_ACTOR: 'someone', DISCORD_WEBHOOK_URL: ''})})
        assert.equal(s.requests.length, 0)
        assert.match(stdout, /Claude review skipped: the actor someone is not the review actor/)
        assert.match(stdout, /DISCORD_WEBHOOK_URL is not set; no notice/)
    } finally {
        s.close()
    }
})
