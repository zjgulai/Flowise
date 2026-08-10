import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ContractError, validateSchema } from './monitor-contracts.mjs'
import { cspSchemas, evaluateCspObservation } from './csp-observation.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/csp-observation/${name}`, import.meta.url), 'utf8'))

const applyOperations = (input, operations) => {
    const result = structuredClone(input)
    for (const { op, path, value } of operations) {
        const segments = path
            .slice(1)
            .split('/')
            .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        const key = segments.pop()
        const parent = segments.reduce((current, segment) => current[segment], result)
        if (op === 'remove') {
            if (Array.isArray(parent)) parent.splice(Number(key), 1)
            else delete parent[key]
        } else {
            parent[key] = structuredClone(value)
        }
    }
    return result
}

const assertContractError = (action, code) => {
    assert.throws(action, (error) => error instanceof ContractError && error.code === code, `expected contract error ${code}`)
}

test('a non-empty healthy and fully covered zero-violation window produces an L2 clean receipt', () => {
    const input = fixture('clean.json')
    assert.deepEqual(validateSchema(cspSchemas.input, input), [])

    const receipt = evaluateCspObservation(input)
    assert.deepEqual(validateSchema(cspSchemas.receipt, receipt), [])
    assert.equal(receipt.status, 'clean')
    assert.equal(receipt.violationCount, 0)
    assert.equal(receipt.window.durationSeconds, 3600)
    assert.deepEqual(receipt.coverage, {
        profile: 'wave1b_minimum_v1',
        requiredCount: 10,
        executedCount: 10,
        gaps: []
    })
    assert.equal(receipt.evidenceGrade, 'L2')
    assert.equal(receipt.promotionDecision, 'not_authorized')
    assert.equal(receipt.enforcementChanged, false)
    assert.equal(receipt.providerCall, false)
})

test('a valid window with violations preserves only fixed low-cardinality summary buckets', () => {
    const input = fixture('violations.json')
    assert.deepEqual(validateSchema(cspSchemas.input, input), [])

    const receipt = evaluateCspObservation(input)
    assert.deepEqual(validateSchema(cspSchemas.receipt, receipt), [])
    assert.equal(receipt.status, 'violations_observed')
    assert.equal(receipt.violationCount, 3)
    assert.deepEqual(receipt.summaries, [
        { directive: 'script-src', disposition: 'report', count: 2 },
        { directive: 'other', disposition: 'unknown', count: 1 }
    ])
    const receiptText = JSON.stringify(receipt)
    assert.doesNotMatch(receiptText, /https?:\/\/|token=|script-sample/i)
    assert.doesNotMatch(receiptText, /"(documentUrl|rawPath|query|header|body|sample)":/i)
    assert.equal(receipt.promotionDecision, 'not_authorized')
})

for (const scenario of fixture('negative-cases.json')) {
    test(`CSP observation fails closed: ${scenario.name}`, () => {
        const input = applyOperations(fixture(scenario.base), scenario.operations)
        assert.equal(validateSchema(cspSchemas.input, input).length === 0, scenario.schemaValid)
        assertContractError(() => evaluateCspObservation(input), scenario.expectedCode)
    })
}

test('input and receipt schemas are strict Draft 2020-12 contracts', () => {
    for (const schema of Object.values(cspSchemas)) {
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
        assert.equal(schema.additionalProperties, false)
    }
})
