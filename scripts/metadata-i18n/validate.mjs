#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { assertCurrentComponentBuild } from './fingerprint.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = process.cwd()
const scriptDirectory = path.join(root, 'scripts/metadata-i18n')
const catalogDirectory = path.join(root, 'packages/server/src/services/component-metadata-localization/catalog')
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'flowise-metadata-i18n-'))

const fail = (message) => {
    throw new Error(message)
}

const assertNoParseDiagnostics = (sourceFile, fileName) => {
    if (sourceFile.parseDiagnostics.length > 0) {
        const diagnostic = sourceFile.parseDiagnostics[0]
        fail(`${fileName}: TypeScript parse error ${diagnostic.code}`)
    }
}

const readCatalogTuples = (fileName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assertNoParseDiagnostics(sourceFile, fileName)
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

const readObjectEntries = (fileName, variableName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assertNoParseDiagnostics(sourceFile, fileName)
    const entries = []

    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName && node.initializer) {
            const initializer = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
            if (!initializer || !ts.isObjectLiteralExpression(initializer)) fail(`${fileName}: ${variableName} must be an object literal`)
            for (const property of initializer.properties) {
                if (!ts.isPropertyAssignment(property)) continue
                if (!ts.isStringLiteralLike(property.name) && !ts.isIdentifier(property.name)) continue
                if (!ts.isStringLiteralLike(property.initializer)) fail(`${fileName}: ${variableName} values must be string literals`)
                entries.push([property.name.text, property.initializer.text])
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return entries
}

const readMapSpreadIdentifiers = (fileName, variableName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assertNoParseDiagnostics(sourceFile, fileName)
    let identifiers

    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName && node.initializer) {
            const mapExpression = node.initializer
            if (
                !ts.isNewExpression(mapExpression) ||
                !ts.isIdentifier(mapExpression.expression) ||
                mapExpression.expression.text !== 'Map'
            ) {
                fail(`${fileName}: ${variableName} must be constructed with Map`)
            }
            const entries = mapExpression.arguments?.[0]
            if (!entries || !ts.isArrayLiteralExpression(entries)) fail(`${fileName}: ${variableName} must be constructed from an array`)
            identifiers = entries.elements.map((element) => {
                if (!ts.isSpreadElement(element) || !ts.isIdentifier(element.expression)) {
                    fail(`${fileName}: ${variableName} entries must be spread identifiers`)
                }
                return element.expression.text
            })
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (!identifiers) fail(`${fileName}: ${variableName} not found`)
    return identifiers
}

const readNamedImportBindings = (fileName) => {
    const absolutePath = path.join(catalogDirectory, fileName)
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assertNoParseDiagnostics(sourceFile, fileName)
    const bindings = new Map()

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        const namedBindings = statement.importClause?.namedBindings
        if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
        for (const specifier of namedBindings.elements) {
            const localName = specifier.name.text
            const importedName = specifier.propertyName?.text ?? localName
            if (bindings.has(localName)) fail(`${fileName}: duplicate import binding ${localName}`)
            bindings.set(localName, `${statement.moduleSpecifier.text}#${importedName}`)
        }
    }
    return bindings
}

const assertRuntimeCatalogComposition = (fileName, variableName, expectedBindings, label) => {
    const spreadIdentifiers = readMapSpreadIdentifiers(fileName, variableName)
    assertSetEquality(new Set(expectedBindings.keys()), new Set(spreadIdentifiers), label)

    const actualBindings = readNamedImportBindings(fileName)
    for (const [identifier, expectedBinding] of expectedBindings) {
        const actualBinding = actualBindings.get(identifier)
        if (actualBinding !== expectedBinding) {
            fail(`${label}: ${identifier} expected import ${expectedBinding}, received ${actualBinding ?? 'missing'}`)
        }
    }
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

const assertSetEquality = (expected, actual, label) => {
    const missing = difference(expected, actual)
    const extra = difference(actual, expected)
    if (missing.length || extra.length) {
        fail(`${label}: coverage mismatch; missing=${JSON.stringify(missing.slice(0, 10))}; extra=${JSON.stringify(extra.slice(0, 10))}`)
    }
}

const executableTokenPattern =
    /\{\{[^{}]+\}\}|\{[A-Za-z_][A-Za-z0-9_.-]*\}|<([A-Za-z][A-Za-z0-9_ -]*)>|\$[A-Za-z_][A-Za-z0-9_.]*|https?:\/\/[^\s<>"'),，。；：！？、）】》」』\u3400-\u9fff]+|`[^`]+`|"[^"\n]+"\s*:|\bRequests (?:Get|Post|Put|Patch|Delete|Head|Options)\b|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(?:s|ed|ing)?\b/g

const executableTokens = (value) =>
    (value.match(executableTokenPattern) ?? []).map((token) => {
        if (/^https?:\/\//.test(token)) return token.replace(/[)\]}>.,;:!?，。；：！？、）】》」』]+$/, '')
        const requestsMethod = token.match(/^Requests (Get|Post|Put|Patch|Delete|Head|Options)$/)
        if (requestsMethod) return requestsMethod[1].toUpperCase()
        const httpMethod = token.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(?:s|ed|ing)?$/)
        return httpMethod?.[1] ?? token
    })

const assertTranslationStructure = (record, translation, label) => {
    if (typeof translation !== 'string') fail(`${label}: unresolved translation for ${record.key}`)

    const sourceTags = record.source.match(/<\/?[A-Za-z][^>]*>/g) ?? []
    const translatedTags = translation.match(/<\/?[A-Za-z][^>]*>/g) ?? []
    if (JSON.stringify(sourceTags) !== JSON.stringify(translatedTags)) fail(`${label}: HTML structure changed for ${record.key}`)

    const sourceTokens = executableTokens(record.source)
    const translatedTokens = executableTokens(translation)
    if (JSON.stringify(sourceTokens.sort()) !== JSON.stringify(translatedTokens.sort())) {
        fail(`${label}: executable token changed for ${record.key}`)
    }
}

const assertExactCoverage = (records, catalog, label) => {
    assertSetEquality(new Set(records.map((record) => record.key)), new Set(catalog.keys()), label)
    for (const record of records) assertTranslationStructure(record, catalog.get(record.key), label)
}

const assertSourceKeyIntegrity = (records, label) => {
    const sourcesByKey = new Map()
    for (const record of records) {
        const previous = sourcesByKey.get(record.sourceKey)
        if (previous !== undefined && previous !== record.source) fail(`${label}: source digest collision for ${record.sourceKey}`)
        sourcesByKey.set(record.sourceKey, record.source)
    }
}

const assertResolvedCoverage = (records, exactCatalog, sourceCatalog, label) => {
    assertSourceKeyIntegrity(records, label)
    const expectedSourceKeys = new Set(records.filter((record) => !exactCatalog.has(record.key)).map((record) => record.sourceKey))
    assertSetEquality(expectedSourceKeys, new Set(sourceCatalog.keys()), `${label} source catalog`)

    for (const record of records) {
        const translation = exactCatalog.get(record.key) ?? sourceCatalog.get(record.sourceKey)
        assertTranslationStructure(record, translation, label)
    }
}

const assertReachableContainers = (records) => {
    const supported = new Set(['inputs', 'output', 'outputs', 'options', 'valueOptions', 'tabs', 'array', 'datagrid', 'credential', 'hint'])
    const unreachable = records.filter((record) => record.containers.some((container) => !supported.has(container)))
    if (unreachable.length) {
        fail(
            `node metadata reachability: unsupported=${JSON.stringify(
                unreachable.slice(0, 10).map(({ key, containers }) => ({ key, containers }))
            )}`
        )
    }
}

const dynamicDescriptionRecords = () => {
    const models = JSON.parse(readFileSync(path.join(root, 'packages/components/models.json'), 'utf8'))
    const records = new Map()
    for (const category of ['chat', 'embedding', 'llm']) {
        for (const provider of models[category] ?? []) {
            for (const option of provider.models ?? []) {
                if (typeof option.description !== 'string' || !option.description.trim()) continue
                const digest = createHash('sha256').update(option.description, 'utf8').digest('hex').slice(0, 12)
                const sourceKey = `dynamic.description@${digest}`
                const record = {
                    key: sourceKey,
                    sourceKey,
                    source: option.description,
                    field: 'description',
                    provider: provider.name,
                    category
                }
                const previous = records.get(sourceKey)
                if (previous && previous.source !== record.source) fail(`dynamic descriptions: source digest collision for ${sourceKey}`)
                records.set(sourceKey, record)
            }
        }
    }
    return [...records.values()]
}

const METADATA_REFERENCE_DYNAMIC_METHODS = new Set([
    'agentAgentflow.listEmbeddings',
    'agentAgentflow.listModels',
    'agentAgentflow.listTools',
    'agentAgentflow.listVectorStores',
    'conditionAgentAgentflow.listModels',
    'humanInputAgentflow.listModels',
    'llmAgentflow.listModels',
    'toolAgentflow.listTools'
])
const TENANT_ACTION_NODES = new Set(['customMCP', 'customMcpServerTool', 'supergatewayMCP'])
const TENANT_DYNAMIC_METHODS = new Set([
    'listAgentflows',
    'listChatflows',
    'listEndpoints',
    'listFlows',
    'listPreviousNodes',
    'listRuntimeStateKeys',
    'listServers',
    'listStores',
    'listToolInputArgs',
    'listTools'
])
const PROVIDER_DYNAMIC_METHODS = new Set([
    'listActions',
    'listApps',
    'listAssistants',
    'listConnections',
    'listFiles',
    'listSpreadsheets',
    'listTables',
    'listTopics'
])

const expectedDynamicPolicy = ({ node, method }) => {
    const key = `${node}.${method}`
    if (METADATA_REFERENCE_DYNAMIC_METHODS.has(key)) return 'metadata-ref'
    if (method === 'listModels' || method === 'listRegions') return 'system-catalog'
    if (method === 'listActions' && TENANT_ACTION_NODES.has(node)) return 'tenant-passthrough'
    if (PROVIDER_DYNAMIC_METHODS.has(method)) return 'provider-passthrough'
    if (TENANT_DYNAMIC_METHODS.has(method)) return 'tenant-passthrough'
    return 'unknown'
}

const assertBaselineValue = (label, actual, expected) => {
    if (actual !== expected) fail(`baseline: ${label} expected ${expected}, received ${actual}`)
}

const setDigest = (values) =>
    createHash('sha256')
        .update([...values].sort().join('\n'), 'utf8')
        .digest('hex')

const assertBaselineDigest = (label, values, expected) => {
    const actual = setDigest(values)
    if (actual !== expected) fail(`baseline: ${label} digest expected ${expected}, received ${actual}`)
}

try {
    assertCurrentComponentBuild(root)
    const agentflowReport = runExtract('agentflow-v2')
    const credentialReport = runExtract('credentials')
    const allReport = runExtract('all')

    const agentflowTuples = ['zhCNAgentflowA.ts', 'zhCNAgentflowB.ts', 'zhCNAgentflowC.ts'].flatMap(readCatalogTuples)
    const credentialTuples = ['zhCNCredentialsA.ts', 'zhCNCredentialsB.ts', 'zhCNCredentialsC.ts'].flatMap(readCatalogTuples)
    const nodeOverrideTuples = readCatalogTuples('zhCNNodeOverrides.ts')
    const nodeSourceTuples = [
        'zhCNNodeSourcesA.ts',
        'zhCNNodeSourcesB.ts',
        'zhCNNodeSourcesC.ts',
        'zhCNNodeSourcesD.ts',
        'zhCNNodeSourcesE.ts',
        'zhCNNodeSourcesF.ts',
        'zhCNNodeValueOptions.ts'
    ].flatMap(readCatalogTuples)
    const dynamicDescriptionTuples = readCatalogTuples('zhCNDynamicDescriptions.ts')
    const agentflowCatalog = toCatalogMap(agentflowTuples, 'agentflow-v2')
    const credentialCatalog = toCatalogMap(credentialTuples, 'credentials')
    const nodeOverrideCatalog = toCatalogMap(nodeOverrideTuples, 'node overrides')
    const allNodeExactCatalog = toCatalogMap([...agentflowTuples, ...nodeOverrideTuples], 'all node exact catalog')
    const nodeSourceCatalog = toCatalogMap(nodeSourceTuples, 'node source catalog')
    const dynamicDescriptionCatalog = toCatalogMap(dynamicDescriptionTuples, 'dynamic descriptions')
    const combinedSourceCatalog = toCatalogMap([...nodeSourceTuples, ...dynamicDescriptionTuples], 'combined source catalog')
    const nodeRecords = allReport.records.filter((record) => record.kind === 'node')
    const dynamicDescriptions = dynamicDescriptionRecords()

    assertExactCoverage(agentflowReport.records, agentflowCatalog.map, 'agentflow-v2')
    assertExactCoverage(credentialReport.records, credentialCatalog.map, 'credentials')
    const expectedNodeOverrides = new Map([
        ['node.apiLoader.root/inputs/body.label@6ccaa6415b5e', '请求体'],
        ['node.googleCalendarTool.root/inputs/summary.label@8e76a94ac832', '标题'],
        ['node.requestsPost.root/inputs/requestPostBody.label@6ccaa6415b5e', '请求体'],
        ['node.requestsPut.root/inputs/requestPutBody.label@6ccaa6415b5e', '请求体']
    ])
    assertSetEquality(new Set(expectedNodeOverrides.keys()), new Set(nodeOverrideCatalog.map.keys()), 'node overrides')
    for (const [key, expectedTranslation] of expectedNodeOverrides) {
        if (nodeOverrideCatalog.map.get(key) !== expectedTranslation) fail(`node overrides: unexpected translation for ${key}`)
    }
    assertResolvedCoverage(nodeRecords, allNodeExactCatalog.map, nodeSourceCatalog.map, 'all nodes')
    assertReachableContainers(nodeRecords)
    assertExactCoverage(dynamicDescriptions, dynamicDescriptionCatalog.map, 'dynamic descriptions')
    assertBaselineValue('nodes', allReport.source.nodeCount, 311)
    assertBaselineValue('credentials', allReport.source.credentialCount, 114)
    assertBaselineValue('all unique records', allReport.summary.recordCount, 6697)
    assertBaselineValue('all occurrences', allReport.summary.occurrenceCount, 6742)
    assertBaselineValue('node records', nodeRecords.length, 6210)
    assertBaselineValue('agentflow records', agentflowCatalog.map.size, 910)
    assertBaselineValue('credential records', credentialCatalog.map.size, 487)
    assertBaselineValue('node overrides', nodeOverrideTuples.length, 4)
    assertBaselineValue('node source translations', nodeSourceCatalog.map.size, 2884)
    assertBaselineValue('value option records', nodeRecords.filter((record) => record.field === 'valueOption').length, 48)
    assertBaselineValue('dynamic descriptions', dynamicDescriptionCatalog.map.size, 137)
    assertBaselineValue('combined source translations', combinedSourceCatalog.map.size, 3021)
    assertBaselineValue('combined source duplicate tuples', combinedSourceCatalog.identicalDuplicateCount, 0)
    assertBaselineDigest(
        'record keys',
        allReport.records.map((record) => record.key),
        '1449fbb8d534f9e6b9d2600998a93062541cd3fbd1bc7b0674ecc4590ae088ba'
    )
    assertBaselineDigest('node names', allReport.source.nodeNames, '21c4ac4890a2bf98b27d362ca49af184602e0a3503ec856051ed3dfd89f2eed3')
    assertBaselineDigest(
        'credential names',
        allReport.source.credentialNames,
        'a9c4c8964944b44130ede6d1221f2a1af74fc8acc79ef169be0cf925b19d764d'
    )
    assertBaselineDigest(
        'dynamic methods',
        allReport.dynamicMethods.map(({ node, method }) => `${node}.${method}`),
        'eb9ad4c55d5f204cfa228cebd84985c5fad7729c951cc860525dcb4f1fad0205'
    )
    assertBaselineDigest('categories', allReport.categories, '48a3d08b1b8703f54825ab5b757656e48b34f9602e3e6527b2cc7e826656e150')
    assertBaselineDigest(
        'dynamic descriptions',
        dynamicDescriptions.map((record) => record.key),
        'da3b4aab01e9dc05415a9501c56631e76f8c1644944a9cea29a3d2abf7548e24'
    )

    assertRuntimeCatalogComposition(
        'index.ts',
        'ZH_CN_METADATA_TRANSLATIONS',
        new Map([
            ['ZH_CN_AGENTFLOW_A', './zhCNAgentflowA#ZH_CN_AGENTFLOW_A'],
            ['ZH_CN_AGENTFLOW_B', './zhCNAgentflowB#ZH_CN_AGENTFLOW_B'],
            ['ZH_CN_AGENTFLOW_C', './zhCNAgentflowC#ZH_CN_AGENTFLOW_C'],
            ['ZH_CN_CREDENTIALS_A', './zhCNCredentialsA#ZH_CN_CREDENTIALS_A'],
            ['ZH_CN_CREDENTIALS_B', './zhCNCredentialsB#ZH_CN_CREDENTIALS_B'],
            ['ZH_CN_CREDENTIALS_C', './zhCNCredentialsC#ZH_CN_CREDENTIALS_C'],
            ['ZH_CN_NODE_OVERRIDES', './zhCNNodeOverrides#ZH_CN_NODE_OVERRIDES']
        ]),
        'runtime exact catalog composition'
    )
    assertRuntimeCatalogComposition(
        'index.ts',
        'ZH_CN_METADATA_SOURCE_TRANSLATIONS',
        new Map([
            ['ZH_CN_NODE_SOURCES_A', './zhCNNodeSourcesA#ZH_CN_NODE_SOURCES_A'],
            ['ZH_CN_NODE_SOURCES_B', './zhCNNodeSourcesB#ZH_CN_NODE_SOURCES_B'],
            ['ZH_CN_NODE_SOURCES_C', './zhCNNodeSourcesC#ZH_CN_NODE_SOURCES_C'],
            ['ZH_CN_NODE_SOURCES_D', './zhCNNodeSourcesD#ZH_CN_NODE_SOURCES_D'],
            ['ZH_CN_NODE_SOURCES_E', './zhCNNodeSourcesE#ZH_CN_NODE_SOURCES_E'],
            ['ZH_CN_NODE_SOURCES_F', './zhCNNodeSourcesF#ZH_CN_NODE_SOURCES_F'],
            ['ZH_CN_NODE_VALUE_OPTIONS', './zhCNNodeValueOptions#ZH_CN_NODE_VALUE_OPTIONS'],
            ['ZH_CN_DYNAMIC_DESCRIPTIONS', './zhCNDynamicDescriptions#ZH_CN_DYNAMIC_DESCRIPTIONS']
        ]),
        'runtime source catalog composition'
    )

    const expectedCategories = new Set(allReport.categories.map((category) => category.split(';')[0]))
    const actualCategories = new Set(readObjectEntries('zhCNCategories.ts', 'ZH_CN_CATEGORIES').map(([key]) => key))
    const missingCategories = difference(expectedCategories, actualCategories)
    const extraCategories = difference(actualCategories, expectedCategories)
    if (missingCategories.length || extraCategories.length) {
        fail(`categories: missing=${JSON.stringify(missingCategories)}; extra=${JSON.stringify(extraCategories)}`)
    }

    const expectedDynamicPolicies = new Set(allReport.dynamicMethods.map(({ node, method }) => `${node}.${method}`))
    const dynamicPolicyEntries = readObjectEntries('zhCNDynamicPolicies.ts', 'ZH_CN_DYNAMIC_POLICIES')
    const dynamicPolicyMap = new Map(dynamicPolicyEntries)
    if (dynamicPolicyMap.size !== dynamicPolicyEntries.length) fail('dynamic policies: duplicate keys')
    const actualDynamicPolicies = new Set(dynamicPolicyMap.keys())
    const missingPolicies = difference(expectedDynamicPolicies, actualDynamicPolicies)
    const extraPolicies = difference(actualDynamicPolicies, expectedDynamicPolicies)
    if (missingPolicies.length || extraPolicies.length) {
        fail(`dynamic policies: missing=${JSON.stringify(missingPolicies)}; extra=${JSON.stringify(extraPolicies)}`)
    }

    for (const dynamicMethod of allReport.dynamicMethods) {
        const key = `${dynamicMethod.node}.${dynamicMethod.method}`
        const expectedPolicy = expectedDynamicPolicy(dynamicMethod)
        const actualPolicy = dynamicPolicyMap.get(key)
        if (actualPolicy !== expectedPolicy) {
            fail(`dynamic policies: ${key} expected ${expectedPolicy}, received ${actualPolicy}`)
        }
    }

    const policyCounts = { 'metadata-ref': 0, 'system-catalog': 0, 'tenant-passthrough': 0, 'provider-passthrough': 0, unknown: 0 }
    for (const [key, policy] of dynamicPolicyMap) {
        if (!Object.hasOwn(policyCounts, policy)) fail(`dynamic policies: invalid policy ${policy} for ${key}`)
        policyCounts[policy] += 1
    }
    const systemPolicyCount = policyCounts['metadata-ref'] + policyCounts['system-catalog']
    if (
        systemPolicyCount !== 51 ||
        policyCounts['tenant-passthrough'] !== 24 ||
        policyCounts['provider-passthrough'] !== 16 ||
        policyCounts.unknown !== 0
    ) {
        fail(`dynamic policies: unexpected classification counts ${JSON.stringify({ ...policyCounts, system: systemPolicyCount })}`)
    }

    process.stdout.write(
        `${JSON.stringify(
            {
                status: 'pass',
                nodes: {
                    count: allReport.source.nodeCount,
                    records: nodeRecords.length,
                    exactRecords: allNodeExactCatalog.map.size,
                    contextOverrides: nodeOverrideTuples.length,
                    sourceTranslations: nodeSourceCatalog.map.size,
                    valueOptionRecords: nodeRecords.filter((record) => record.field === 'valueOption').length,
                    unreachable: 0
                },
                agentflow: {
                    records: agentflowCatalog.map.size,
                    tupleDuplicates: agentflowCatalog.identicalDuplicateCount,
                    dynamicMethods: agentflowReport.dynamicMethods.length
                },
                credentials: {
                    records: credentialCatalog.map.size,
                    tupleDuplicates: credentialCatalog.identicalDuplicateCount
                },
                dynamic: {
                    methods: expectedDynamicPolicies.size,
                    system: systemPolicyCount,
                    tenantPassthrough: policyCounts['tenant-passthrough'],
                    providerPassthrough: policyCounts['provider-passthrough'],
                    unknown: policyCounts.unknown,
                    descriptions: dynamicDescriptionCatalog.map.size
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
