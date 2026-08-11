import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    ContractError,
    assertExactCheckReceipt,
    buildBaseline,
    evaluateBaseline,
    runCli,
    scanUiTree,
    schemas,
    scanSourceText,
    updateBaseline,
    validateBaseline,
    validateReceipt
} from './ui-copy-baseline.mjs'

const mutationFixture = JSON.parse(readFileSync(new URL('./fixtures/ui-copy/mutation-cases.json', import.meta.url), 'utf8'))
const modulePath = fileURLToPath(new URL('./ui-copy-baseline.mjs', import.meta.url))
const clone = (value) => structuredClone(value)
const reason = { code: 'legacy-existing', reference: 'WAVE-1D-20260810' }

const scan = (source, relativePath = 'views/example/index.jsx') => scanSourceText(source, relativePath)

const assertContractError = (action, code) => {
    assert.throws(action, (error) => error instanceof ContractError && error.code === code, `expected ${code}`)
}

test('mutation fixture is non-vacuous across display sinks, split strings, and machine fields', () => {
    assert.equal(mutationFixture.schemaVersion, 1)
    assert.ok(mutationFixture.cases.length >= 10)

    for (const fixtureCase of mutationFixture.cases) {
        const result = scan(fixtureCase.source)
        if (fixtureCase.expectedDebtKind) {
            assert.ok(
                result.debts.some(({ kind }) => kind === fixtureCase.expectedDebtKind),
                fixtureCase.id
            )
        }
        if (fixtureCase.expectedMachineSink) {
            assert.ok(
                result.machineViolations.some(({ sink }) => sink === fixtureCase.expectedMachineSink),
                fixtureCase.id
            )
        }
        if (fixtureCase.expectedDebtCount !== undefined) {
            assert.equal(result.debts.length, fixtureCase.expectedDebtCount, fixtureCase.id)
        }
    }
})

test('semantic record identity is independent of source line movement', () => {
    const compact = scan("const View = () => <Button aria-label='Save changes'>Delete item</Button>")
    const shifted = scan("\n\nconst View = () => (\n<Button aria-label='Save changes'>Delete item</Button>\n)")

    assert.deepEqual(compact.debts, shifted.debts)
})

test('TypeScript angle-bracket assertions are parsed using the source file extension', () => {
    const result = scan('const typedValue = <DisplayValue>inputValue', 'utils/display-value.ts')

    assert.deepEqual(result.debts, [])
    assert.deepEqual(result.machineViolations, [])
})

test('source traversal and parser fail closed on symlinks and malformed modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'flowise-ui-copy-'))
    const sourceRoot = path.join(root, 'packages/ui/src')
    try {
        mkdirSync(sourceRoot, { recursive: true })
        const sourcePath = path.join(sourceRoot, 'index.jsx')
        writeFileSync(sourcePath, '<Button>Save changes</Button>\n')
        symlinkSync(sourcePath, path.join(sourceRoot, 'alias.jsx'))
        assertContractError(() => scanUiTree(root), 'SOURCE_SYMLINK_FORBIDDEN')
    } finally {
        rmSync(root, { recursive: true, force: true })
    }

    assertContractError(() => scan('const broken = <Button>'), 'SOURCE_PARSE_FAILED')
})

test('CLI rejects mode-inapplicable, incomplete, and duplicate options before filesystem access', () => {
    for (const args of [
        ['check', '--reason', 'legacy-existing', '--reference', 'WAVE-1D-20260810'],
        ['init', '--reason', 'legacy-existing'],
        ['update', '--reference', 'FLOWISE-1234'],
        ['check', '--root', '/missing-one', '--root', '/missing-two']
    ]) {
        assertContractError(() => runCli(args), 'CLI_USAGE_INVALID')
    }

    const subprocess = spawnSync(
        process.execPath,
        [modulePath, 'check', '--reason', 'legacy-existing', '--reference', 'WAVE-1D-20260810'],
        { encoding: 'utf8' }
    )
    assert.equal(subprocess.status, 1)
    assert.equal(subprocess.stdout, '')
    assert.match(subprocess.stderr, /status=failed reason=CLI_USAGE_INVALID/)
})

test('baseline and receipt schemas are strict Draft 2020-12 contracts', () => {
    for (const schema of Object.values(schemas)) {
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
        assert.equal(schema.additionalProperties, false)
    }

    const result = scan('<Button>Save changes</Button>')
    const baseline = buildBaseline({ files: [result], reason })
    assert.deepEqual(validateBaseline(baseline), [])
    assert.deepEqual(validateReceipt(evaluateBaseline({ files: [result], baseline })), [])
})

test('missing, empty, malformed, and digest-drifted baselines fail closed', () => {
    const result = scan('<Button>Save changes</Button>')
    const baseline = buildBaseline({ files: [result], reason })

    assertContractError(() => evaluateBaseline({ files: [result] }), 'BASELINE_MISSING')
    assertContractError(() => evaluateBaseline({ files: [], baseline }), 'SOURCE_EMPTY')

    const malformed = clone(baseline)
    malformed.unreviewed = true
    assertContractError(() => evaluateBaseline({ files: [result], baseline: malformed }), 'SCHEMA_INVALID')

    const drifted = clone(baseline)
    drifted.records[0].occurrences += 1
    assertContractError(() => evaluateBaseline({ files: [result], baseline: drifted }), 'BASELINE_DIGEST_MISMATCH')
})

