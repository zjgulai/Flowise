import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, it } from 'node:test'

import {
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

const approvedSpecs = ['cypress/e2e/1-apikey/apikey.cy.js', 'cypress/e2e/2-variables/variables.cy.js']

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
    it('defaults to both approved specifications', () => {
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
