import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import {
    APPROVED_SPECS,
    assertCleanupProcessSucceeded,
    assertLoopbackHttpUrl,
    cleanupRunResources,
    formatCleanupEvent,
    formatFailureEvent,
    isOwnedTempPath,
    parseRunnerArgs,
    resolveFinalExitCode,
    toExitCode,
    waitForPing
} from './local-authenticated-e2e.mjs'

const approvedSpecs = APPROVED_SPECS
const chatflowContinuitySpec = 'cypress/e2e/3-chatflows/chatflow-continuity.cy.js'
const pcCoreContinuitySpec = 'cypress/e2e/4-pc-core/pc-core-continuity.cy.js'

const processGroupExists = (processGroupId) => {
    try {
        process.kill(-processGroupId, 0)
        return true
    } catch (error) {
        if (error?.code === 'ESRCH') return false
        throw error
    }
}

describe('assertLoopbackHttpUrl', () => {
    it('accepts HTTP loopback origins', () => {
        assert.equal(assertLoopbackHttpUrl('http://127.0.0.1:3010').origin, 'http://127.0.0.1:3010')
        assert.equal(assertLoopbackHttpUrl('http://localhost:3010').origin, 'http://localhost:3010')
        assert.equal(assertLoopbackHttpUrl('http://[::1]:3010').origin, 'http://[::1]:3010')
    })

    it('rejects remote, credentialed, and HTTPS URLs', () => {
        for (const value of ['https://127.0.0.1:3010', 'http://flowise.example.com', 'http://user@127.0.0.1:3010']) {
            assert.throws(() => assertLoopbackHttpUrl(value), /loopback HTTP origin/)
        }
    })
})

describe('isOwnedTempPath', () => {
    it('accepts only a direct flowise-e2e child of the supplied temp root', () => {
        assert.equal(isOwnedTempPath('/safe/tmp/flowise-e2e-abc123', '/safe/tmp'), true)
        assert.equal(isOwnedTempPath('/safe/tmp/flowise-e2e-abc123/nested', '/safe/tmp'), false)
        assert.equal(isOwnedTempPath('/safe/tmp/unrelated', '/safe/tmp'), false)
        assert.equal(isOwnedTempPath('/safe/tmp/../important', '/safe/tmp'), false)
    })
})

describe('parseRunnerArgs', () => {
    it('approves the isolated Chatflow continuity specification', () => {
        assert.ok(APPROVED_SPECS.includes(chatflowContinuitySpec))
        assert.deepEqual(parseRunnerArgs(['--spec', chatflowContinuitySpec], APPROVED_SPECS), {
            browser: undefined,
            specs: [chatflowContinuitySpec]
        })
    })

    it('defaults to all approved specifications', () => {
        assert.deepEqual(parseRunnerArgs([], approvedSpecs), { browser: undefined, specs: approvedSpecs })
    })

    it('accepts a narrower approved spec and an explicit browser', () => {
        assert.deepEqual(parseRunnerArgs(['--spec', approvedSpecs[0], '--browser', 'chrome'], approvedSpecs), {
            browser: 'chrome',
            specs: [approvedSpecs[0]]
        })
    })

    it('rejects unknown flags and specs outside the approved set', () => {
        assert.throws(() => parseRunnerArgs(['--headed'], approvedSpecs), /Unsupported argument/)
        assert.throws(() => parseRunnerArgs(['--spec', '../other.cy.js'], approvedSpecs), /approved authenticated spec/)
    })
})

