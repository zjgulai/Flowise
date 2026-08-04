#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { componentSourceFingerprint, metadataBuildReceiptPath } from './fingerprint.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const receiptPath = metadataBuildReceiptPath(root)
const fingerprint = componentSourceFingerprint(root)

mkdirSync(path.dirname(receiptPath), { recursive: true })
writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, ...fingerprint }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ status: 'pass', ...fingerprint })}\n`)
