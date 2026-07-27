import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APPROVED_SPECS = [
    'cypress/e2e/1-apikey/apikey.cy.js',
    'cypress/e2e/2-variables/variables.cy.js',
    'cypress/e2e/3-chatflows/chatflow-continuity.cy.js',
    'cypress/e2e/4-pc-core/pc-core-continuity.cy.js'
]

const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const SAFE_FAILURE_REASONS = new Set([
    'server-spawn-failed',
    'server-exited-before-ready',
    'server-startup-timeout',
    'server-exited-during-browser',
    'cypress-spawn-failed',
    'unexpected-runner-error'
])

class RunnerFailure extends Error {
    constructor(reason, result) {
        super(reason)
        this.name = 'RunnerFailure'
        this.reason = reason
        this.result = result
    }
}

export const assertLoopbackHttpUrl = (value) => {
    let parsed
    try {
        parsed = new URL(value)
    } catch {
        throw new Error('Authenticated E2E requires a loopback HTTP origin')
    }

    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
    if (
        parsed.protocol !== 'http:' ||
        !loopbackHosts.has(parsed.hostname) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
    ) {
        throw new Error('Authenticated E2E requires a loopback HTTP origin')
    }

    return parsed
}

export const isOwnedTempPath = (candidate, tempRoot) => {
    const resolvedRoot = path.resolve(tempRoot)
    const resolvedCandidate = path.resolve(candidate)
    return path.dirname(resolvedCandidate) === resolvedRoot && path.basename(resolvedCandidate).startsWith('flowise-e2e-')
}

export const parseRunnerArgs = (args, approvedSpecs) => {
    let browser
    let specs = approvedSpecs

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]
        const value = args[index + 1]
        if (argument === '--browser') {
            if (!value || value.startsWith('--')) throw new Error('Missing value for --browser')
            browser = value
            index += 1
        } else if (argument === '--spec') {
            if (!value || !approvedSpecs.includes(value)) {
                throw new Error('The requested path is not an approved authenticated spec')
            }
            specs = [value]
            index += 1
        } else {
            throw new Error(`Unsupported argument: ${argument}`)
        }
    }

    return { browser, specs }
}

export const toExitCode = (code, _signal) => (Number.isInteger(code) ? code : 1)

export const assertCleanupProcessSucceeded = (result) => {
    if (toExitCode(result?.code, result?.signal) !== 0) throw new Error('Cleanup process failed')
}

export const resolveFinalExitCode = (runExitCode, cleanupFailures) => (cleanupFailures.length === 0 ? runExitCode : 1)

export const formatFailureEvent = (runId, reason, result) => {
    const safeReason = SAFE_FAILURE_REASONS.has(reason) ? reason : 'unexpected-runner-error'
    const exit = Number.isInteger(result?.code) ? String(result.code) : 'unavailable'
    const signal = typeof result?.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal) ? result.signal : 'unavailable'
    return `[flowise-e2e] phase=failed run=${runId} reason=${safeReason} exit=${exit} signal=${signal}\n`
}

export const formatCleanupEvent = (runId, signalReceived, cleanupFailures) => {
    if (cleanupFailures.length > 0) {
        return `[flowise-e2e] phase=cleanup-failed run=${runId} resources=${cleanupFailures.join(',')}\n`
    }
    return `[flowise-e2e] phase=cleanup run=${runId} status=${signalReceived ? 'interrupted' : 'complete'}\n`
}

const delay = (milliseconds, signal) => {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve(false)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve(true)
        }, milliseconds)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
    })
}

export const selectUnusedLoopbackPort = async () => {
    const server = createServer()
    server.unref()
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
        server.close()
        throw new Error('Unable to allocate an authenticated E2E loopback port')
    }
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    return address.port
}

const createChildResult = (child) =>
    new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
    })

