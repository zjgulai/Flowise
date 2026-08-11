#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { parseForESLint } = require('@typescript-eslint/parser')

const contractDirectory = path.dirname(fileURLToPath(import.meta.url))
const loadSchema = (name) => JSON.parse(readFileSync(path.join(contractDirectory, name), 'utf8'))

export const schemas = Object.freeze({
    baseline: loadSchema('ui-copy-baseline.schema.json'),
    receipt: loadSchema('ui-copy-receipt.schema.json')
})

const SOURCE_ROOT = 'packages/ui/src'
const SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.ts', '.tsx'])
const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS)
const SOURCE_EXCLUDES = Object.freeze(['**/*.test.*', '**/*.spec.*'])
const TEST_SOURCE_PATTERN = /\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PATH_PATTERN = /^[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx)$/
const SAFE_TOKEN_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/
const REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9._#/-]{2,79}$/
const RECORD_KINDS = new Set(['attribute', 'jsx-expression', 'jsx-text', 'notification', 'property'])
const REASON_CODES = new Set(['feature-gap', 'legacy-existing', 'temporary-migration', 'upstream-compatibility'])
const UPDATE_REASON_CODES = new Set(['debt-reduction', 'feature-gap', 'temporary-migration', 'upstream-compatibility'])

const DISPLAY_PROPERTIES = new Set([
    'alt',
    'aria-label',
    'buttonText',
    'cancelButtonName',
    'caption',
    'confirmButtonName',
    'description',
    'dialogTitle',
    'emptyText',
    'header',
    'headerName',
    'helperText',
    'label',
    'message',
    'placeholder',
    'primary',
    'searchPlaceholder',
    'secondary',
    'subheader',
    'title',
    'tooltip'
])
const DISPLAY_CALL_SINKS = new Set(['confirm', 'enqueueSnackbar', 'errorFailed', 'showSnackbar'])
const MACHINE_SENSITIVE_SINKS = new Set([
    'data-testid',
    'endpoint',
    'field',
    'href',
    'inputType',
    'method',
    'path',
    'permissionId',
    'route',
    'to'
])

const TECHNICAL_TERM_ALLOWLIST = [
    'Agentflow',
    'AI',
    'Anthropic',
    'API',
    'Arize',
    'Assembly',
    'Auth0',
    'Authorization',
    'AWS',
    'Azure',
    'Bearer',
    'Chatflow',
    'ChatGPT',
    'Chrome',
    'Claude',
    'Cognitive Services',
    'CORS',
    'Content-Type',
    'CSP',
    'CSV',
    'DeepSeek',
    'Eleven Labs',
    'Flowise',
    'Firefox',
    'Gemini',
    'GitHub',
    'Google',
    'Groq',
    'HITL',
    'HTML',
    'GET',
    'HEAD',
    'HTTP',
    'HTTPS',
    'ID',
    'If Else',
    'IP',
    'JavaScript',
    'JSON',
    'JWT',
    'Kimi',
    'LangSmith',
    'LlamaIndex',
    'LLM',
    'LocalAI',
    'Lunary',
    'MCP',
    'MB',
    'MIME',
    'Mistral',
    'MUI',
    'NIM',
    'Node.js',
    'NVIDIA',
    'OAuth',
    'OAuth2',
    'Ollama',
    'OpenAI',
    'Opik',
    'PDF',
    'POST',
    'PostgreSQL',
    'Python',
    'RAG',
    'React',
    'Redis',
    'REST',
    'PATCH',
    'PUT',
    'Phoenix',
    'SDK',
    'SSE',
    'SSO',
    'STT',
    'SQL',
    'SQLite',
    'Token',
    'Top',
    'TTS',
    'TypeScript',
    'UI',
    'Upsert',
    'URL',
    'UUID',
    'V1',
    'V2',
    'Webhook',
    'WebSocket',
    'Whisper',
    'XML'
]
const CODE_LITERAL_ALLOWLIST = new Set([
    'array',
    'default',
    'from',
    'llama2',
    'output',
    'question',
    'state',
    'string',
    'sync',
    'userid',
    'vars'
])
const EXACT_TECHNICAL_LITERAL_ALLOWLIST = new Set([
    'DeepSeek R1 Distill Llama 8B',
    'LangChain Hub',
    'Llama 3.1 8B Instruct',
    'Mistral Nemo 12B Instruct',
    'YYYY-MM-DD'
])
const technicalTermPattern = new RegExp(
    `\\b(?:${[...TECHNICAL_TERM_ALLOWLIST]
        .sort((left, right) => right.length - left.length)
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\b`,
    'gi'
)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, expected) => isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!isObject(value)) return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key])])
    )
}
export const canonicalJson = (value) => JSON.stringify(canonicalize(value))

