#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = process.cwd()
const scriptDirectory = path.join(root, 'scripts/metadata-i18n')
const catalogDirectory = path.join(root, 'packages/server/src/services/component-metadata-localization/catalog')
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'flowise-metadata-i18n-'))

const fail = (message) => {
    throw new Error(message)
}

const readCatalogTuples = (fileName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const tuples = []

    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
            for (const element of node.initializer.elements) {
                if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) continue
                const [key, translation] = element.elements
                if (!ts.isStringLiteralLike(key) || !ts.isStringLiteralLike(translation)) {
                    fail(`${fileName}: catalog tuples must contain two string literals`)
                }
                tuples.push([key.text, translation.text])
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (tuples.length === 0) fail(`${fileName}: no catalog tuples found`)
    return tuples
}

const readObjectKeys = (fileName, variableName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const keys = []

    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName && node.initializer) {
            const initializer = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
            if (!initializer || !ts.isObjectLiteralExpression(initializer)) fail(`${fileName}: ${variableName} must be an object literal`)
            for (const property of initializer.properties) {
                if (!ts.isPropertyAssignment(property)) continue
                if (ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name)) keys.push(property.name.text)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return keys
}

const runExtract = (scope) => {
    const output = path.join(temporaryDirectory, `${scope}.json`)
    execFileSync(process.execPath, [path.join(scriptDirectory, 'extract.mjs'), '--root', root, '--scope', scope, '--output', output], {
        cwd: root,
        stdio: 'inherit'
    })
    return JSON.parse(readFileSync(output, 'utf8'))
}

const toCatalogMap = (tuples, label) => {
    const result = new Map()
    let identicalDuplicateCount = 0
    for (const [key, translation] of tuples) {
        if (!translation.trim()) fail(`${label}: empty translation for ${key}`)
        if (/<\s*script\b|javascript\s*:|\bon\w+\s*=/i.test(translation)) fail(`${label}: unsafe markup in ${key}`)
        const previous = result.get(key)
        if (previous !== undefined && previous !== translation) fail(`${label}: conflicting duplicate translation for ${key}`)
        if (previous === translation) identicalDuplicateCount += 1
        result.set(key, translation)
    }
    return { map: result, identicalDuplicateCount }
}

const difference = (left, right) => [...left].filter((item) => !right.has(item)).sort()

const assertExactCoverage = (report, catalog, label) => {
    const expected = new Set(report.records.map((record) => record.key))
    const actual = new Set(catalog.keys())
    const missing = difference(expected, actual)
    const extra = difference(actual, expected)
    if (missing.length || extra.length) {
        fail(`${label}: coverage mismatch; missing=${JSON.stringify(missing.slice(0, 10))}; extra=${JSON.stringify(extra.slice(0, 10))}`)
    }

    for (const record of report.records) {
        const translation = catalog.get(record.key)
        const sourceTags = record.source.match(/<\/?[A-Za-z][^>]*>/g) ?? []
        const translatedTags = translation.match(/<\/?[A-Za-z][^>]*>/g) ?? []
        if (JSON.stringify(sourceTags) !== JSON.stringify(translatedTags)) fail(`${label}: HTML structure changed for ${record.key}`)

        const placeholderPattern = /\{\{[^{}]+\}\}|<([A-Z][A-Z0-9_ -]*)>|\$[A-Za-z_][A-Za-z0-9_.]*/g
        const sourcePlaceholders = record.source.match(placeholderPattern) ?? []
        const translatedPlaceholders = translation.match(placeholderPattern) ?? []
        if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
            fail(`${label}: executable placeholder changed for ${record.key}`)
        }
    }
}

try {
    const agentflowReport = runExtract('agentflow-v2')
    const credentialReport = runExtract('credentials')
    const allReport = runExtract('all')

    const agentflowTuples = ['zhCNAgentflowA.ts', 'zhCNAgentflowB.ts', 'zhCNAgentflowC.ts'].flatMap(readCatalogTuples)
    const credentialTuples = ['zhCNCredentialsA.ts', 'zhCNCredentialsB.ts', 'zhCNCredentialsC.ts'].flatMap(readCatalogTuples)
    const agentflowCatalog = toCatalogMap(agentflowTuples, 'agentflow-v2')
    const credentialCatalog = toCatalogMap(credentialTuples, 'credentials')

    assertExactCoverage(agentflowReport, agentflowCatalog.map, 'agentflow-v2')
    assertExactCoverage(credentialReport, credentialCatalog.map, 'credentials')

    const expectedCategories = new Set(allReport.categories.map((category) => category.split(';')[0]))
    const actualCategories = new Set(readObjectKeys('zhCNCategories.ts', 'ZH_CN_CATEGORIES'))
    const missingCategories = difference(expectedCategories, actualCategories)
    const extraCategories = difference(actualCategories, expectedCategories)
    if (missingCategories.length || extraCategories.length) {
        fail(`categories: missing=${JSON.stringify(missingCategories)}; extra=${JSON.stringify(extraCategories)}`)
    }

    const expectedDynamicPolicies = new Set(agentflowReport.dynamicMethods.map(({ node, method }) => `${node}.${method}`))
    const actualDynamicPolicies = new Set(readObjectKeys('zhCNDynamicPolicies.ts', 'ZH_CN_DYNAMIC_POLICIES'))
    const missingPolicies = difference(expectedDynamicPolicies, actualDynamicPolicies)
    const extraPolicies = difference(actualDynamicPolicies, expectedDynamicPolicies)
    if (missingPolicies.length || extraPolicies.length) {
        fail(`dynamic policies: missing=${JSON.stringify(missingPolicies)}; extra=${JSON.stringify(extraPolicies)}`)
    }

    process.stdout.write(
        `${JSON.stringify(
            {
                status: 'pass',
                agentflow: {
                    records: agentflowCatalog.map.size,
                    tupleDuplicates: agentflowCatalog.identicalDuplicateCount,
                    dynamicMethods: expectedDynamicPolicies.size
                },
                credentials: {
                    records: credentialCatalog.map.size,
                    tupleDuplicates: credentialCatalog.identicalDuplicateCount
                },
                categories: expectedCategories.size,
                constructorFailures: {
                    nodes: allReport.source.nodeFailures.length,
                    credentials: allReport.source.credentialFailures.length
                }
            },
            null,
            2
        )}\n`
    )
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
}