describe('Chatflow continuity specification contract', () => {
    it('keeps the lifecycle run-scoped, loopback-only, provider-guarded, and failure-cleanable', async () => {
        const source = await readFile(new URL('../e2e/3-chatflows/chatflow-continuity.cy.js', import.meta.url), 'utf8')

        assert.match(source, /Cypress\.config\('baseUrl'\)/)
        assert.match(source, /Cypress\.env\('runId'\)/)
        assert.match(source, /afterEach\(/)
        for (const lifecycleAlias of ['createChatflow', 'reopenChatflow', 'copyChatflow', 'deleteChatflow']) {
            assert.match(source, new RegExp(lifecycleAlias))
        }
        for (const forbiddenPath of ['prediction', 'chatmessage', 'vector', 'assistant']) {
            assert.match(source, new RegExp(forbiddenPath))
        }
    })
})

describe('PC core continuity specification contract', () => {
    it('keeps the four-route PC run loopback-only, provider-guarded, and failure-cleanable', async () => {
        assert.ok(APPROVED_SPECS.includes(pcCoreContinuitySpec))
        const source = await readFile(new URL('../e2e/4-pc-core/pc-core-continuity.cy.js', import.meta.url), 'utf8')

        for (const route of ['/account', '/chatflows', '/agentflows', '/document-stores']) {
            assert.match(source, new RegExp(route.replaceAll('/', '\\/')))
        }
        assert.match(source, /Cypress\.config\('baseUrl'\)/)
        assert.match(source, /Cypress\.env\('runId'\)/)
        assert.match(source, /isPageInitiatedRequest/)
        assert.match(source, /request\.headers\.origin/)
        assert.match(source, /request\.headers\.referer/)
        assert.match(source, /afterEach\(/)
        assert.match(source, /createdChatflowIds/)
        assert.match(source, /createdDocumentStoreIds/)
        for (const forbiddenPath of ['prediction', 'chatmessage', 'vector', 'assistant', 'webhook']) {
            assert.match(source, new RegExp(forbiddenPath))
        }
    })
})

describe('isolated Chrome launch contract', () => {
    it('disables browser translation traffic without weakening application origin checks', async () => {
        const source = await readFile(new URL('../../cypress.config.ts', import.meta.url), 'utf8')

        assert.match(source, /before:browser:launch/)
        assert.match(source, /--disable-features=Translate,TranslateUI/)
        assert.match(source, /translate = \{ enabled: false \}/)
    })
})

describe('toExitCode', () => {
    it('preserves integer exit codes and maps signal exits to failure', () => {
        assert.equal(toExitCode(0, null), 0)
        assert.equal(toExitCode(7, null), 7)
        assert.equal(toExitCode(null, 'SIGTERM'), 1)
    })
})

describe('cleanup failure handling', () => {
    it('terminates descendants after the detached wrapper has already exited', { skip: process.platform === 'win32' }, async () => {
        const wrapper = spawn(
            process.execPath,
            [
                '-e',
                "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); child.unref()"
            ],
            { detached: true, stdio: 'ignore' }
        )

        await once(wrapper, 'close')
        assert.notEqual(wrapper.exitCode, null)
        assert.equal(processGroupExists(wrapper.pid), true)

        try {
            const failures = await cleanupRunResources({ cypressChild: wrapper })

            assert.deepEqual(failures, [])
            assert.equal(processGroupExists(wrapper.pid), false)
        } finally {
            if (processGroupExists(wrapper.pid)) process.kill(-wrapper.pid, 'SIGKILL')
        }
    })

    it('attempts every owned cleanup and forces a failed final exit', async () => {
        const calls = []
        const cypressChild = { name: 'cypress' }
        const serverChild = { name: 'server' }
        const failures = await cleanupRunResources({
            cypressChild,
            serverChild,
            tempDirectory: '/safe/tmp/flowise-e2e-run',
            tempRoot: '/safe/tmp',
            terminateChild: async (child) => {
                calls.push(`terminate:${child.name}`)
                throw new Error('simulated termination failure')
            },
            removeTempDirectory: async () => {
                calls.push('remove:temporary-directory')
                throw new Error('simulated removal failure')
            }
        })

        assert.deepEqual(calls, ['terminate:cypress', 'terminate:server', 'remove:temporary-directory'])
        assert.deepEqual(failures, ['cypress-process', 'server-process', 'temporary-directory'])
        assert.equal(resolveFinalExitCode(0, failures), 1)
        assert.equal(
            formatCleanupEvent('run-1', undefined, failures),
            '[flowise-e2e] phase=cleanup-failed run=run-1 resources=cypress-process,server-process,temporary-directory\n'
        )
        assert.doesNotMatch(formatCleanupEvent('run-1', undefined, failures), /status=complete/)
    })

    it('accepts only a successful cleanup subprocess result', () => {
        assert.doesNotThrow(() => assertCleanupProcessSucceeded({ code: 0, signal: null }))
        assert.throws(() => assertCleanupProcessSucceeded({ code: 1, signal: null }), /Cleanup process failed/)
        assert.throws(() => assertCleanupProcessSucceeded({ code: null, signal: 'SIGKILL' }), /Cleanup process failed/)
    })
})

describe('safe runner diagnostics', () => {
    it('reports an allowlisted reason and child exit metadata without raw error text', () => {
        const event = formatFailureEvent('run-2', 'server-exited-before-ready', { code: 17, signal: null })

        assert.equal(event, '[flowise-e2e] phase=failed run=run-2 reason=server-exited-before-ready exit=17 signal=unavailable\n')
        assert.doesNotMatch(event, /database|password|simulated/i)
    })

    it('downgrades unknown reasons and sanitizes unavailable process metadata', () => {
        assert.equal(
            formatFailureEvent('run-3', 'raw sensitive failure', { code: undefined, signal: 'not safe value' }),
            '[flowise-e2e] phase=failed run=run-3 reason=unexpected-runner-error exit=unavailable signal=unavailable\n'
        )
    })
})

describe('startup wait cancellation', () => {
    it('releases the health-check timer immediately when its competing outcome wins', async () => {
        const controller = new AbortController()
        const startedAt = Date.now()
        const pendingWait = waitForPing('http://127.0.0.1:1', 120_000, controller.signal)

        controller.abort()

        assert.equal(await pendingWait, false)
        assert.ok(Date.now() - startedAt < 1_000)
    })
})