export class ContractError extends Error {
    constructor(code, issues = []) {
        super(code)
        this.name = 'ContractError'
        this.code = code
        this.issues = issues
    }
}

const normalizeLiteral = (literal) =>
    literal
        .replace(/\\[nrt]/g, ' ')
        .replace(/&(?:nbsp|amp|quot|apos);/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

const isCodeLikeLiteral = (literal) =>
    CODE_LITERAL_ALLOWLIST.has(literal) ||
    EXACT_TECHNICAL_LITERAL_ALLOWLIST.has(literal) ||
    /^(?=.*\b(?:const|let|return|function)\b)(?=.*(?:;|=>|\$[A-Za-z_]))[\s\S]+$/.test(literal) ||
    /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~-]*)?$/.test(literal) ||
    /^#[A-Za-z0-9_-]+$/.test(literal) ||
    /^\$[A-Za-z_]\S*$/.test(literal) ||
    /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(literal) ||
    /^x-[a-z0-9-]+$/i.test(literal) ||
    /^\[\s*(?:⌘|Alt|Cmd|Ctrl|Option|Shift)(?:\s*\+\s*[A-Z0-9]+)+\s*\]$/.test(literal) ||
    /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(literal) ||
    /^(?=.*[a-z])(?=(?:.*[A-Z]){2,})[A-Za-z][A-Za-z0-9]*$/.test(literal) ||
    /^Bearer\s+<[a-z][a-z0-9_-]*>$/i.test(literal) ||
    /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/i.test(literal) ||
    /^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/i.test(literal) ||
    /^<\/?[a-z][a-z0-9-]*>$/i.test(literal) ||
    /^(?:gpt|o[1-9]|text-embedding|whisper)-[a-z0-9.-]+$/i.test(literal)

const containsUnapprovedEnglish = (literal) => {
    const normalized = normalizeLiteral(literal)
    if (!normalized || !/[A-Za-z]/.test(normalized) || isCodeLikeLiteral(normalized)) return false

    const residual = normalized
        .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{[A-Za-z_][\w$]*\}/g, ' ')
        .replace(/HTTP\(S\)/gi, ' ')
        .replace(technicalTermPattern, ' ')
        .replace(
            /(?:\$[A-Za-z_]\S*|[a-z][a-z0-9]*_[a-z0-9_]+|\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b(?=[A-Za-z0-9]*[a-z])(?=(?:[A-Za-z0-9]*[A-Z]){2})[A-Za-z][A-Za-z0-9]*\b|\.env\b)/g,
            ' '
        )
        .replace(/[\p{Script=Han}\p{N}\p{P}\p{S}\s]/gu, '')

    return /[A-Za-z]/.test(residual)
}

const getPropertyName = (property) => {
    if (property.computed) return undefined
    if (property.key?.type === 'Identifier') return property.key.name
    if (property.key?.type === 'Literal' && typeof property.key.value === 'string') return property.key.value
    return undefined
}
const getJsxAttributeName = (attribute) => (attribute.name?.type === 'JSXIdentifier' ? attribute.name.name : undefined)
const getCalleeName = (callee) => {
    if (callee?.type === 'Identifier') return callee.name
    if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name
    return undefined
}
const isDisplayCopyCall = (node) => {
    const name = getCalleeName(node.callee)
    return name === 'getErrorMsg' || /^(?:get|format).*ErrorMessage$/i.test(name ?? '')
}
const unwrapStaticExpression = (node) => {
    let expression = node
    while (expression && ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(expression.type)) {
        expression = expression.expression
    }
    return expression
}

