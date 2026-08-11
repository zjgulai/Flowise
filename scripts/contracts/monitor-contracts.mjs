import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const loadSchema = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))

export const schemas = Object.freeze({
    releaseInput: loadSchema('release-staleness.input.schema.json'),
    releaseReceipt: loadSchema('release-staleness.receipt.schema.json'),
    observabilityInput: loadSchema('observability.input.schema.json'),
    observabilityReceipt: loadSchema('observability.receipt.schema.json')
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameJsonValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const utcTimestampPattern = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/

const isStrictUtcTimestamp = (value) => {
    const match = utcTimestampPattern.exec(value)
    if (!match) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return day <= daysInMonth[month - 1]
}

const resolveLocalRef = (rootSchema, reference) => {
    if (!reference.startsWith('#/')) return undefined
    return reference
        .slice(2)
        .split('/')
        .reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema)
}

export const validateSchema = (schema, value) => {
    const errors = []

    const visit = (current, candidate, path, rootSchema) => {
        if (current.$ref) {
            const referenced = resolveLocalRef(rootSchema, current.$ref)
            if (!referenced) {
                errors.push(`${path}: unresolved local schema reference`)
                return
            }
            visit(referenced, candidate, path, rootSchema)
            return
        }

        if (Object.hasOwn(current, 'const') && !sameJsonValue(candidate, current.const)) {
            errors.push(`${path}: must equal the contract constant`)
        }
        if (current.enum && !current.enum.some((allowed) => sameJsonValue(candidate, allowed))) {
            errors.push(`${path}: must use an allowed contract value`)
        }

        if (current.type === 'object') {
            if (!isObject(candidate)) {
                errors.push(`${path}: must be an object`)
                return
            }
            for (const required of current.required ?? []) {
                if (!Object.hasOwn(candidate, required)) errors.push(`${path}.${required}: is required`)
            }
            if (current.additionalProperties === false) {
                for (const key of Object.keys(candidate)) {
                    if (!Object.hasOwn(current.properties ?? {}, key)) errors.push(`${path}.${key}: is not allowed`)
                }
            }
            for (const [key, propertySchema] of Object.entries(current.properties ?? {})) {
                if (Object.hasOwn(candidate, key)) visit(propertySchema, candidate[key], `${path}.${key}`, rootSchema)
            }
            return
        }

        if (current.type === 'array') {
            if (!Array.isArray(candidate)) {
                errors.push(`${path}: must be an array`)
                return
            }
            if (current.minItems !== undefined && candidate.length < current.minItems) {
                errors.push(`${path}: must contain at least ${current.minItems} items`)
            }
            if (current.maxItems !== undefined && candidate.length > current.maxItems) {
                errors.push(`${path}: must contain at most ${current.maxItems} items`)
            }
            if (current.uniqueItems && new Set(candidate.map((item) => JSON.stringify(item))).size !== candidate.length) {
                errors.push(`${path}: items must be unique`)
            }
            if (current.items) candidate.forEach((item, index) => visit(current.items, item, `${path}[${index}]`, rootSchema))
            return
        }

        if (current.type === 'string') {
            if (typeof candidate !== 'string') {
                errors.push(`${path}: must be a string`)
                return
            }
            if (current.minLength !== undefined && candidate.length < current.minLength) {
                errors.push(`${path}: must contain at least ${current.minLength} characters`)
            }
            if (current.pattern && !new RegExp(current.pattern, 'u').test(candidate)) {
                errors.push(`${path}: must match the contract pattern`)
            }
            if (current.format === 'date-time' && !isStrictUtcTimestamp(candidate)) {
                errors.push(`${path}: must be a valid UTC date-time`)
            }
            return
        }

        if (current.type === 'integer') {
            if (!Number.isInteger(candidate)) {
                errors.push(`${path}: must be an integer`)
                return
            }
        } else if (current.type === 'number' && (typeof candidate !== 'number' || !Number.isFinite(candidate))) {
            errors.push(`${path}: must be a finite number`)
            return
        } else if (current.type === 'boolean' && typeof candidate !== 'boolean') {
            errors.push(`${path}: must be a boolean`)
            return
        }

        if (current.minimum !== undefined && candidate < current.minimum) {
            errors.push(`${path}: must be at least ${current.minimum}`)
        }
    }

    visit(schema, value, '$', schema)
    return errors
}

export class ContractError extends Error {
    constructor(code, issues = []) {
        super(code)
        this.name = 'ContractError'
        this.code = code
        this.issues = issues
    }
}

const requireSchema = (schema, input) => {
    const issues = validateSchema(schema, input)
    if (issues.length > 0) throw new ContractError('SCHEMA_INVALID', issues)
}

const secondsBetween = (later, earlier) => Math.floor((Date.parse(later) - Date.parse(earlier)) / 1000)

export const evaluateReleaseStaleness = (input) => {
    requireSchema(schemas.releaseInput, input)

    const { candidateManifest, deployment, runtime, backup, disk } = input
    const expectedReceiptPath = `/opt/flowise/deployments/${deployment.runId}/${deployment.operation}-receipt.json`
    if (deployment.receiptPath !== expectedReceiptPath) throw new ContractError('RECEIPT_PATH_MISMATCH')

    const expectedState = {
        prepare: 'prepared',
        cutover: 'complete_candidate_active',
        rollback: 'manual_rollback_complete'
    }[deployment.operation]
    if (deployment.state !== expectedState) throw new ContractError('STATE_OPERATION_MISMATCH')
    if (deployment.operation === 'prepare') throw new ContractError('CANDIDATE_NOT_ACTIVE')

    const candidateIdentities = [input.mainRevision, candidateManifest.revision, candidateManifest.ociRevision]
    const deployedIdentities = [deployment.revision, runtime.revision]
    const rolledBack = deployment.operation === 'rollback'
    const identities = rolledBack ? candidateIdentities : [...candidateIdentities, ...deployedIdentities]
    if (new Set(identities).size !== 1 || new Set(deployedIdentities).size !== 1) {
        throw new ContractError('IDENTITY_MISMATCH')
    }
    if (rolledBack && deployment.revision === candidateManifest.revision) {
        throw new ContractError('ROLLBACK_NOT_EFFECTIVE')
    }

    const observedAt = Date.parse(input.observedAt)
    const evidenceTimes = [deployment.createdAt, runtime.observedAt, backup.observedAt, disk.observedAt]
    if (evidenceTimes.some((timestamp) => Date.parse(timestamp) > observedAt)) throw new ContractError('CLOCK_INVALID')

    if (runtime.health === 'no_data' || backup.checksumStatus === 'no_data' || disk.source === 'no_data') {
        throw new ContractError('EVIDENCE_MISSING')
    }
    if (runtime.health !== 'healthy') throw new ContractError('RUNTIME_UNHEALTHY')
    if (backup.checksumStatus !== 'verified') throw new ContractError('BACKUP_CHECKSUM_INVALID')

    const ageSeconds = secondsBetween(input.observedAt, deployment.createdAt)
    const runtimeAgeSeconds = secondsBetween(input.observedAt, runtime.observedAt)
    const backupAgeSeconds = secondsBetween(input.observedAt, backup.observedAt)
    const diskAgeSeconds = secondsBetween(input.observedAt, disk.observedAt)
    const reasons = []
    if (ageSeconds > input.maxAgeSeconds) reasons.push('deployment_age_exceeded')
    if (runtimeAgeSeconds > input.maxAgeSeconds) reasons.push('runtime_age_exceeded')
    if (backupAgeSeconds > input.maxAgeSeconds) reasons.push('backup_age_exceeded')
    if (diskAgeSeconds > input.maxAgeSeconds) reasons.push('disk_age_exceeded')

    return {
        schemaVersion: 1,
        status: rolledBack ? 'rolled_back' : reasons.length > 0 ? 'stale' : 'fresh',
        observedAt: input.observedAt,
        mainRevision: input.mainRevision,
        candidateRevision: candidateManifest.revision,
        deployedRevision: deployment.revision,
        runtimeRevision: runtime.revision,
        runId: deployment.runId,
        receiptDigest: deployment.receiptDigest,
        phase: rolledBack ? 'rolled_back' : 'candidate_active',
        ageSeconds,
        backup: {
            ageSeconds: backupAgeSeconds,
            checksumStatus: backup.checksumStatus
        },
        disk: {
            freeBytes: disk.freeBytes,
            source: disk.source
        },
        evidenceGrades: {
            deployment: deployment.evidenceGrade,
            runtime: runtime.evidenceGrade,
            backup: backup.evidenceGrade,
            disk: disk.evidenceGrade
        },
        reasons,
        providerCall: false
    }
}

const normalizePromql = (query) => query.replace(/\s+/g, ' ').trim()
const canonicalAlertConfiguration = Object.freeze([
    {
        name: 'http_5xx_ratio',
        query: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
        window: '5m',
        threshold: 0.05,
        dataSource: 'prometheus',
        runbook: 'docs/runbooks/http-5xx.md',
        noData: 'alert'
    },
    {
        name: 'http_p95_latency',
        query: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_ms_bucket[5m])))',
        window: '5m',
        threshold: 1000,
        dataSource: 'prometheus',
        runbook: 'docs/runbooks/http-latency.md',
        noData: 'alert'
    },
    {
        name: 'process_restart',
        query: 'changes(process_start_time_seconds[5m])',
        window: '5m',
        threshold: 0,
        dataSource: 'prometheus',
        runbook: 'docs/runbooks/process-restart.md',
        noData: 'alert'
    },
    {
        name: 'disk_free',
        query: 'node_filesystem_avail_bytes',
        window: '5m',
        threshold: 10737418240,
        dataSource: 'prometheus',
        runbook: 'docs/runbooks/disk-free.md',
        noData: 'alert'
    },
    {
        name: 'csp_receiver_health',
        query: 'csp_receiver_healthy',
        window: '5m',
        threshold: 1,
        dataSource: 'csp_receipt',
        runbook: 'docs/runbooks/csp-receiver.md',
        noData: 'fail_closed'
    },
    {
        name: 'release_staleness',
        query: 'flowise_release_age_seconds',
        window: '5m',
        threshold: 86400,
        dataSource: 'release_receipt',
        runbook: 'docs/runbooks/release-staleness.md',
        noData: 'fail_closed'
    }
])
const requiredAlerts = canonicalAlertConfiguration.map(({ name }) => name)
const canonicalAlertByName = new Map(canonicalAlertConfiguration.map((configuration) => [configuration.name, configuration]))
const alertConfigurationDigest = createHash('sha256').update(JSON.stringify(canonicalAlertConfiguration)).digest('hex')
const normalizeAlertConfiguration = ({ name, query, window, threshold, dataSource, runbook, noData }) => ({
    name,
    query: normalizePromql(query),
    window,
    threshold,
    dataSource,
    runbook,
    noData
})
const observation = (evaluatedAt, observedAt) => ({ observedAt, ageSeconds: secondsBetween(evaluatedAt, observedAt) })