export const buildChildEnvironment = ({ baseUrl, runId, tempDirectory }) => {
    const inheritedKeys = [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TERM',
        'TMPDIR',
        'TEMP',
        'TMP',
        'LANG',
        'LC_ALL',
        'CI',
        'NO_COLOR',
        'FORCE_COLOR',
        'NODE_OPTIONS',
        'PNPM_HOME',
        'COREPACK_HOME'
    ]
    const environment = {}
    for (const key of inheritedKeys) {
        if (process.env[key] !== undefined) environment[key] = process.env[key]
    }

    return {
        ...environment,
        ADMIN_ONLY_MODE: 'false',
        APP_URL: baseUrl,
        CORS_ORIGINS: baseUrl,
        DATABASE_PATH: tempDirectory,
        DATABASE_TYPE: 'sqlite',
        DISABLE_FLOWISE_TELEMETRY: 'true',
        FLOWISE_E2E_ARTIFACTS_PATH: path.join(tempDirectory, 'cypress-artifacts'),
        FLOWISE_E2E_BASE_URL: baseUrl,
        FLOWISE_E2E_ISOLATED: '1',
        FLOWISE_E2E_RUN_ID: runId,
        MODE: 'main',
        OFFLINE: 'true',
        PORT: new URL(baseUrl).port,
        POSTHOG_PUBLIC_API_KEY: '',
        SECRETKEY_PATH: tempDirectory
    }
}

export const waitForPing = async (baseUrl, timeoutMilliseconds = STARTUP_TIMEOUT_MS, signal) => {
    const deadline = Date.now() + timeoutMilliseconds
    const pingUrl = new URL('/api/v1/ping', baseUrl)

    while (Date.now() < deadline) {
        if (signal?.aborted) return false
        try {
            const timeoutSignal = AbortSignal.timeout(2_000)
            const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
            const response = await fetch(pingUrl, { signal: requestSignal })
            if (response.ok && (await response.text()).trim() === 'pong') return true
        } catch {
            // The source server is still starting.
        }
        if (signal?.aborted || !(await delay(250, signal))) return false
    }

    throw new RunnerFailure('server-startup-timeout')
}

const processGroupExists = (processGroupId) => {
    try {
        process.kill(-processGroupId, 0)
        return true
    } catch (error) {
        if (error?.code === 'ESRCH') return false
        if (error?.code === 'EPERM') return true
        throw error
    }
}

const waitForProcessGroupExit = async (processGroupId, timeoutMilliseconds = SHUTDOWN_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMilliseconds
    while (Date.now() < deadline) {
        if (!processGroupExists(processGroupId)) return true
        await delay(50)
    }
    return !processGroupExists(processGroupId)
}

const terminateChildTree = async (child) => {
    if (!child?.pid) return

    if (process.platform === 'win32') {
        if (child.exitCode !== null || child.signalCode !== null) return
        const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        assertCleanupProcessSucceeded(await createChildResult(taskkill))
        return
    }

    if (!processGroupExists(child.pid)) return

    try {
        process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error
        return
    }

    if (!(await waitForProcessGroupExit(child.pid))) {
        try {
            process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
            if (error?.code !== 'ESRCH') throw error
        }
        if (!(await waitForProcessGroupExit(child.pid))) throw new Error('Cleanup process failed')
    }
}

const removeOwnedTempDirectory = async (tempDirectory, tempRoot) => {
    if (!isOwnedTempPath(tempDirectory, tempRoot)) {
        throw new Error('Refusing to remove a non-owned authenticated E2E path')
    }
    await rm(tempDirectory, { recursive: true, force: true })
}

export const cleanupRunResources = async ({
    cypressChild,
    serverChild,
    tempDirectory,
    tempRoot,
    terminateChild = terminateChildTree,
    removeTempDirectory = removeOwnedTempDirectory
}) => {
    const failures = []
    const attempt = async (label, action) => {
        try {
            await action()
        } catch {
            failures.push(label)
        }
    }

    if (cypressChild) await attempt('cypress-process', () => terminateChild(cypressChild))
    if (serverChild) await attempt('server-process', () => terminateChild(serverChild))
    if (tempDirectory) {
        await attempt('temporary-directory', () => removeTempDirectory(tempDirectory, tempRoot))
    }
    return failures
}

