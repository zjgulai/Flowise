import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ContractError, evaluateObservability, evaluateReleaseStaleness, schemas, validateSchema } from './monitor-contracts.mjs'

const fixture = (relativePath) => JSON.parse(readFileSync(new URL(`./fixtures/${relativePath}`, import.meta.url), 'utf8'))
const clone = (value) => structuredClone(value)

const assertContractError = (action, code) => {
    assert.throws(action, (error) => error instanceof ContractError && error.code === code, `expected contract error ${code}`)
}

test('release staleness positive fixture produces an exact-schema fresh receipt', () => {
    const input = fixture('release-staleness/fresh.json')
    assert.deepEqual(validateSchema(schemas.releaseInput, input), [])

    const receipt = evaluateReleaseStaleness(input)
    assert.deepEqual(validateSchema(schemas.releaseReceipt, receipt), [])
    assert.equal(receipt.status, 'fresh')
    assert.equal(receipt.ageSeconds, 300)
    assert.equal(receipt.backup.ageSeconds, 600)
    assert.deepEqual(receipt.reasons, [])
    assert.equal(receipt.providerCall, false)
})

test('release staleness marks old verified evidence stale instead of fresh', () => {
    const input = fixture('release-staleness/fresh.json')
    input.maxAgeSeconds = 299

    const receipt = evaluateReleaseStaleness(input)
    assert.equal(receipt.status, 'stale')
    assert.deepEqual(receipt.reasons, ['deployment_age_exceeded', 'backup_age_exceeded'])
    assert.deepEqual(validateSchema(schemas.releaseReceipt, receipt), [])
})

test('release staleness marks old runtime and disk observations stale', () => {
    const input = fixture('release-staleness/fresh.json')
    input.runtime.observedAt = '2026-08-10T11:44:59.000Z'
    input.disk.observedAt = '2026-08-10T11:44:59.000Z'

    const receipt = evaluateReleaseStaleness(input)
    assert.equal(receipt.status, 'stale')
    assert.deepEqual(receipt.reasons, ['runtime_age_exceeded', 'disk_age_exceeded'])
    assert.deepEqual(validateSchema(schemas.releaseReceipt, receipt), [])
})

test('release staleness rejects a missing immutable receipt digest at schema boundary', () => {
    const input = fixture('release-staleness/missing-receipt-digest.json')
    assert.notDeepEqual(validateSchema(schemas.releaseInput, input), [])
    assertContractError(() => evaluateReleaseStaleness(input), 'SCHEMA_INVALID')
})

test('release staleness rejects revision identity drift', () => {
    const input = fixture('release-staleness/identity-mismatch.json')
    assert.deepEqual(validateSchema(schemas.releaseInput, input), [])
    assertContractError(() => evaluateReleaseStaleness(input), 'IDENTITY_MISMATCH')
})

test('release staleness rejects rollback receipts that claim candidate-active state', () => {
    const input = fixture('release-staleness/rollback-state-contradiction.json')
    assert.deepEqual(validateSchema(schemas.releaseInput, input), [])
    assertContractError(() => evaluateReleaseStaleness(input), 'STATE_OPERATION_MISMATCH')
})

test('release staleness fails closed on future timestamps and no-data dimensions', () => {
    const future = fixture('release-staleness/fresh.json')
    future.deployment.createdAt = '2026-08-10T12:00:01.000Z'
    assertContractError(() => evaluateReleaseStaleness(future), 'CLOCK_INVALID')

    const noData = fixture('release-staleness/fresh.json')
    noData.backup.checksumStatus = 'no_data'
    assertContractError(() => evaluateReleaseStaleness(noData), 'EVIDENCE_MISSING')
})

test('release and observability schemas reject non-RFC3339 and impossible UTC timestamps', () => {
    for (const invalidTimestamp of ['2026-08-10 12:00:00Z', '2026-02-30T00:00:00.000Z']) {
        const release = fixture('release-staleness/fresh.json')
        release.observedAt = invalidTimestamp
        assert.notDeepEqual(validateSchema(schemas.releaseInput, release), [])
        assertContractError(() => evaluateReleaseStaleness(release), 'SCHEMA_INVALID')

        const observability = fixture('observability/ready.json')
        observability.observedAt = invalidTimestamp
        assert.notDeepEqual(validateSchema(schemas.observabilityInput, observability), [])
        assertContractError(() => evaluateObservability(observability), 'SCHEMA_INVALID')
    }
})

