import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { defineConfig } from 'cypress'

const isolationMarker = process.env.FLOWISE_E2E_ISOLATED
const baseUrl = process.env.FLOWISE_E2E_BASE_URL
const runId = process.env.FLOWISE_E2E_RUN_ID
const artifactsPath = process.env.FLOWISE_E2E_ARTIFACTS_PATH

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

if (isolationMarker !== '1' || !isLoopbackHttpOrigin(baseUrl) || !runId || !/^[a-zA-Z0-9-]{1,80}$/.test(runId) || !artifactsPath) {
    throw new Error('Authenticated Cypress specs require the isolated local E2E runner')
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
            on('task', {
                getLocalOwner() {
                    return localOwner
                }
            })
            config.env.isolated = true
            config.env.runId = runId
            return config
        }
    }
})