export const evaluateObservability = (input, { now = new Date().toISOString() } = {}) => {
    requireSchema(schemas.observabilityInput, input)

    if (!isStrictUtcTimestamp(now)) throw new ContractError('CLOCK_INVALID')
    const evaluatedAt = Date.parse(input.evaluatedAt)
    if (evaluatedAt > Date.parse(now)) throw new ContractError('CLOCK_INVALID')

    const identities = [input.candidateRevision, input.ociRevision, input.runtime.revision, input.runtime.buildInfoRevision]
    if (new Set(identities).size !== 1) throw new ContractError('IDENTITY_MISMATCH')
    if (input.scrape.mode === 'protected_endpoint' && !input.scrape.authenticated) {
        throw new ContractError('SCRAPE_AUTH_INVALID')
    }

    const alertNames = input.alerts.map(({ name }) => name)
    if (new Set(alertNames).size !== requiredAlerts.length || requiredAlerts.some((name) => !alertNames.includes(name))) {
        throw new ContractError('ALERT_SET_INVALID')
    }

    const alertsByName = new Map(input.alerts.map((alert) => [alert.name, alert]))
    for (const name of requiredAlerts) {
        if (!sameJsonValue(normalizeAlertConfiguration(alertsByName.get(name)), canonicalAlertByName.get(name))) {
            throw new ContractError('ALERT_CONFIG_INVALID')
        }
    }
    if (canonicalAlertConfiguration.some(({ runbook }) => !existsSync(new URL(`../../${runbook}`, import.meta.url)))) {
        throw new ContractError('RUNBOOK_MISSING')
    }

    const evidenceTimes = [
        input.observedAt,
        input.runtime.observedAt,
        input.scrape.observedAt,
        ...requiredAlerts.map((name) => alertsByName.get(name).observedAt)
    ]
    if (evidenceTimes.some((timestamp) => Date.parse(timestamp) > evaluatedAt)) throw new ContractError('CLOCK_INVALID')
    if (evidenceTimes.some((timestamp) => evaluatedAt - Date.parse(timestamp) > input.maxAgeSeconds * 1000)) {
        throw new ContractError('EVIDENCE_STALE')
    }

    return {
        schemaVersion: 1,
        status: 'ready',
        evaluatedAt: input.evaluatedAt,
        maxAgeSeconds: input.maxAgeSeconds,
        observedAt: input.observedAt,
        candidateRevision: input.candidateRevision,
        runtimeRevision: input.runtime.revision,
        scrape: {
            mode: input.scrape.mode,
            authenticated: input.scrape.authenticated,
            publicWhitelist: input.scrape.publicWhitelist
        },
        metrics: {
            requestCounter: input.metrics.requestCounter,
            durationBucket: input.metrics.durationBucket,
            buildInfo: input.metrics.buildInfo
        },
        labels: [...input.privacy.labels],
        observations: {
            snapshot: observation(input.evaluatedAt, input.observedAt),
            runtime: observation(input.evaluatedAt, input.runtime.observedAt),
            scrape: observation(input.evaluatedAt, input.scrape.observedAt),
            alerts: requiredAlerts.map((name) => ({ name, ...observation(input.evaluatedAt, alertsByName.get(name).observedAt) }))
        },
        alertConfiguration: canonicalAlertConfiguration.map((configuration) => ({ ...configuration })),
        alertConfigurationDigest,
        evidenceGrade: input.runtime.evidenceGrade,
        providerCall: false
    }
}