test('new debt and equal-count replacement fail instead of passing under a ceiling', () => {
    const original = scan('<Button>Save changes</Button>')
    const baseline = buildBaseline({ files: [original], reason })
    const addition = scan('<><Button>Save changes</Button><Button>Delete item</Button></>')
    const replacement = scan('<Button>Delete item</Button>')

    assertContractError(() => evaluateBaseline({ files: [addition], baseline }), 'UI_COPY_DEBT_ADDED')
    assertContractError(() => evaluateBaseline({ files: [replacement], baseline }), 'UI_COPY_DEBT_ADDED')
})

test('resolved debt passes only as an explicit ratchet tightening receipt', () => {
    const original = scan('<><Button>Save changes</Button><Button>Delete item</Button></>')
    const current = scan('<Button>保存更改</Button>')
    const baseline = buildBaseline({ files: [original], reason })

    const receipt = evaluateBaseline({ files: [current], baseline })
    assert.equal(receipt.status, 'ratchet_tightened')
    assert.equal(receipt.baselineDebtCount, 2)
    assert.equal(receipt.currentDebtCount, 0)
    assert.equal(receipt.resolvedDebtCount, 2)
    assert.equal(receipt.providerCall, false)
    assert.equal(receipt.productionChanged, false)
    assertContractError(() => assertExactCheckReceipt(receipt), 'BASELINE_TIGHTENING_REQUIRED')

    const tightened = updateBaseline({
        files: [current],
        baseline,
        reason: { code: 'debt-reduction', reference: 'FLOWISE-1234' }
    })
    const exactReceipt = evaluateBaseline({ files: [current], baseline: tightened })
    assert.equal(assertExactCheckReceipt(exactReceipt).status, 'exact')
})

test('translated machine-sensitive fields fail before debt comparison', () => {
    const clean = scan('<Button>Save changes</Button>')
    const baseline = buildBaseline({ files: [clean], reason })
    const unsafe = scan("<RequireAuth permissionId='凭据:创建'><Button>Save changes</Button></RequireAuth>")

    assertContractError(() => evaluateBaseline({ files: [unsafe], baseline }), 'MACHINE_FIELD_TRANSLATED')
})

test('unknown record classifications and duplicate identities fail schema validation', () => {
    const result = scan('<Button>Save changes</Button>')
    const baseline = buildBaseline({ files: [result], reason })

    const unknown = clone(baseline)
    unknown.records[0].kind = 'unknown-copy'
    assert.notDeepEqual(validateBaseline(unknown), [])

    const duplicate = clone(baseline)
    duplicate.records.push(clone(duplicate.records[0]))
    assert.notDeepEqual(validateBaseline(duplicate), [])
})

test('baseline updates require a bounded reason and preserve unchanged review history', () => {
    const original = scan('<><Button>Save changes</Button><Button>Keep existing</Button></>')
    const current = scan(
        '<><Button>Save changes</Button><Button>Save changes</Button><Button>Keep existing</Button><Button>Delete item</Button></>'
    )
    const baseline = buildBaseline({ files: [original], reason })

    assertContractError(() => updateBaseline({ files: [current], baseline }), 'UPDATE_REASON_REQUIRED')
    assertContractError(
        () => updateBaseline({ files: [current], baseline, reason: { code: 'legacy-existing', reference: 'NEW-DEBT' } }),
        'UPDATE_REASON_INVALID'
    )
    assertContractError(
        () => updateBaseline({ files: [current], baseline, reason: { code: 'debt-reduction', reference: 'FLOWISE-1234' } }),
        'UPDATE_REASON_INVALID'
    )

    const updated = updateBaseline({
        files: [current],
        baseline,
        reason: { code: 'temporary-migration', reference: 'FLOWISE-1234' }
    })
    const saveDigest = scan('<Button>Save changes</Button>').debts[0].literalDigest
    const keepDigest = scan('<Button>Keep existing</Button>').debts[0].literalDigest
    const deleteDigest = scan('<Button>Delete item</Button>').debts[0].literalDigest
    const increasedRecord = updated.records.find(({ literalDigest }) => literalDigest === saveDigest)
    const unchangedRecord = updated.records.find(({ literalDigest }) => literalDigest === keepDigest)
    const addedRecord = updated.records.find(({ literalDigest }) => literalDigest === deleteDigest)
    assert.equal(increasedRecord.occurrences, 2)
    assert.deepEqual(increasedRecord.reason, { code: 'temporary-migration', reference: 'FLOWISE-1234' })
    assert.deepEqual(unchangedRecord.reason, reason)
    assert.deepEqual(addedRecord.reason, { code: 'temporary-migration', reference: 'FLOWISE-1234' })
    assert.deepEqual(validateBaseline(updated), [])
})