test('release staleness treats a consistent rollback receipt as an explicit terminal state', () => {
    const input = fixture('release-staleness/fresh.json')
    input.deployment.operation = 'rollback'
    input.deployment.state = 'manual_rollback_complete'
    input.deployment.receiptPath = input.deployment.receiptPath.replace('cutover-receipt', 'rollback-receipt')

    const receipt = evaluateReleaseStaleness(input)
    assert.equal(receipt.status, 'rolled_back')
    assert.equal(receipt.phase, 'rolled_back')
    assert.deepEqual(validateSchema(schemas.releaseReceipt, receipt), [])
})

test('observability positive fixture produces a low-cardinality ready receipt', () => {
    const input = fixture('observability/ready.json')
    assert.deepEqual(validateSchema(schemas.observabilityInput, input), [])

    const receipt = evaluateObservability(input)
    assert.deepEqual(validateSchema(schemas.observabilityReceipt, receipt), [])
    assert.equal(receipt.status, 'ready')
    assert.deepEqual(receipt.labels, ['method', 'route', 'status'])
    assert.equal(receipt.alerts.length, 6)
    assert.equal(receipt.providerCall, false)
})

test('observability rejects the nonexistent histogram series', () => {
    const input = fixture('observability/wrong-histogram-series.json')
    assert.notDeepEqual(validateSchema(schemas.observabilityInput, input), [])
    assertContractError(() => evaluateObservability(input), 'SCHEMA_INVALID')
})

test('observability rejects public metrics exposure and unauthenticated protected scrape', () => {
    const input = fixture('observability/public-metrics.json')
    assert.notDeepEqual(validateSchema(schemas.observabilityInput, input), [])
    assertContractError(() => evaluateObservability(input), 'SCHEMA_INVALID')

    const semanticOnly = fixture('observability/ready.json')
    semanticOnly.scrape.authenticated = false
    assertContractError(() => evaluateObservability(semanticOnly), 'SCRAPE_AUTH_INVALID')
})

test('observability rejects healthy no-data semantics and high-cardinality labels', () => {
    for (const relativePath of ['observability/no-data-healthy.json', 'observability/high-cardinality-label.json']) {
        const input = fixture(relativePath)
        assert.notDeepEqual(validateSchema(schemas.observabilityInput, input), [])
        assertContractError(() => evaluateObservability(input), 'SCHEMA_INVALID')
    }
})

test('observability rejects revision drift and an incomplete SLO alert set', () => {
    const identityDrift = fixture('observability/ready.json')
    identityDrift.runtime.buildInfoRevision = '2222222222222222222222222222222222222222'
    assertContractError(() => evaluateObservability(identityDrift), 'IDENTITY_MISMATCH')

    const incomplete = fixture('observability/ready.json')
    incomplete.alerts = incomplete.alerts.slice(0, -1)
    assertContractError(() => evaluateObservability(incomplete), 'SCHEMA_INVALID')
})

test('observability rejects a contradictory duplicate alert definition', () => {
    const input = fixture('observability/ready.json')
    input.alerts.push({ ...input.alerts[0], query: 'rate(unrelated_counter[5m])', threshold: 999 })

    assert.notDeepEqual(validateSchema(schemas.observabilityInput, input), [])
    assertContractError(() => evaluateObservability(input), 'SCHEMA_INVALID')
})

test('observability rejects PromQL that bypasses rate-based histogram aggregation', () => {
    const input = fixture('observability/ready.json')
    input.alerts.find(({ name }) => name === 'http_p95_latency').query = 'histogram_quantile(0.95, http_request_duration_ms_bucket)'
    assert.deepEqual(validateSchema(schemas.observabilityInput, input), [])
    assertContractError(() => evaluateObservability(input), 'PROMQL_INVALID')

    for (const [name, query] of [
        ['http_p95_latency', 'rate(unrelated_counter[5m]) + 0 * http_request_duration_ms_bucket'],
        ['http_5xx_ratio', 'rate(unrelated_counter[5m]) + 0 * http_requests_total']
    ]) {
        const tokenBypass = fixture('observability/ready.json')
        tokenBypass.alerts.find((alert) => alert.name === name).query = query
        assert.deepEqual(validateSchema(schemas.observabilityInput, tokenBypass), [])
        assertContractError(() => evaluateObservability(tokenBypass), 'PROMQL_INVALID')
    }
})

test('both input schemas reject unknown keys instead of silently widening evidence', () => {
    const release = clone(fixture('release-staleness/fresh.json'))
    release.unreviewed = true
    assertContractError(() => evaluateReleaseStaleness(release), 'SCHEMA_INVALID')

    const observability = clone(fixture('observability/ready.json'))
    observability.credentials = 'must-never-enter-a-contract'
    assertContractError(() => evaluateObservability(observability), 'SCHEMA_INVALID')
})
