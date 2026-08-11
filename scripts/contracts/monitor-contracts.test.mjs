import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
    input.deployment.revision = '2222222222222222222222222222222222222222'
    input.runtime.revision = input.deployment.revision

    const receipt = evaluateReleaseStaleness(input)
    assert.equal(receipt.status, 'rolled_back')
    assert.equal(receipt.phase, 'rolled_back')
    assert.deepEqual(validateSchema(schemas.releaseReceipt, receipt), [])
})

test('release staleness rejects rollback receipts while the candidate is still deployed', () => {
    const input = fixture('release-staleness/fresh.json')
    input.deployment.operation = 'rollback'
    input.deployment.state = 'manual_rollback_complete'
    input.deployment.receiptPath = input.deployment.receiptPath.replace('cutover-receipt', 'rollback-receipt')

    assertContractError(() => evaluateReleaseStaleness(input), 'ROLLBACK_NOT_EFFECTIVE')
})

test('release staleness directly covers fail-closed path, activation, runtime, and backup errors', () => {
    const pathMismatch = fixture('release-staleness/fresh.json')
    pathMismatch.deployment.receiptPath = '/opt/flowise/deployments/other-run/cutover-receipt.json'
    assertContractError(() => evaluateReleaseStaleness(pathMismatch), 'RECEIPT_PATH_MISMATCH')

    const prepare = fixture('release-staleness/fresh.json')
    prepare.deployment.operation = 'prepare'
    prepare.deployment.state = 'prepared'
    prepare.deployment.receiptPath = prepare.deployment.receiptPath.replace('cutover-receipt', 'prepare-receipt')
    assertContractError(() => evaluateReleaseStaleness(prepare), 'CANDIDATE_NOT_ACTIVE')

    const unhealthy = fixture('release-staleness/fresh.json')
    unhealthy.runtime.health = 'unhealthy'
    assertContractError(() => evaluateReleaseStaleness(unhealthy), 'RUNTIME_UNHEALTHY')

    const invalidBackup = fixture('release-staleness/fresh.json')
    invalidBackup.backup.checksumStatus = 'mismatch'
    assertContractError(() => evaluateReleaseStaleness(invalidBackup), 'BACKUP_CHECKSUM_INVALID')
})

test('observability positive fixture produces a low-cardinality ready receipt', () => {
    const input = fixture('observability/ready.json')
    assert.deepEqual(validateSchema(schemas.observabilityInput, input), [])

    const receipt = evaluateObservability(input, { now: '2026-08-10T12:05:00.000Z' })
    assert.deepEqual(validateSchema(schemas.observabilityReceipt, receipt), [])
    assert.equal(receipt.status, 'ready')
    assert.deepEqual(receipt.labels, ['method', 'route', 'status'])
    assert.equal(receipt.evaluatedAt, input.evaluatedAt)
    assert.equal(receipt.maxAgeSeconds, input.maxAgeSeconds)
    assert.equal(receipt.observations.runtime.ageSeconds, 60)
    assert.equal(receipt.observations.scrape.ageSeconds, 30)
    assert.equal(receipt.observations.alerts.length, 6)
    assert.equal(receipt.alertConfiguration.length, 6)
    assert.match(receipt.alertConfigurationDigest, /^[0-9a-f]{64}$/)
    assert.equal(receipt.alertConfigurationDigest, createHash('sha256').update(JSON.stringify(receipt.alertConfiguration)).digest('hex'))
    assert.equal(receipt.providerCall, false)
})

test('observability rejects an otherwise self-consistent historical evidence replay against the trusted clock', () => {
    const replay = fixture('observability/ready.json')
    replay.evaluatedAt = '2020-01-01T00:05:00.000Z'
    replay.observedAt = '2020-01-01T00:05:00.000Z'
    replay.runtime.observedAt = '2020-01-01T00:04:00.000Z'
    replay.scrape.observedAt = '2020-01-01T00:04:30.000Z'
    replay.alerts.forEach((alert) => (alert.observedAt = '2020-01-01T00:04:45.000Z'))

    assert.deepEqual(validateSchema(schemas.observabilityInput, replay), [])
    assertContractError(() => evaluateObservability(replay, { now: '2026-08-11T00:00:00.000Z' }), 'EVIDENCE_STALE')
})

test('observability receipt schema binds the declared age ceiling and every canonical alert identity', () => {
    const input = fixture('observability/ready.json')
    const receipt = evaluateObservability(input, { now: '2026-08-10T12:05:00.000Z' })

    for (const mutate of [
        (candidate) => (candidate.observations.runtime.ageSeconds = 301),
        (candidate) => (candidate.observations.alerts[0].ageSeconds = 301)
    ]) {
        const stale = clone(receipt)
        mutate(stale)
        assert.notDeepEqual(validateSchema(schemas.observabilityReceipt, stale), [])
    }

    const repeatedObservation = clone(receipt)
    repeatedObservation.observations.alerts.forEach((alert) => (alert.name = 'http_5xx_ratio'))
    assert.notDeepEqual(validateSchema(schemas.observabilityReceipt, repeatedObservation), [])

    const repeatedConfiguration = clone(receipt)
    repeatedConfiguration.alertConfiguration.forEach((alert) => (alert.name = 'http_5xx_ratio'))
    assert.notDeepEqual(validateSchema(schemas.observabilityReceipt, repeatedConfiguration), [])
})

