import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ContractError, validateSchema } from './monitor-contracts.mjs'

const loadSchema = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))

export const cspSchemas = Object.freeze({
    input: loadSchema('csp-observation.input.schema.json'),
    receipt: loadSchema('csp-observation.receipt.schema.json')
})

const modeRank = Object.freeze({
    compat: 0,
    'no-eval': 1,
    'strict-script': 2,
    strict: 3
})

const requiredCoverage = Object.freeze({
    publicExecuted: ['signin', 'register', 'forgot_password', 'ping'],
    authenticatedExecuted: ['chatflow_editor', 'agentflow_editor', 'credentials'],
    lazyExecuted: ['marketplace', 'document_store', 'code_viewer']
})

const directiveOrder = [
    'default-src',
    'script-src',
    'style-src',
    'connect-src',
    'img-src',
    'font-src',
    'frame-src',
    'frame-ancestors',
    'other'
]
const dispositionOrder = ['report', 'enforce', 'unknown']
const evidenceRoot = '/var/lib/flowise/evidence/csp/'

const requireSchema = (input) => {
    const issues = validateSchema(cspSchemas.input, input)
    if (issues.length > 0) throw new ContractError('SCHEMA_INVALID', issues)
}

const secondsBetween = (later, earlier) => Math.floor((Date.parse(later) - Date.parse(earlier)) / 1000)

export const evaluateCspObservation = (input) => {
    requireSchema(input)

    const normalizedSourcePath = path.posix.normalize(input.source.path)
    if (normalizedSourcePath !== input.source.path || !normalizedSourcePath.startsWith(evidenceRoot)) {
        throw new ContractError('SOURCE_PATH_INVALID')
    }
    if (input.candidateRevision !== input.ociRevision) throw new ContractError('IDENTITY_MISMATCH')
    if (modeRank[input.modes.reportOnly] <= modeRank[input.modes.enforcement]) {
        throw new ContractError('MODE_NOT_STRICTER')
    }

    const startedAt = Date.parse(input.window.startedAt)
    const endedAt = Date.parse(input.window.endedAt)
    const exportedAt = Date.parse(input.source.exportedAt)
    const evaluatedAt = Date.parse(input.evaluatedAt)
    const durationSeconds = secondsBetween(input.window.endedAt, input.window.startedAt)
    if (!(startedAt < endedAt && durationSeconds >= 1 && endedAt <= exportedAt && exportedAt <= evaluatedAt)) {
        throw new ContractError('CLOCK_INVALID')
    }
    if (input.receiver.windowStartedAt !== input.window.startedAt || input.receiver.windowEndedAt !== input.window.endedAt) {
        throw new ContractError('WINDOW_MISMATCH')
    }
    if (!input.receiver.reachable) throw new ContractError('RECEIVER_UNHEALTHY')

    const coverageGaps = Object.entries(requiredCoverage).flatMap(([group, required]) =>
        required.filter((item) => !input.coverage[group].includes(item)).map((item) => `${group}:${item}`)
    )
    if (coverageGaps.length > 0) throw new ContractError('COVERAGE_INCOMPLETE', coverageGaps)

    const violationCount = input.summaries.reduce((total, summary) => total + summary.count, 0)
    if (violationCount !== input.receiver.acceptedReports) throw new ContractError('REPORT_COUNT_MISMATCH')

    const expectedEventCount =
        input.receiver.healthSamples +
        input.receiver.acceptedReports +
        input.receiver.invalidRequests +
        input.receiver.oversizedRequests +
        input.receiver.rateLimitedRequests +
        input.receiver.unknownShapeRequests
    if (input.source.eventCount !== expectedEventCount) throw new ContractError('EVENT_COUNT_MISMATCH')

    const summaryKeys = input.summaries.map(({ directive, disposition }) => `${directive}:${disposition}`)
    if (new Set(summaryKeys).size !== summaryKeys.length) throw new ContractError('SUMMARY_DUPLICATE')

    const receiverAnomalyCount =
        input.receiver.invalidRequests +
        input.receiver.oversizedRequests +
        input.receiver.rateLimitedRequests +
        input.receiver.unknownShapeRequests
    if (violationCount === 0 && receiverAnomalyCount > 0) {
        throw new ContractError('RECEIVER_EVIDENCE_INCOMPLETE')
    }

    const summaries = input.summaries
        .map(({ directive, disposition, count }) => ({ directive, disposition, count }))
        .sort(
            (left, right) =>
                directiveOrder.indexOf(left.directive) - directiveOrder.indexOf(right.directive) ||
                dispositionOrder.indexOf(left.disposition) - dispositionOrder.indexOf(right.disposition)
        )

    return {
        schemaVersion: 1,
        status: violationCount === 0 ? 'clean' : 'violations_observed',
        evaluatedAt: input.evaluatedAt,
        evidenceGrade: 'L2',
        candidateRevision: input.candidateRevision,
        window: {
            startedAt: input.window.startedAt,
            endedAt: input.window.endedAt,
            durationSeconds
        },
        modes: {
            enforcement: input.modes.enforcement,
            reportOnly: input.modes.reportOnly
        },
        source: {
            digest: input.source.digest,
            eventCount: input.source.eventCount
        },
        receiver: {
            reachable: true,
            healthSamples: input.receiver.healthSamples,
            acceptedReports: input.receiver.acceptedReports,
            invalidRequests: input.receiver.invalidRequests,
            oversizedRequests: input.receiver.oversizedRequests,
            rateLimitedRequests: input.receiver.rateLimitedRequests,
            unknownShapeRequests: input.receiver.unknownShapeRequests
        },
        coverage: {
            profile: input.coverage.profile,
            requiredCount: Object.values(requiredCoverage).flat().length,
            executedCount:
                input.coverage.publicExecuted.length + input.coverage.authenticatedExecuted.length + input.coverage.lazyExecuted.length,
            gaps: []
        },
        violationCount,
        summaries,
        promotionDecision: 'not_authorized',
        providerCall: false,
        enforcementChanged: false
    }
}
