import { readFileSync } from 'node:fs'

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
    const identities = deployment.operation === 'rollback' ? candidateIdentities : [...candidateIdentities, ...deployedIdentities]
    if (new Set(identities).size !== 1 || new Set(deployedIdentities).size !== 1) {
        throw new ContractError('IDENTITY_MISMATCH')
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

    const rolledBack = deployment.operation === 'rollback'
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

const requiredAlerts = ['http_5xx_ratio', 'http_p95_latency', 'process_restart', 'disk_free', 'csp_receiver_health', 'release_staleness']
const canonicalPromql = Object.freeze({
    http_5xx_ratio: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
    http_p95_latency: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_ms_bucket[5m])))'
})
const normalizePromql = (query) => query.replace(/\s+/g, ' ').trim()

export const evaluateObservability = (input) => {
    requireSchema(schemas.observabilityInput, input)

    const identities = [input.candidateRevision, input.ociRevision, input.runtime.revision, input.runtime.buildInfoRevision]
    if (new Set(identities).size !== 1) throw new ContractError('IDENTITY_MISMATCH')
    if (input.scrape.mode === 'protected_endpoint' && !input.scrape.authenticated) {
        throw new ContractError('SCRAPE_AUTH_INVALID')
    }

    const alertNames = input.alerts.map(({ name }) => name)
    if (new Set(alertNames).size !== requiredAlerts.length || requiredAlerts.some((name) => !alertNames.includes(name))) {
        throw new ContractError('ALERT_SET_INVALID')
    }
    const p95 = input.alerts.find(({ name }) => name === 'http_p95_latency')
    const errorRatio = input.alerts.find(({ name }) => name === 'http_5xx_ratio')
    if (
        normalizePromql(p95.query) !== canonicalPromql.http_p95_latency ||
        normalizePromql(errorRatio.query) !== canonicalPromql.http_5xx_ratio ||
        p95.window !== '5m' ||
        errorRatio.window !== '5m' ||
        p95.dataSource !== 'prometheus' ||
        errorRatio.dataSource !== 'prometheus'
    ) {
        throw new ContractError('PROMQL_INVALID')
    }

    return {
        schemaVersion: 1,
        status: 'ready',
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
        alerts: [...requiredAlerts],
        evidenceGrade: input.runtime.evidenceGrade,
        providerCall: false
    }
}
