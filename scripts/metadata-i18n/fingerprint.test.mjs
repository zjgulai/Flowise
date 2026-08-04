import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { assertCurrentComponentBuild, componentSourceFingerprint, metadataBuildReceiptPath } from './fingerprint.mjs'

const createFixture = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flowise-metadata-fingerprint-'))
    mkdirSync(path.join(root, 'packages/components/nodes'), { recursive: true })
    mkdirSync(path.join(root, 'packages/components/dist'), { recursive: true })
    for (const relativePath of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        writeFileSync(path.join(root, relativePath), `${relativePath}\n`)
    }
    writeFileSync(path.join(root, 'packages/components/nodes/example.ts'), 'export const label = "Example"\n')
    writeFileSync(path.join(root, 'packages/components/README.md'), 'ignored documentation\n')
    return root
}

const writeReceipt = (root) => {
    const fingerprint = componentSourceFingerprint(root)
    writeFileSync(metadataBuildReceiptPath(root), `${JSON.stringify({ schemaVersion: 1, ...fingerprint })}\n`)
    return fingerprint
}

describe('compiled component metadata fingerprint', () => {
    it('accepts an exact receipt and ignores dist plus non-build documentation', () => {
        const root = createFixture()
        try {
            const expected = writeReceipt(root)
            writeFileSync(path.join(root, 'packages/components/dist/generated.js'), 'compiled output\n')
            writeFileSync(path.join(root, 'packages/components/README.md'), 'changed ignored documentation\n')

            assert.deepEqual(assertCurrentComponentBuild(root), expected)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('fails closed for a missing, invalid, or stale receipt', () => {
        const root = createFixture()
        try {
            assert.throws(() => assertCurrentComponentBuild(root), /receipt is missing/)
            writeFileSync(metadataBuildReceiptPath(root), 'not json\n')
            assert.throws(() => assertCurrentComponentBuild(root), /receipt is invalid/)

            writeReceipt(root)
            writeFileSync(path.join(root, 'packages/components/nodes/example.ts'), 'export const label = "Changed"\n')
            assert.throws(() => assertCurrentComponentBuild(root), /metadata is stale/)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