const collectStaticBindings = (scopeManager) => {
    const bindingByReference = new WeakMap()
    scopeManager.scopes.forEach((scope) => {
        scope.variables.forEach((variable) => {
            const writes = variable.references.filter((reference) => reference.isWrite())
            const binding = writes.length === 1 ? writes[0].writeExpr : undefined
            if (!binding) return
            variable.references.forEach((reference) => {
                if (reference.isRead()) bindingByReference.set(reference.identifier, binding)
            })
        })
    })
    return bindingByReference
}

const getStaticMemberKey = (member) => {
    if (!member.computed && member.property?.type === 'Identifier') return member.property.name
    if (member.computed && member.property?.type === 'Literal' && ['string', 'number'].includes(typeof member.property.value)) {
        return String(member.property.value)
    }
    return undefined
}

const resolveStaticMemberValues = (member, staticBindings, visitedBindings) => {
    const key = getStaticMemberKey(member)
    if (key === undefined) return []

    const resolveObjects = (node, visited) => {
        const expression = unwrapStaticExpression(node)
        if (!expression) return []
        if (expression.type === 'Identifier') {
            const binding = staticBindings.get(expression)
            if (!binding || visited.has(binding)) return []
            const nextVisited = new Set(visited)
            nextVisited.add(binding)
            return resolveObjects(binding, nextVisited)
        }
        if (expression.type === 'MemberExpression') return resolveStaticMemberValues(expression, staticBindings, visited)
        return [expression]
    }

    return resolveObjects(member.object, visitedBindings).flatMap((object) => {
        if (object.type === 'ObjectExpression') {
            return object.properties
                .filter((property) => property.type === 'Property' && property.kind === 'init' && getPropertyName(property) === key)
                .map((property) => property.value)
        }
        if (object.type === 'ArrayExpression' && /^\d+$/.test(key)) return object.elements[Number(key)] ?? []
        return []
    })
}

const collectStaticCopy = (node, record, staticBindings, visitedBindings = new Set()) => {
    if (!node || typeof node !== 'object') return
    switch (node.type) {
        case 'Literal':
            if (typeof node.value === 'string') record(node.value)
            return
        case 'Identifier': {
            const binding = staticBindings.get(node)
            if (!binding || visitedBindings.has(binding)) return
            const nextVisited = new Set(visitedBindings)
            nextVisited.add(binding)
            collectStaticCopy(binding, record, staticBindings, nextVisited)
            return
        }
        case 'MemberExpression':
            resolveStaticMemberValues(node, staticBindings, visitedBindings).forEach((value) =>
                collectStaticCopy(value, record, staticBindings, visitedBindings)
            )
            return
        case 'TemplateLiteral':
            node.quasis.forEach((quasi) => record(quasi.value.cooked ?? quasi.value.raw))
            node.expressions.forEach((expression) => collectStaticCopy(expression, record, staticBindings, visitedBindings))
            return
        case 'CallExpression':
            if (isDisplayCopyCall(node)) {
                node.arguments.forEach((argument) => collectStaticCopy(argument, record, staticBindings, visitedBindings))
            }
            return
        case 'ConditionalExpression':
            collectStaticCopy(node.consequent, record, staticBindings, visitedBindings)
            collectStaticCopy(node.alternate, record, staticBindings, visitedBindings)
            return
        case 'LogicalExpression':
            collectStaticCopy(node.left, record, staticBindings, visitedBindings)
            collectStaticCopy(node.right, record, staticBindings, visitedBindings)
            return
        case 'BinaryExpression':
            if (node.operator === '+') {
                collectStaticCopy(node.left, record, staticBindings, visitedBindings)
                collectStaticCopy(node.right, record, staticBindings, visitedBindings)
            }
            return
        case 'SequenceExpression':
            node.expressions.forEach((expression) => collectStaticCopy(expression, record, staticBindings, visitedBindings))
            return
        case 'ArrayExpression':
            node.elements.forEach((element) => collectStaticCopy(element, record, staticBindings, visitedBindings))
            return
        case 'AwaitExpression':
        case 'ChainExpression':
        case 'TSAsExpression':
        case 'TSNonNullExpression':
            collectStaticCopy(node.expression, record, staticBindings, visitedBindings)
            return
        default:
            return
    }
}

