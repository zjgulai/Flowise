#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

const HUMAN_TEXT_FIELDS = new Set(['label', 'description', 'warning', 'placeholder', 'deprecateMessage', 'headerName', 'hint'])

const IDENTITY_FIELDS = {
    inputs: ['name'],
    output: ['name'],
    outputs: ['name'],
    options: ['name'],
    tabs: ['name'],
    array: ['name'],
    datagrid: ['field', 'name', 'headerName']
}

const parseArguments = (argv) => {
    const result = { root: process.cwd(), scope: 'all', output: undefined }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--root') result.root = path.resolve(argv[++index])
        else if (argument === '--scope') result.scope = argv[++index]
        else if (argument === '--output') result.output = path.resolve(argv[++index])
        else throw new Error(`Unknown argument: ${argument}`)
    }
    if (!['all', 'agentflow-v2', 'credentials'].includes(result.scope)) {
        throw new Error(`Unsupported scope: ${result.scope}`)
    }
    return result
}

const walkFiles = (directory) => {
    if (!existsSync(directory)) throw new Error(`Built metadata directory not found: ${directory}`)
    const files = []
    for (const entry of readdirSync(directory)) {
        const absolutePath = path.join(directory, entry)
        if (statSync(absolutePath).isDirectory()) files.push(...walkFiles(absolutePath))
        else if (absolutePath.endsWith('.js')) files.push(absolutePath)
    }
    return files.sort()
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)

const escapeSegment = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1')

const itemIdentity = (container, item, index) => {
    for (const field of IDENTITY_FIELDS[container] ?? []) {
        const value = item?.[field]
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return escapeSegment(value)
        }
    }
    return `__missing_identity_${index}`
}

const translationKey = ({ kind, id, path: metadataPath, field, source }) =>
    `${kind}.${escapeSegment(id)}.${metadataPath}.${field}@${digest(source)}`

const collectHumanText = ({ kind, id, value, metadataPath, records }) => {
    if (Array.isArray(value)) {
        value.forEach((item, index) =>
            collectHumanText({
                kind,
                id,
                value: item,
                metadataPath: `${metadataPath}/${itemIdentity(metadataPath.split('/').at(-1), item, index)}`,
                records
            })
        )
        return
    }
    if (!value || typeof value !== 'object') return

    for (const [field, nestedValue] of Object.entries(value)) {
        if (HUMAN_TEXT_FIELDS.has(field) && typeof nestedValue === 'string' && nestedValue.trim()) {
            const record = { kind, id, path: metadataPath, field, source: nestedValue }
            records.push({ ...record, digest: digest(nestedValue), key: translationKey(record) })
            continue
        }
        if (nestedValue && typeof nestedValue === 'object' && !['default', 'show', 'hide'].includes(field)) {
            collectHumanText({ kind, id, value: nestedValue, metadataPath: `${metadataPath}/${escapeSegment(field)}`, records })
        }
    }
}

const instantiateNodes = (root) => {
    const nodes = new Map()
    const failures = []
    const directory = path.join(root, 'packages/components/dist/nodes')
    for (const file of walkFiles(directory)) {
        try {
            const module = require(file)
            if (!module.nodeClass) continue
            const instance = new module.nodeClass()
            if (!instance.name) continue
            if (nodes.has(instance.name)) {
                failures.push({ type: 'duplicate-node-name', name: instance.name, files: [nodes.get(instance.name).file, file] })
                continue
            }
            nodes.set(instance.name, { file, instance })
        } catch (error) {
            failures.push({ type: 'node-constructor', file, message: error instanceof Error ? error.message : String(error) })
        }
    }
    return { nodes, failures }
}

const instantiateCredentials = (root) => {
    const credentials = new Map()
    const failures = []
    const directory = path.join(root, 'packages/components/dist/credentials')
    for (const file of walkFiles(directory).filter((candidate) => candidate.endsWith('.credential.js'))) {
        try {
            const module = require(file)
            if (!module.credClass) continue
            const instance = new module.credClass()
            if (!instance.name) continue
            if (credentials.has(instance.name)) {
                failures.push({
                    type: 'duplicate-credential-name',
                    name: instance.name,
                    files: [credentials.get(instance.name).file, file]
                })
                continue
            }
            credentials.set(instance.name, { file, instance })
        } catch (error) {
            failures.push({ type: 'credential-constructor', file, message: error instanceof Error ? error.message : String(error) })
        }
    }
    return { credentials, failures }
}

const buildReport = ({ root, scope }) => {
    const { nodes, failures: nodeFailures } = instantiateNodes(root)
    const { credentials, failures: credentialFailures } = instantiateCredentials(root)
    const records = []
    const dynamicMethods = []
    const categories = new Set()

    if (scope !== 'credentials') {
        for (const { instance } of nodes.values()) {
            if (scope === 'agentflow-v2' && instance.category !== 'Agent Flows') continue
            categories.add(instance.category)
            collectHumanText({
                kind: 'node',
                id: instance.name,
                value: {
                    label: instance.label,
                    description: instance.description,
                    warning: instance.warning,
                    deprecateMessage: instance.deprecateMessage,
                    hint: instance.hint,
                    inputs: instance.inputs,
                    output: instance.output,
                    outputs: instance.outputs,
                    credential: instance.credential
                },
                metadataPath: 'root',
                records
            })
            for (const method of Object.keys(instance.loadMethods ?? {})) {
                dynamicMethods.push({ node: instance.name, method })
            }
        }
    }

    if (scope !== 'agentflow-v2') {
        for (const { instance } of credentials.values()) {
            collectHumanText({
                kind: 'credential',
                id: instance.name,
                value: { label: instance.label, description: instance.description, inputs: instance.inputs },
                metadataPath: 'root',
                records
            })
        }
    }

    const recordsByKey = new Map()
    const occurrenceCounts = new Map()
    const collisions = new Map()
    for (const record of records) {
        occurrenceCounts.set(record.key, (occurrenceCounts.get(record.key) ?? 0) + 1)
        const existing = recordsByKey.get(record.key)
        if (!existing) recordsByKey.set(record.key, record)
        else if (existing.source !== record.source) {
            collisions.set(record.key, [...new Set([existing.source, record.source])])
        }
    }
    const uniqueRecords = [...recordsByKey.values()]
    const duplicateKeys = [...occurrenceCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key)

    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: {
            root,
            scope,
            nodeCount: nodes.size,
            credentialCount: credentials.size,
            nodeFailures,
            credentialFailures
        },
        summary: {
            recordCount: uniqueRecords.length,
            occurrenceCount: records.length,
            categoryCount: categories.size,
            dynamicMethodCount: dynamicMethods.length,
            duplicateKeyCount: duplicateKeys.length,
            collisionKeyCount: collisions.size
        },
        categories: [...categories].sort(),
        dynamicMethods: dynamicMethods.sort((left, right) => `${left.node}.${left.method}`.localeCompare(`${right.node}.${right.method}`)),
        records: uniqueRecords.sort((left, right) => left.key.localeCompare(right.key)),
        duplicateKeys: duplicateKeys.sort(),
        collisions: [...collisions.entries()].map(([key, sources]) => ({ key, sources }))
    }
}

const options = parseArguments(process.argv.slice(2))
const report = buildReport(options)
const serialized = `${JSON.stringify(report, null, 2)}\n`

if (options.output) writeFileSync(options.output, serialized, { encoding: 'utf8', mode: 0o600 })
else process.stdout.write(serialized)

if (report.source.nodeFailures.length > 0 || report.source.credentialFailures.length > 0 || report.summary.collisionKeyCount > 0) {
    process.exitCode = 1
}
