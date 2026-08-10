import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { defineConfig } from 'cypress'

const isolationMarker = process.env.FLOWISE_E2E_ISOLATED
const baseUrl = process.env.FLOWISE_E2E_BASE_URL
const candidateRevision = process.env.FLOWISE_E2E_CANDIDATE_REVISION
const nodeVersion = process.env.FLOWISE_E2E_NODE_VERSION
const runId = process.env.FLOWISE_E2E_RUN_ID
const artifactsPath = process.env.FLOWISE_E2E_ARTIFACTS_PATH

const disableFeaturesSwitch = 'disable-features'
const gcmCheckinSwitch = 'gcm-checkin-url'
const isolatedGCMCheckinPath = '/__flowise-e2e__/chromium-gcm-checkin'
const chromiumSwitchPrefixes = ['--', '-', '/']
const forbiddenChromiumSwitches = new Set(['disable-web-security', 'host-resolver-rules', 'single-argument'])
const removedChromiumSwitches = new Set(['no-sandbox'])
const requiredChromiumSwitches = ['disable-background-networking', 'disable-domain-reliability']
const requiredDisabledChromiumFeatures = [
    'AutofillServerCommunication',
    'MediaRouter',
    'OptimizationHints',
    'PrivacySandboxSettings4',
    'Translate',
    'TranslateUI'
]

const isLoopbackHttpOrigin = (value: string | undefined) => {
    if (!value) return false
    try {
        const parsed = new URL(value)
        return (
            parsed.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
            !parsed.username &&
            !parsed.password &&
            parsed.pathname === '/' &&
            !parsed.search &&
            !parsed.hash
        )
    } catch {
        return false
    }
}

const parseChromiumSwitch = (argument: string) => {
    const normalizedArgument = argument.trim()
    const prefix = chromiumSwitchPrefixes.find((candidate) => normalizedArgument.startsWith(candidate))
    if (!prefix || normalizedArgument.length === prefix.length) return undefined

    const switchWithValue = normalizedArgument.slice(prefix.length)
    const separatorIndex = switchWithValue.indexOf('=')
    return {
        key: (separatorIndex === -1 ? switchWithValue : switchWithValue.slice(0, separatorIndex)).toLowerCase(),
        value: separatorIndex === -1 ? undefined : switchWithValue.slice(separatorIndex + 1)
    }
}

export const mergeChromiumIsolationArguments = (args: string[], isolatedBaseUrl = baseUrl) => {
    if (!isolatedBaseUrl || !isLoopbackHttpOrigin(isolatedBaseUrl)) {
        throw new Error('Unsafe Chromium GCM check-in origin')
    }

    const isolatedGCMCheckinURL = new URL(isolatedGCMCheckinPath, isolatedBaseUrl).href
    const disabledFeatures = new Set(requiredDisabledChromiumFeatures)
    const preservedArguments: string[] = []

    for (const argument of args) {
        if (argument.trim() === '--') {
            throw new Error('Unsafe Chromium launch argument detected')
        }

        const parsedSwitch = parseChromiumSwitch(argument)
        if (!parsedSwitch) {
            preservedArguments.push(argument)
            continue
        }
        if (forbiddenChromiumSwitches.has(parsedSwitch.key)) {
            throw new Error('Unsafe Chromium launch argument detected')
        }
        if (removedChromiumSwitches.has(parsedSwitch.key)) {
            continue
        }
        if (requiredChromiumSwitches.includes(parsedSwitch.key)) {
            continue
        }
        if (parsedSwitch.key === gcmCheckinSwitch) {
            continue
        }
        if (parsedSwitch.key !== disableFeaturesSwitch) {
            preservedArguments.push(argument)
            continue
        }

        for (const feature of (parsedSwitch.value || '').split(',')) {
            const normalizedFeature = feature.trim()
            if (normalizedFeature) disabledFeatures.add(normalizedFeature)
        }
    }

    for (const requiredSwitch of requiredChromiumSwitches) {
        preservedArguments.push(`--${requiredSwitch}`)
    }

    preservedArguments.push(`--${gcmCheckinSwitch}=${isolatedGCMCheckinURL}`)
    preservedArguments.push(`--${disableFeaturesSwitch}=${[...disabledFeatures].sort().join(',')}`)
    return preservedArguments
}

if (
    isolationMarker !== '1' ||
    !isLoopbackHttpOrigin(baseUrl) ||
    !candidateRevision ||
    !/^[0-9a-f]{40,64}$/.test(candidateRevision) ||
    !nodeVersion ||
    !/^24\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nodeVersion) ||
    !runId ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(runId) ||
    !artifactsPath
) {
    throw new Error('Authenticated Cypress specs require the isolated local E2E runner')
}

const safeMetric = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0)
const safeToken = (value: unknown) => {
    const token = typeof value === 'string' ? value.trim() : ''
    return /^[a-zA-Z0-9._-]{1,80}$/.test(token) ? token : 'unavailable'
}

export const formatBrowserResultReceipt = (rawResults: unknown) => {
    const results = rawResults && typeof rawResults === 'object' ? (rawResults as Record<string, unknown>) : {}
    const browser = results.browser && typeof results.browser === 'object' ? (results.browser as Record<string, unknown>) : {}
    const runs = Array.isArray(results.runs) ? (results.runs as Array<Record<string, unknown>>) : []
    const artifacts = runs.reduce((count, run) => {
        const screenshots = Array.isArray(run.screenshots) ? run.screenshots.length : 0
        const video = typeof run.video === 'string' && run.video ? 1 : 0
        return count + screenshots + video
    }, 0)
    return `[flowise-e2e] phase=browser-result run=${runId} revision=${candidateRevision} node=${nodeVersion} browser=${safeToken(
        browser.name
    )}@${safeToken(browser.version)} specs=${runs.length} tests=${safeMetric(results.totalTests)} failures=${safeMetric(
        results.totalFailed
    )} artifacts=${artifacts}\n`
}

const localOwner = {
    email: `flowise-e2e-${runId}@example.invalid`,
    name: `Flowise E2E ${runId.slice(0, 8)}`,
    password: `FlowiseE2E!${randomBytes(18).toString('base64url')}`
}

export default defineConfig({
    downloadsFolder: path.join(artifactsPath, 'downloads'),
    screenshotsFolder: path.join(artifactsPath, 'screenshots'),
    video: false,
    videosFolder: path.join(artifactsPath, 'videos'),
    e2e: {
        baseUrl,
        setupNodeEvents(on, config) {
            on('before:browser:launch', (browser, launchOptions) => {
                if (browser.family === 'chromium' && browser.name !== 'electron') {
                    launchOptions.args = mergeChromiumIsolationArguments(launchOptions.args)
                    launchOptions.preferences.default.translate = { enabled: false }
                }
                return launchOptions
            })
            on('after:run', (results) => {
                process.stdout.write(formatBrowserResultReceipt(results))
            })
            on('task', {
                getLocalOwner() {
                    return localOwner
                }
            })
            config.env.isolated = true
            config.env.candidateRevision = candidateRevision
            config.env.nodeVersion = nodeVersion
            config.env.runId = runId
            return config
        }
    }
})