export const runAuthenticatedE2E = async (args = process.argv.slice(2)) => {
    const { browser, specs } = parseRunnerArgs(args, APPROVED_SPECS)
    const runId = randomUUID()
    const tempRoot = os.tmpdir()
    let tempDirectory
    let serverChild
    let cypressChild
    let signalReceived
    let runExitCode = 1
    let cleanupFailures = []
    const signalHandlers = new Map()

    const signalPromise = new Promise((resolve) => {
        for (const signal of ['SIGINT', 'SIGTERM']) {
            const handler = () => {
                signalReceived = signal
                resolve({ kind: 'signal', signal })
            }
            signalHandlers.set(signal, handler)
            process.once(signal, handler)
        }
    })

    try {
        tempDirectory = await mkdtemp(path.join(tempRoot, 'flowise-e2e-'))
        const port = await selectUnusedLoopbackPort()
        const baseUrl = `http://127.0.0.1:${port}`
        assertLoopbackHttpUrl(baseUrl)
        const env = buildChildEnvironment({ baseUrl, runId, tempDirectory })

        process.stdout.write(`[flowise-e2e] phase=start run=${runId} url=${baseUrl}\n`)
        serverChild = spawn(pnpmExecutable, ['oclif-dev'], {
            cwd: packageRoot,
            detached: process.platform !== 'win32',
            env,
            stdio: 'ignore'
        })
        const serverOutcome = createChildResult(serverChild).then(
            (result) => ({ kind: 'server-exit', result }),
            () => ({ kind: 'server-spawn-error' })
        )
        const startupController = new AbortController()
        let startupOutcome
        try {
            startupOutcome = await Promise.race([
                waitForPing(baseUrl, STARTUP_TIMEOUT_MS, startupController.signal).then((ready) => ({
                    kind: ready ? 'server-ready' : 'startup-cancelled'
                })),
                serverOutcome,
                signalPromise
            ])
        } finally {
            startupController.abort()
        }

        if (startupOutcome.kind === 'server-spawn-error') throw new RunnerFailure('server-spawn-failed')
        if (startupOutcome.kind === 'server-exit') {
            throw new RunnerFailure('server-exited-before-ready', startupOutcome.result)
        }
        if (startupOutcome.kind === 'server-ready') {
            process.stdout.write(`[flowise-e2e] phase=browser run=${runId} url=${baseUrl}\n`)

            const cypressArgs = ['exec', 'cypress', 'run', '--spec', specs.join(',')]
            if (browser) cypressArgs.push('--browser', browser)
            cypressChild = spawn(pnpmExecutable, cypressArgs, {
                cwd: packageRoot,
                detached: process.platform !== 'win32',
                env,
                stdio: 'inherit'
            })
            const cypressOutcome = createChildResult(cypressChild).then(
                (result) => ({ kind: 'cypress-exit', result }),
                () => ({ kind: 'cypress-spawn-error' })
            )

            const outcome = await Promise.race([cypressOutcome, serverOutcome, signalPromise])
            if (outcome.kind === 'cypress-spawn-error') throw new RunnerFailure('cypress-spawn-failed')
            if (outcome.kind === 'server-exit') {
                throw new RunnerFailure('server-exited-during-browser', outcome.result)
            }
            if (outcome.kind === 'server-spawn-error') throw new RunnerFailure('server-spawn-failed')
            if (outcome.kind === 'cypress-exit') runExitCode = toExitCode(outcome.result.code, outcome.result.signal)
        }
    } catch (error) {
        const reason = error instanceof RunnerFailure ? error.reason : 'unexpected-runner-error'
        const result = error instanceof RunnerFailure ? error.result : undefined
        process.stderr.write(formatFailureEvent(runId, reason, result))
        runExitCode = 1
    } finally {
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
        cleanupFailures = await cleanupRunResources({ cypressChild, serverChild, tempDirectory, tempRoot })
        const cleanupEvent = formatCleanupEvent(runId, signalReceived, cleanupFailures)
        if (cleanupFailures.length > 0) process.stderr.write(cleanupEvent)
        else process.stdout.write(cleanupEvent)
    }

    return resolveFinalExitCode(runExitCode, cleanupFailures)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
    process.exitCode = await runAuthenticatedE2E()
}
