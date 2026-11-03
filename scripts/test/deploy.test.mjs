import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const notify = path.join(import.meta.dirname, '..', 'deploy-notify.mjs')
const runner = path.join(import.meta.dirname, '..', 'run-with-secrets.mjs')
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
            res.end(req.url === '/fire' ? JSON.stringify({claude_code_session_url: 'https://claude.ai/code/session_test'}) : '{}')
        })
    })
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    return {requests, base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close()}
}

function env (base, extra) {
    return {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '9',
        GITHUB_SHA: 'HEAD', GITHUB_EVENT_NAME: 'push', GITHUB_ACTOR: 'owner', REVIEW_ACTOR: 'owner',
        ENVIRONMENT: 'cloud-deploy', NAME: 'threepipe cloud', WORKING_DIRECTORY: 'scripts',
        CLAUDE_REVIEW_FIRE_URL: `${base}/fire`, CLAUDE_REVIEW_TOKEN: 'test-token', DISCORD_WEBHOOK_URL: `${base}/discord`,
        ...extra,
    }
}

test('deploy notice: fires the review, then posts the approval link with the session', async () => {
    const s = await server()
    try {
        await run(process.execPath, [notify], {env: env(s.base), cwd: path.join(import.meta.dirname, '..', '..')})
        assert.deepEqual(s.requests.map(r => r.url), ['/fire', '/discord'])
        assert.match(s.requests[0].body.text, /^deploy review\nrepository: owner\/repo\nwhat: threepipe cloud\ndirectory: scripts\nenvironment: cloud-deploy\n/)
        assert.match(s.requests[1].body.content, /^🚀 owner\/repo: \*\*threepipe cloud\*\* `HEAD` is checked and waits for approval to deploy \(cloud-deploy\)\.\nApprove: https:\/\/github\.com\/owner\/repo\/actions\/runs\/9\n🤖 Claude review: https:\/\/claude\.ai\/code\/session_test/)
        assert.deepEqual(s.requests[1].body.allowed_mentions, {parse: []})
    } finally {
        s.close()
    }
})

test('deploy notice: a failed check gets no review; --failed posts the failed deploy', async () => {
    const s = await server()
    try {
        await run(process.execPath, [notify], {env: env(s.base, {STATE: 'check-failed'})})
        await run(process.execPath, [notify, '--failed'], {env: env(s.base)})
        assert.deepEqual(s.requests.map(r => r.url), ['/discord', '/discord'])
        assert.match(s.requests[0].body.content, /^❌ owner\/repo: the check of \*\*threepipe cloud\*\* `HEAD` failed; nothing is deployed\./)
        assert.match(s.requests[1].body.content, /^❌ owner\/repo: the deploy of \*\*threepipe cloud\*\* `HEAD` \(cloud-deploy\) failed after the approval\./)
    } finally {
        s.close()
    }
})

test('run-with-secrets: the command gets the listed secrets only, not the JSON', async () => {
    const {stdout} = await run(process.execPath, [runner], {env: {
        PATH: process.env.PATH, SECRETS_JSON: JSON.stringify({A: 'one', B: 'two', C: 'three'}), SECRETS_ENV: 'A B',
        COMMAND: 'echo "$A $B ${C:-none} ${SECRETS_JSON:-gone}"',
    }})
    assert.equal(stdout, 'one two none gone\n')
})

test('run-with-secrets: a missing secret stops it before the command; the exit code is the command\'s', async () => {
    await assert.rejects(run(process.execPath, [runner], {env: {PATH: process.env.PATH, SECRETS_JSON: '{}', SECRETS_ENV: 'A', COMMAND: 'echo ran'}}),
        e => /missing secret\(s\): A/.test(e.stderr) && !e.stdout.includes('ran'))
    await assert.rejects(run(process.execPath, [runner], {env: {PATH: process.env.PATH, SECRETS_JSON: '{}', COMMAND: 'exit 3'}}), {code: 3})
})