const moduleForPath = (relativePath) => {
    const segments = relativePath.split('/')
    return segments[0] === 'views' && segments[1] ? `views/${segments[1]}` : segments[0]
}
const recordId = ({ module, path: relativePath, kind, sink, literalDigest }) =>
    hash([module, relativePath, kind, sink, literalDigest].join('\0'))
const isAssetIdentifier = (kind, sink, literal) =>
    kind === 'attribute' &&
    sink === 'alt' &&
    !literal.includes(' ') &&
    (/[A-Z][A-Za-z0-9]*SVG$/.test(literal) || /(?:SVG|GIF|PNG|JPE?G)$/i.test(literal))

export const scanSourceText = (source, relativePath = 'views/fixture/index.jsx') => {
    if (typeof source !== 'string' || !PATH_PATTERN.test(relativePath) || relativePath.startsWith('/') || relativePath.includes('..')) {
        throw new ContractError('SOURCE_INVALID')
    }

    let ast
    let scopeManager
    try {
        ;({ ast, scopeManager } = parseForESLint(source, {
            ecmaFeatures: { jsx: path.extname(relativePath) !== '.ts' },
            ecmaVersion: 'latest',
            filePath: relativePath,
            range: true,
            sourceType: 'module'
        }))
    } catch {
        throw new ContractError('SOURCE_PARSE_FAILED')
    }

    const staticBindings = collectStaticBindings(scopeManager)
    const debtsById = new Map()
    const machineById = new Map()
    let sinkCount = 0

    const recordDisplay = (kind, sink, literal) => {
        if (typeof literal !== 'string') return
        const normalized = normalizeLiteral(literal)
        if (!normalized) return
        sinkCount += 1
        if (isAssetIdentifier(kind, sink, normalized) || !containsUnapprovedEnglish(normalized)) return

        const literalDigest = hash(normalized)
        const record = {
            module: moduleForPath(relativePath),
            path: relativePath,
            kind,
            sink,
            literalDigest
        }
        const id = recordId(record)
        const previous = debtsById.get(id)
        debtsById.set(id, { id, ...record, occurrences: (previous?.occurrences ?? 0) + 1 })
    }
    const recordMachine = (kind, sink, literal) => {
        if (typeof literal !== 'string') return
        const normalized = normalizeLiteral(literal)
        if (!/[\p{Script=Han}]/u.test(normalized)) return
        const literalDigest = hash(normalized)
        const id = hash([relativePath, kind, sink, literalDigest].join('\0'))
        machineById.set(id, { id, path: relativePath, kind, sink, literalDigest })
    }
    const collectFor = (node, callback) => collectStaticCopy(node, callback, staticBindings)

    const visit = (node, parent) => {
        if (!node || typeof node !== 'object') return

        if (node.type === 'JSXText') recordDisplay('jsx-text', 'children', node.value)

        if (node.type === 'CallExpression') {
            const calleeName = getCalleeName(node.callee)
            if (calleeName && DISPLAY_CALL_SINKS.has(calleeName) && node.arguments[0]) {
                collectFor(node.arguments[0], (literal) => recordDisplay('notification', calleeName, literal))
            }
        }

        if (node.type === 'JSXAttribute') {
            const name = getJsxAttributeName(node)
            const collectAttribute = (callback) => {
                if (node.value?.type === 'Literal') callback(node.value.value)
                if (node.value?.type === 'JSXExpressionContainer') collectFor(node.value.expression, callback)
            }
            if (name && DISPLAY_PROPERTIES.has(name)) collectAttribute((literal) => recordDisplay('attribute', name, literal))
            if (name && MACHINE_SENSITIVE_SINKS.has(name)) collectAttribute((literal) => recordMachine('attribute', name, literal))
        }

        if (node.type === 'Property') {
            const name = getPropertyName(node)
            if (name && DISPLAY_PROPERTIES.has(name)) {
                collectFor(node.value, (literal) => recordDisplay('property', name, literal))
            }
            if (name && MACHINE_SENSITIVE_SINKS.has(name)) {
                collectFor(node.value, (literal) => recordMachine('property', name, literal))
            }
        }

        if (node.type === 'JSXExpressionContainer' && (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment')) {
            collectFor(node.expression, (literal) => recordDisplay('jsx-expression', 'children', literal))
        }

        Object.entries(node).forEach(([key, value]) => {
            if (['comments', 'parent', 'loc', 'range', 'tokens'].includes(key)) return
            if (Array.isArray(value)) value.forEach((child) => visit(child, node))
            else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node)
        })
    }

    visit(ast)
    return {
        relativePath,
        sourceDigest: hash(`${relativePath}\0${source}`),
        sinkCount,
        debts: [...debtsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
        machineViolations: [...machineById.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
}

const scanFiles = (absoluteDirectory, relativeDirectory = '') => {
    const files = []
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        if (entry.isSymbolicLink()) throw new ContractError('SOURCE_SYMLINK_FORBIDDEN')
        const absolutePath = path.join(absoluteDirectory, entry.name)
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
            files.push(...scanFiles(absolutePath, relativePath))
            continue
        }
        if (!entry.isFile() || !SOURCE_EXTENSION_SET.has(path.extname(entry.name)) || TEST_SOURCE_PATTERN.test(entry.name)) continue
        files.push(scanSourceText(readFileSync(absolutePath, 'utf8'), relativePath))
    }
    return files
}

export const scanUiTree = (root = process.cwd()) => {
    const absoluteSourceRoot = path.join(root, SOURCE_ROOT)
    if (!existsSync(absoluteSourceRoot)) throw new ContractError('SOURCE_MISSING')
    const files = scanFiles(absoluteSourceRoot)
    if (files.length === 0) throw new ContractError('SOURCE_EMPTY')
    return { files }
}

const sourceContract = () => ({ root: SOURCE_ROOT, extensions: [...SOURCE_EXTENSIONS], excludes: [...SOURCE_EXCLUDES] })
const baselineDigest = (baseline) => hash(canonicalJson({ ...baseline, baselineDigest: undefined }))
const assertReason = (reason, allowedCodes = REASON_CODES) =>
    exactKeys(reason, ['code', 'reference']) && allowedCodes.has(reason.code) && REFERENCE_PATTERN.test(reason.reference)

const flattenRecords = (files) => files.flatMap(({ debts }) => debts).sort((left, right) => left.id.localeCompare(right.id))
const assertFiles = (files) => {
    if (!Array.isArray(files) || files.length === 0) throw new ContractError('SOURCE_EMPTY')
    const paths = files.map(({ relativePath }) => relativePath)
    if (new Set(paths).size !== paths.length || files.some(({ relativePath }) => !PATH_PATTERN.test(relativePath))) {
        throw new ContractError('SOURCE_INVALID')
    }
    if (files.some(({ machineViolations }) => machineViolations.length > 0)) {
        throw new ContractError('MACHINE_FIELD_TRANSLATED')
    }
}

export const validateBaseline = (baseline) => {
    const issues = []
    if (!exactKeys(baseline, ['schemaVersion', 'source', 'records', 'baselineDigest'])) return ['baseline shape is invalid']
    if (baseline.schemaVersion !== 1) issues.push('schemaVersion is invalid')
    if (
        !exactKeys(baseline.source, ['root', 'extensions', 'excludes']) ||
        baseline.source.root !== SOURCE_ROOT ||
        canonicalJson(baseline.source.extensions) !== canonicalJson(SOURCE_EXTENSIONS) ||
        canonicalJson(baseline.source.excludes) !== canonicalJson(SOURCE_EXCLUDES)
    ) {
        issues.push('source contract is invalid')
    }
    if (!Array.isArray(baseline.records)) {
        issues.push('records must be an array')
    } else {
        const ids = new Set()
        let previousId = ''
        for (const record of baseline.records) {
            if (!exactKeys(record, ['id', 'module', 'path', 'kind', 'sink', 'literalDigest', 'occurrences', 'reason'])) {
                issues.push('record shape is invalid')
                continue
            }
            if (
                !HASH_PATTERN.test(record.id) ||
                typeof record.module !== 'string' ||
                !record.module ||
                !PATH_PATTERN.test(record.path) ||
                record.path.startsWith('/') ||
                record.path.includes('..') ||
                !RECORD_KINDS.has(record.kind) ||
                !SAFE_TOKEN_PATTERN.test(record.sink) ||
                !HASH_PATTERN.test(record.literalDigest) ||
                !Number.isInteger(record.occurrences) ||
                record.occurrences < 1 ||
                !assertReason(record.reason)
            ) {
                issues.push('record value is invalid')
            }
            if (record.id !== recordId(record)) issues.push('record identity is invalid')
            if (ids.has(record.id)) issues.push('record identity is duplicated')
            if (record.id < previousId) issues.push('records are not canonical')
            ids.add(record.id)
            previousId = record.id
        }
    }
    if (!HASH_PATTERN.test(baseline.baselineDigest)) issues.push('baseline digest is invalid')
    return issues
}

export const validateReceipt = (receipt) => {
    const keys = [
        'schemaVersion',
        'status',
        'evidenceGrade',
        'sourceRoot',
        'sourceDigest',
        'baselineDigest',
        'fileCount',
        'sinkCount',
        'baselineDebtCount',
        'currentDebtCount',
        'resolvedDebtCount',
        'providerCall',
        'productionChanged'
    ]
    if (!exactKeys(receipt, keys)) return ['receipt shape is invalid']
    const issues = []
    if (receipt.schemaVersion !== 1) issues.push('schemaVersion is invalid')
    if (!['exact', 'ratchet_tightened'].includes(receipt.status)) issues.push('status is invalid')
    if (receipt.evidenceGrade !== 'L2' || receipt.sourceRoot !== SOURCE_ROOT) issues.push('evidence identity is invalid')
    if (!HASH_PATTERN.test(receipt.sourceDigest) || !HASH_PATTERN.test(receipt.baselineDigest)) issues.push('receipt digest is invalid')
    for (const key of ['fileCount', 'sinkCount']) {
        if (!Number.isInteger(receipt[key]) || receipt[key] < 1) issues.push(`${key} is invalid`)
    }
    for (const key of ['baselineDebtCount', 'currentDebtCount', 'resolvedDebtCount']) {
        if (!Number.isInteger(receipt[key]) || receipt[key] < 0) issues.push(`${key} is invalid`)
    }
    if (receipt.providerCall !== false || receipt.productionChanged !== false) issues.push('side-effect boundary is invalid')
    return issues
}

const withDigest = (baseline) => {
    const candidate = { ...baseline, baselineDigest: '0'.repeat(64) }
    return { ...candidate, baselineDigest: baselineDigest(candidate) }
}

export const buildBaseline = ({ files, reason }) => {
    assertFiles(files)
    if (!assertReason(reason) || reason.code !== 'legacy-existing') throw new ContractError('INIT_REASON_INVALID')
    const records = flattenRecords(files).map((record) => ({ ...record, reason: { ...reason } }))
    return withDigest({ schemaVersion: 1, source: sourceContract(), records })
}

const assertBaseline = (baseline) => {
    if (baseline === undefined) throw new ContractError('BASELINE_MISSING')
    const issues = validateBaseline(baseline)
    if (issues.length > 0) throw new ContractError('SCHEMA_INVALID', issues)
    if (baseline.baselineDigest !== baselineDigest(baseline)) throw new ContractError('BASELINE_DIGEST_MISMATCH')
}

const sourceDigestFor = (files) => hash(canonicalJson(files.map(({ relativePath, sourceDigest }) => ({ relativePath, sourceDigest }))))
const totalOccurrences = (records) => records.reduce((total, { occurrences }) => total + occurrences, 0)

export const evaluateBaseline = ({ files, baseline }) => {
    assertBaseline(baseline)
    assertFiles(files)
    const currentRecords = flattenRecords(files)
    const baselineById = new Map(baseline.records.map((record) => [record.id, record]))

    const additions = currentRecords.filter((record) => {
        const previous = baselineById.get(record.id)
        return !previous || record.occurrences > previous.occurrences
    })
    if (additions.length > 0) throw new ContractError('UI_COPY_DEBT_ADDED')

    const currentById = new Map(currentRecords.map((record) => [record.id, record]))
    const baselineDebtCount = totalOccurrences(baseline.records)
    const currentDebtCount = totalOccurrences(currentRecords)
    const resolvedDebtCount = baseline.records.reduce((total, record) => {
        const current = currentById.get(record.id)
        return total + Math.max(0, record.occurrences - (current?.occurrences ?? 0))
    }, 0)
    const receipt = {
        schemaVersion: 1,
        status: resolvedDebtCount > 0 ? 'ratchet_tightened' : 'exact',
        evidenceGrade: 'L2',
        sourceRoot: SOURCE_ROOT,
        sourceDigest: sourceDigestFor(files),
        baselineDigest: baseline.baselineDigest,
        fileCount: files.length,
        sinkCount: files.reduce((total, { sinkCount }) => total + sinkCount, 0),
        baselineDebtCount,
        currentDebtCount,
        resolvedDebtCount,
        providerCall: false,
        productionChanged: false
    }
    const receiptIssues = validateReceipt(receipt)
    if (receiptIssues.length > 0) throw new ContractError('RECEIPT_INVALID', receiptIssues)
    return receipt
}

export const assertExactCheckReceipt = (receipt) => {
    if (receipt.status === 'ratchet_tightened') throw new ContractError('BASELINE_TIGHTENING_REQUIRED')
    return receipt
}

export const updateBaseline = ({ files, baseline, reason }) => {
    assertBaseline(baseline)
    assertFiles(files)
    if (reason === undefined) throw new ContractError('UPDATE_REASON_REQUIRED')
    if (!assertReason(reason, UPDATE_REASON_CODES)) throw new ContractError('UPDATE_REASON_INVALID')

    const baselineById = new Map(baseline.records.map((record) => [record.id, record]))
    const currentRecords = flattenRecords(files)
    const hasAddedDebt = currentRecords.some((record) => {
        const previous = baselineById.get(record.id)
        return !previous || record.occurrences > previous.occurrences
    })
    if (hasAddedDebt && reason.code === 'debt-reduction') throw new ContractError('UPDATE_REASON_INVALID')

    const records = currentRecords.map((record) => {
        const previous = baselineById.get(record.id)
        const reviewReason = !previous || record.occurrences > previous.occurrences ? reason : previous.reason
        return { ...record, reason: { ...reviewReason } }
    })
    return withDigest({ schemaVersion: 1, source: sourceContract(), records })
}

const parseCli = (args) => {
    const [mode, ...rest] = args
    if (!['check', 'init', 'update'].includes(mode)) throw new ContractError('CLI_USAGE_INVALID')
    const options = { mode, root: process.cwd(), baseline: path.join(contractDirectory, 'ui-copy-baseline.json') }
    for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index]
        const value = rest[index + 1]
        if (!['--root', '--baseline', '--reason', '--reference'].includes(flag) || !value || value.startsWith('--')) {
            throw new ContractError('CLI_USAGE_INVALID')
        }
        options[flag.slice(2)] = value
        index += 1
    }
    return options
}