test('observability rejects future and stale evidence relative to an explicit evaluation anchor', () => {
    const futureSnapshot = fixture('observability/ready.json')
    futureSnapshot.observedAt = '2999-01-01T00:00:00.000Z'
    assertContractError(() => evaluateObservability(futureSnapshot), 'CLOCK_INVALID')

    const futureAnchor = fixture('observability/ready.json')
    futureAnchor.evaluatedAt = '2999-01-01T00:00:00.000Z'
    futureAnchor.observedAt = futureAnchor.evaluatedAt
    futureAnchor.runtime.observedAt = futureAnchor.evaluatedAt
    futureAnchor.scrape.observedAt = futureAnchor.evaluatedAt
    futureAnchor.alerts.forEach((alert) => (alert.observedAt = futureAnchor.evaluatedAt))
    assertContractError(() => evaluateObservability(futureAnchor), 'CLOCK_INVALID')

    for (const mutate of [
        (input) => (input.runtime.observedAt = '2026-08-10T12:00:01.000Z'),
        (input) => (input.scrape.observedAt = '2026-08-10T12:00:01.000Z'),
        (input) => (input.alerts[0].observedAt = '2026-08-10T12:00:01.000Z')
    ]) {
        const future = fixture('observability/ready.json')
        mutate(future)
        assertContractError(() => evaluateObservability(future), 'CLOCK_INVALID')
    }

    for (const mutate of [
        (input) => (input.observedAt = '2026-08-10T11:54:59.000Z'),
        (input) => (input.runtime.observedAt = '2026-08-10T11:54:59.000Z'),
        (input) => (input.scrape.observedAt = '2026-08-10T11:54:59.000Z'),
        (input) => (input.alerts[0].observedAt = '2026-08-10T11:54:59.000Z')
    ]) {
        const stale = fixture('observability/ready.json')
        mutate(stale)
        assertContractError(() => evaluateObservability(stale), 'EVIDENCE_STALE')
    }

    const subsecondStale = fixture('observability/ready.json')
    subsecondStale.scrape.observedAt = '2026-08-10T11:54:59.999Z'
    assertContractError(() => evaluateObservability(subsecondStale), 'EVIDENCE_STALE')

    const widenedWindow = fixture('observability/ready.json')
    widenedWindow.maxAgeSeconds = 301
    assertContractError(() => evaluateObservability(widenedWindow), 'SCHEMA_INVALID')
})

test('observability binds every field of every alert to the canonical managed configuration', () => {
    const alternateDataSource = {
        prometheus: 'release_receipt',
        release_receipt: 'csp_receipt',
        csp_receipt: 'prometheus'
    }
    const alternateNoData = { alert: 'fail_closed', fail_closed: 'alert' }
    const mutations = {
        query: (alert) => `${alert.query} + unrelated_metric`,
        window: () => '10m',
        threshold: (alert) => alert.threshold + 1,
        dataSource: (alert) => alternateDataSource[alert.dataSource],
        runbook: () => 'docs/runbooks/nonexistent.md',
        noData: (alert) => alternateNoData[alert.noData]
    }

    for (const name of fixture('observability/ready.json').alerts.map((alert) => alert.name)) {
        for (const [field, mutate] of Object.entries(mutations)) {
            const input = fixture('observability/ready.json')
            const alert = input.alerts.find((candidate) => candidate.name === name)
            alert[field] = mutate(alert)
            assert.deepEqual(validateSchema(schemas.observabilityInput, input), [], `${name}.${field} must reach semantic validation`)
            assertContractError(() => evaluateObservability(input), 'ALERT_CONFIG_INVALID')
        }
    }
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

    const wrongSet = fixture('observability/ready.json')
    wrongSet.alerts.at(-1).name = wrongSet.alerts[0].name
    assert.deepEqual(validateSchema(schemas.observabilityInput, wrongSet), [])
    assertContractError(() => evaluateObservability(wrongSet), 'ALERT_SET_INVALID')
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
    assertContractError(() => evaluateObservability(input), 'ALERT_CONFIG_INVALID')

    for (const [name, query] of [
        ['http_p95_latency', 'rate(unrelated_counter[5m]) + 0 * http_request_duration_ms_bucket'],
        ['http_5xx_ratio', 'rate(unrelated_counter[5m]) + 0 * http_requests_total']
    ]) {
        const tokenBypass = fixture('observability/ready.json')
        tokenBypass.alerts.find((alert) => alert.name === name).query = query
        assert.deepEqual(validateSchema(schemas.observabilityInput, tokenBypass), [])
        assertContractError(() => evaluateObservability(tokenBypass), 'ALERT_CONFIG_INVALID')
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