const readBaseline = (filePath) => {
    if (!existsSync(filePath)) throw new ContractError('BASELINE_MISSING')
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
        throw new ContractError('BASELINE_INVALID_JSON')
    }
}

export const runCli = (args = process.argv.slice(2)) => {
    const options = parseCli(args)
    const { files } = scanUiTree(path.resolve(options.root))
    const baselinePath = path.resolve(options.baseline)
    let baseline

    if (options.mode === 'init') {
        if (existsSync(baselinePath)) throw new ContractError('BASELINE_ALREADY_EXISTS')
        baseline = buildBaseline({ files, reason: { code: options.reason, reference: options.reference } })
        writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    } else if (options.mode === 'update') {
        baseline = updateBaseline({
            files,
            baseline: readBaseline(baselinePath),
            reason: options.reason && options.reference ? { code: options.reason, reference: options.reference } : undefined
        })
        writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
    } else {
        baseline = readBaseline(baselinePath)
    }

    const receipt = evaluateBaseline({ files, baseline })
    if (options.mode === 'check') assertExactCheckReceipt(receipt)
    process.stdout.write(`${canonicalJson(receipt)}\n`)
    return receipt
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        runCli()
    } catch (error) {
        const reason = error instanceof ContractError ? error.code : 'UNEXPECTED_ERROR'
        process.stderr.write(`[ui-copy-baseline] status=failed reason=${reason}\n`)
        process.exitCode = 1
    }
}
