import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import { parseForESLint } from '@typescript-eslint/parser'
import { parse } from '@typescript-eslint/typescript-estree'

const toRelativePath = (absolutePath) => {
    const path = relative(__dirname, absolutePath).replaceAll('\\', '/')
    return path.startsWith('.') ? path : `./${path}`
}

const SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.ts', '.tsx'])
const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS)
const UI_SOURCE_DIRECTORY = resolve(__dirname, '..')
const UI_COMPONENT_DIRECTORY = resolve(UI_SOURCE_DIRECTORY, 'ui-component')
const VIEW_HEADER_BASENAME = resolve(UI_SOURCE_DIRECTORY, 'layout/MainLayout/ViewHeader')

const isWithinDirectory = (absolutePath, directory) => {
    const path = relative(directory, absolutePath)
    return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

const sourceFilesUnder = (relativeDirectory) => {
    const directory = resolve(__dirname, relativeDirectory)

    const walk = (currentDirectory) =>
        readdirSync(currentDirectory, { withFileTypes: true }).flatMap((entry) => {
            const absolutePath = resolve(currentDirectory, entry.name)
            if (entry.isDirectory()) return walk(absolutePath)
            return entry.isFile() && SOURCE_EXTENSION_SET.has(extname(entry.name)) ? [toRelativePath(absolutePath)] : []
        })

    return walk(directory).sort()
}

const getJsxRootName = (name) => {
    if (name?.type === 'JSXIdentifier') return name.name
    if (name?.type === 'JSXMemberExpression') return getJsxRootName(name.object)
    return undefined
}

const collectRenderedBindingNames = (ast) => {
    const renderedBindings = new Set()

    const visit = (node) => {
        if (!node || typeof node !== 'object') return

        if (node.type === 'JSXOpeningElement') {
            const name = getJsxRootName(node.name)
            if (name) renderedBindings.add(name)
        }

        if (
            node.type === 'CallExpression' &&
            node.callee?.type === 'Identifier' &&
            node.callee.name === 'styled' &&
            node.arguments[0]?.type === 'Identifier'
        ) {
            renderedBindings.add(node.arguments[0].name)
        }

        if (node.type === 'JSXAttribute' && /(?:^component$|Component$)/.test(node.name?.name ?? '')) {
            const expression = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : undefined
            if (expression?.type === 'Identifier') renderedBindings.add(expression.name)
        }

        Object.entries(node).forEach(([key, value]) => {
            if (key === 'parent' || key === 'loc' || key === 'range') return
            if (Array.isArray(value)) value.forEach(visit)
            else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value)
        })
    }

    visit(ast)
    return renderedBindings
}

const isSharedRenderingTarget = (absolutePath) =>
    isWithinDirectory(absolutePath, UI_COMPONENT_DIRECTORY) ||
    absolutePath === `${VIEW_HEADER_BASENAME}${extname(absolutePath)}` ||
    isWithinDirectory(absolutePath, VIEW_HEADER_BASENAME)

const resolveSourceImport = (importerRelativePath, specifier) => {
    const importerPath = resolve(__dirname, importerRelativePath)
    const unresolvedPath = specifier.startsWith('@/')
        ? resolve(UI_SOURCE_DIRECTORY, specifier.slice(2))
        : specifier.startsWith('.')
        ? resolve(dirname(importerPath), specifier)
        : undefined
    if (!unresolvedPath) return undefined

    const candidates = SOURCE_EXTENSION_SET.has(extname(unresolvedPath))
        ? [unresolvedPath]
        : [
              ...SOURCE_EXTENSIONS.map((extension) => `${unresolvedPath}${extension}`),
              ...SOURCE_EXTENSIONS.map((extension) => resolve(unresolvedPath, `index${extension}`))
          ]
    const resolvedPath = candidates.find((candidate) => existsSync(candidate))

    return resolvedPath && isSharedRenderingTarget(resolvedPath) ? toRelativePath(resolvedPath) : undefined
}

const withRenderedSharedClosure = (rootRelativePaths) => {
    const discoveredPaths = new Set(rootRelativePaths)
    const queue = [...rootRelativePaths]

    while (queue.length > 0) {
        const importerRelativePath = queue.shift()
        const ast = parse(readFileSync(resolve(__dirname, importerRelativePath), 'utf8'), { jsx: true, loc: true, sourceType: 'module' })
        const renderedBindings = collectRenderedBindingNames(ast)

        ast.body.forEach((node) => {
            if (node.type !== 'ImportDeclaration' || typeof node.source.value !== 'string') return
            if (!node.specifiers.some((specifier) => renderedBindings.has(specifier.local.name))) return

            const importedRelativePath = resolveSourceImport(importerRelativePath, node.source.value)
            if (!importedRelativePath || discoveredPaths.has(importedRelativePath)) return

            discoveredPaths.add(importedRelativePath)
            queue.push(importedRelativePath)
        })
    }

    return [...discoveredPaths].sort()
}

const REQUIRED_MODULES = Object.freeze({
    Chatflows: withRenderedSharedClosure([
        ...sourceFilesUnder('../views/chatflows'),
        ...sourceFilesUnder('../views/canvas'),
        ...sourceFilesUnder('../views/chatmessage')
    ]),
    Agentflows: withRenderedSharedClosure([...sourceFilesUnder('../views/agentflows'), ...sourceFilesUnder('../views/agentflowsv2')]),
    Executions: withRenderedSharedClosure(sourceFilesUnder('../views/agentexecutions')),
    Assistants: withRenderedSharedClosure(sourceFilesUnder('../views/assistants')),
    Marketplaces: withRenderedSharedClosure(sourceFilesUnder('../views/marketplaces')),
    'Tools/MCP': withRenderedSharedClosure(sourceFilesUnder('../views/tools')),
    'Document Stores': withRenderedSharedClosure([...sourceFilesUnder('../views/docstore'), '../views/vectorstore/UpsertResultDialog.jsx']),
    Credentials: withRenderedSharedClosure([...sourceFilesUnder('../views/credentials'), '../views/canvas/CredentialInputHandler.jsx']),
    Variables: withRenderedSharedClosure(sourceFilesUnder('../views/variables')),
    'API Keys': withRenderedSharedClosure(sourceFilesUnder('../views/apikey'))
})

const ADDITIONAL_SURFACES = Object.freeze({
    'Shared authenticated shell': withRenderedSharedClosure([
        ...sourceFilesUnder('../layout/MainLayout'),
        ...sourceFilesUnder('../menu-items')
    ]),
    'Execution shared UI': withRenderedSharedClosure(['../ui-component/table/ExecutionsListTable.jsx']),
    'Shared file picker': withRenderedSharedClosure(['../ui-component/file/File.jsx']),
    'Datasets (feature-gated)': withRenderedSharedClosure(sourceFilesUnder('../views/datasets'))
})

const CRITICAL_COPY_CONTRACTS = Object.freeze([
    ['Chatflows', '../views/chatflows/index.jsx', ['新增流程', '构建单智能体系统、聊天机器人和基础大模型流程']],
    ['Agentflows', '../views/agentflows/index.jsx', ['智能体流程', '新功能']],
    ['Executions', '../views/agentexecutions/ShareExecutionDialog.jsx', ['公开执行追踪链接', '取消公开分享']],
    ['Assistants', '../views/assistants/custom/CustomAssistantLayout.jsx', ['新建自定义助手', '暂未添加自定义助手']],
    ['Marketplaces', '../views/marketplaces/MarketplaceCanvasHeader.jsx', ['使用模板']],
    ['Tools/MCP', '../views/tools/CustomMcpServerDialog.jsx', ['服务器声明此工具为只读', '风险未知']],
    ['Document Stores', '../views/docstore/ShowStoredChunks.jsx', ['删除分块', '此操作无法撤销']],
    ['Credentials', '../views/credentials/index.jsx', ['添加凭据', '删除凭据']],
    ['Variables', '../views/variables/index.jsx', ['添加变量', '删除变量']],
    ['API Keys', '../views/apikey/index.jsx', ['创建密钥', '删除 API 密钥']],
    ['Shared authenticated shell', '../layout/MainLayout/Header/ProfileSection/index.jsx', ['账户设置', '退出']],
    ['Execution shared UI', '../ui-component/table/ExecutionsListTable.jsx', ['执行记录表', '选择全部执行记录']],
    ['Shared file picker', '../ui-component/file/File.jsx', ['选择要上传的文件', '上传文件']],
    ['Datasets (feature-gated)', '../views/datasets/index.jsx', ['新增数据集', '删除数据集']]
])

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

// G1 permits product names, protocols, formats and developer-facing acronyms. Generic
// interface words such as Save, Settings, Search, Delete, Key and Description are
// deliberately absent: when shown to a Chinese user, those words must be localized.
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

// These literals are rendered intentionally as code examples in the Tools and
// Variables help dialogs. They are identifiers, not interface prose.
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

// Exact display literals that are product/model identifiers or input-format
// contracts. Keep this list exact so generic English interface copy cannot be
// hidden behind a broad technical-term exception.
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

const readSource = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

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

const isAssetIdentifier = (kind, literal) =>
    kind === 'attribute:alt' && !literal.includes(' ') && (/[A-Z][A-Za-z0-9]*SVG$/.test(literal) || /(?:SVG|GIF|PNG|JPE?G)$/i.test(literal))

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

const getCalleeName = (callee) => {
    if (callee?.type === 'Identifier') return callee.name
    if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name
    return undefined
}

const isDisplayCopyCall = (node) => {
    const name = getCalleeName(node.callee)
    return name === 'getErrorMsg' || /^(?:get|format).*ErrorMessage$/i.test(name ?? '')
}

const DISPLAY_CALL_SINKS = new Set(['confirm', 'enqueueSnackbar', 'errorFailed', 'showSnackbar'])

const unwrapStaticExpression = (node) => {
    let expression = node
    while (expression && ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(expression.type)) {
        expression = expression.expression
    }
    return expression
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
            if (typeof node.value === 'string') record(node.value, node)
            return
        case 'Identifier': {
            const binding = staticBindings.get(node)
            if (!binding || visitedBindings.has(binding)) return

            const nextVisitedBindings = new Set(visitedBindings)
            nextVisitedBindings.add(binding)
            collectStaticCopy(binding, record, staticBindings, nextVisitedBindings)
            return
        }
        case 'MemberExpression':
            resolveStaticMemberValues(node, staticBindings, visitedBindings).forEach((value) =>
                collectStaticCopy(value, record, staticBindings, visitedBindings)
            )
            return
        case 'TemplateLiteral':
            node.quasis.forEach((quasi) => record(quasi.value.cooked ?? quasi.value.raw, quasi))
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

const extractDisplayLiterals = (source) => {
    const findings = []
    const findingKeys = new Set()
    const { ast, scopeManager } = parseForESLint(source, {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        loc: true,
        range: true,
        sourceType: 'module'
    })
    const staticBindings = collectStaticBindings(scopeManager)

    const record = (kind, literal, node) => {
        if (typeof literal !== 'string') return
        const normalized = normalizeLiteral(literal)
        if (!normalized) return

        const line = node.loc?.start.line ?? 1
        const key = `${line}\0${kind}\0${normalized}`
        if (findingKeys.has(key)) return
        findingKeys.add(key)
        findings.push({ line, kind, literal: normalized })
    }

    const visit = (node, parent) => {
        if (!node || typeof node !== 'object') return

        if (node.type === 'JSXText') record('jsx-text', node.value, node)

        if (node.type === 'CallExpression') {
            const calleeName = getCalleeName(node.callee)
            if (calleeName && DISPLAY_CALL_SINKS.has(calleeName) && node.arguments[0]) {
                collectStaticCopy(
                    node.arguments[0],
                    (literal, literalNode) => record(`call:${calleeName}`, literal, literalNode),
                    staticBindings
                )
            }
        }

        if (node.type === 'JSXAttribute') {
            const name = getJsxAttributeName(node)
            if (name && DISPLAY_PROPERTIES.has(name)) {
                if (node.value?.type === 'Literal') record(`attribute:${name}`, node.value.value, node.value)
                if (node.value?.type === 'JSXExpressionContainer') {
                    collectStaticCopy(
                        node.value.expression,
                        (literal, literalNode) => record(`attribute:${name}`, literal, literalNode),
                        staticBindings
                    )
                }
            }
        }

        if (node.type === 'Property') {
            const name = getPropertyName(node)
            if (name && DISPLAY_PROPERTIES.has(name)) {
                collectStaticCopy(node.value, (literal, literalNode) => record(`property:${name}`, literal, literalNode), staticBindings)
            }
        }

        if (node.type === 'JSXExpressionContainer' && (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment')) {
            collectStaticCopy(node.expression, (literal, literalNode) => record('jsx-expression', literal, literalNode), staticBindings)
        }

        Object.entries(node).forEach(([key, value]) => {
            if (key === 'comments' || key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens') return
            if (Array.isArray(value)) value.forEach((child) => visit(child, node))
            else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node)
        })
    }

    visit(ast)
    return findings.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind))
}

const extractDisplayCopy = (source) =>
    extractDisplayLiterals(source).filter(({ kind, literal }) => !isAssetIdentifier(kind, literal) && containsUnapprovedEnglish(literal))

const scanModule = (moduleName, relativePaths) =>
    relativePaths.flatMap((relativePath) =>
        extractDisplayCopy(readSource(relativePath)).map((finding) => ({ moduleName, relativePath, ...finding }))
    )

const formatFindings = (moduleName, findings) =>
    [
        `G1 中文文案门禁：${moduleName} 仍有 ${findings.length} 条未白名单化英文用户文案。`,
        ...findings.map(({ relativePath, line, kind, literal }) => `- ${relativePath}:${line} [${kind}] ${JSON.stringify(literal)}`)
    ].join('\n')

describe('G1 Chinese copy extraction boundary', () => {
    it('flags visible copy while ignoring identifiers, routes, permissions and approved technical terms', () => {
        const fixture = `
            const Component = () => (
                <RequireAuth permissionId='credentials:create' to='/credentials'>
                    <Typography title='MCP API URL'>MCP API URL</Typography>
                    <img alt='WorkflowEmptySVG' src='/empty.svg' />
                    <Button aria-label='Save credential'>Save</Button>
                </RequireAuth>
            )
        `

        expect(extractDisplayCopy(fixture).map(({ kind, literal }) => ({ kind, literal }))).toEqual([
            { kind: 'attribute:aria-label', literal: 'Save credential' },
            { kind: 'jsx-text', literal: 'Save' }
        ])
    })

    it('flags multiline JSX and conditional expression copy', () => {
        const fixture = `
            const Component = () => (
                <>
                    <DialogTitle>
                        Public Trace Link
                    </DialogTitle>
                    <Tooltip title={copied ? 'Copied!' : 'Copy link'} />
                </>
            )
        `

        expect(extractDisplayCopy(fixture).map(({ kind, literal }) => ({ kind, literal }))).toEqual([
            { kind: 'jsx-text', literal: 'Public Trace Link' },
            { kind: 'attribute:title', literal: 'Copied!' },
            { kind: 'attribute:title', literal: 'Copy link' }
        ])
    })

    it('does not treat arbitrary uppercase interface words as code identifiers', () => {
        expect(extractDisplayCopy("<Chip label='NEW' />")).toEqual([{ line: 1, kind: 'attribute:label', literal: 'NEW' }])
    })

    it('does not hide hyphenated accessibility copy behind the asset exemption', () => {
        expect(extractDisplayCopy("<img alt='delete-item' />")).toEqual([{ line: 1, kind: 'attribute:alt', literal: 'delete-item' }])
    })

    it('flags static display copy referenced through a local identifier', () => {
        const fixture = "const copy = 'Save changes'; const Component = () => <Button aria-label={copy}>{copy}</Button>"

        expect(extractDisplayCopy(fixture).map(({ kind, literal }) => ({ kind, literal }))).toEqual([
            { kind: 'attribute:aria-label', literal: 'Save changes' },
            { kind: 'jsx-expression', literal: 'Save changes' }
        ])
    })

    it('does not resolve a shadowed display identifier to an unrelated outer binding', () => {
        const fixture = "const copy = 'Save changes'; const Component = (copy) => <Button>{copy}</Button>"

        expect(extractDisplayCopy(fixture)).toEqual([])
    })

    it('resolves same-named static copy inside independent lexical scopes', () => {
        const fixture = `
            const SaveButton = () => { const copy = 'Save changes'; return <Button>{copy}</Button> }
            const DeleteButton = () => { const copy = 'Delete item'; return <Button>{copy}</Button> }
        `

        expect(extractDisplayCopy(fixture).map((finding) => finding.literal)).toEqual(['Save changes', 'Delete item'])
    })

    it.each([
        ["const COPY = { save: 'Save changes' }; const Component = () => <Button>{COPY.save}</Button>", 'jsx-expression'],
        ["const COPY = { save: 'Save changes' }; const Component = () => <Button aria-label={COPY.save} />", 'attribute:aria-label']
    ])('flags static object member copy in a %s sink', (fixture, kind) => {
        expect(extractDisplayCopy(fixture).map((finding) => ({ kind: finding.kind, literal: finding.literal }))).toEqual([
            { kind, literal: 'Save changes' }
        ])
    })

    it('flags fallback copy passed to a display call expression', () => {
        const fixture = "const Component = () => <Snackbar message={getErrorMessage(error, 'Save failed')} />"

        expect(extractDisplayCopy(fixture).map(({ kind, literal }) => ({ kind, literal }))).toEqual([
            { kind: 'attribute:message', literal: 'Save failed' }
        ])
    })

    it.each(['enqueueSnackbar', 'showSnackbar', 'errorFailed'])('flags direct user notification copy passed to %s', (callee) => {
        expect(extractDisplayCopy(`${callee}('Save failed')`).map((finding) => finding.literal)).toEqual(['Save failed'])
    })

    it.each([
        ['/settings Save failed', 'path-prefixed prose'],
        ['https://example.test Save failed', 'URL-prefixed prose']
    ])('flags %s as %s instead of exempting the whole sentence', (literal) => {
        expect(extractDisplayCopy(`<Alert>${literal}</Alert>`).map((finding) => finding.literal)).toEqual([literal])
    })

    it('ignores developer code examples without hiding prose that starts like a path', () => {
        const fixture = `<CodeEditor placeholder={'// Read input const value = $flow.input; return value;'} />`

        expect(extractDisplayCopy(fixture)).toEqual([])
    })

    it.each(['string', 'array', 'default', 'llama2'])('ignores the exact developer/model literal %s', (literal) => {
        expect(extractDisplayCopy(`<TableCell>${literal}</TableCell>`)).toEqual([])
    })

    it.each([
        'Lunary',
        'Arize',
        'Phoenix',
        'Anthropic Claude',
        'Google Gemini',
        'Groq',
        'Mistral AI',
        'Azure Cognitive Services',
        'Groq Whisper',
        'Eleven Labs TTS'
    ])('allows the product or model proper name %s', (literal) => {
        expect(extractDisplayCopy(`<MenuItem>${literal}</MenuItem>`)).toEqual([])
    })

    it.each(['Content-Type', 'POST'])('ignores the exact HTTP code token %s', (literal) => {
        expect(extractDisplayCopy(`<code>${literal}</code>`)).toEqual([])
    })

    it('ignores the UI technical acronym without allowing generic interface words', () => {
        expect(extractDisplayCopy('<Chip label="UI" />')).toEqual([])
    })

    it('allows only exact technical display literals without weakening generic copy checks', () => {
        for (const literal of EXACT_TECHNICAL_LITERAL_ALLOWLIST) {
            expect(extractDisplayCopy(`<Chip label="${literal}" />`)).toEqual([])
        }
        expect(extractDisplayCopy('<Button>Save</Button>')).toEqual([{ line: 1, kind: 'jsx-text', literal: 'Save' }])
    })

    it('ignores embedded code placeholders and HTML attributes inside Chinese help copy', () => {
        const fixture =
            '<Tooltip title=\'属性为 <code>userid</code> 时使用 <code>$userid</code>。按照<a target="_blank" href="https://example.test">指南</a>传入 {input}。\' />'

        expect(extractDisplayCopy(fixture)).toEqual([])
    })

    it('flags DataGrid headerName copy as a display property', () => {
        const fixture = "const columns = [{ field: 'workspace', headerName: 'Workspace Name' }]"

        expect(extractDisplayCopy(fixture)).toEqual([{ line: 1, kind: 'property:headerName', literal: 'Workspace Name' }])
    })

    it('extracts semantic copy only from AST display sinks', () => {
        const fixture = `
            // 新增流程
            const deadCopy = '新增流程'
            const Component = () => <Button>创建流程</Button>
        `

        expect(extractDisplayLiterals(fixture).map((finding) => finding.literal)).toEqual(['创建流程'])
    })

    it('keeps directly rendered shared components inside the explicit scan manifest', () => {
        expect(ADDITIONAL_SURFACES['Execution shared UI']).toContain('../ui-component/table/ExecutionsListTable.jsx')
        expect(ADDITIONAL_SURFACES['Shared file picker']).toContain('../ui-component/file/File.jsx')
        expect(REQUIRED_MODULES.Chatflows).toEqual(
            expect.arrayContaining([
                '../views/canvas/index.jsx',
                '../views/canvas/NodeInputHandler.jsx',
                '../views/chatmessage/ChatMessage.jsx',
                '../views/chatmessage/ChatPopUp.jsx'
            ])
        )
        expect(REQUIRED_MODULES.Agentflows).toContain('../views/agentflowsv2/AgentFlowNode.jsx')
        expect(REQUIRED_MODULES.Credentials).toContain('../views/canvas/CredentialInputHandler.jsx')
        expect(REQUIRED_MODULES['Document Stores']).toContain('../views/vectorstore/UpsertResultDialog.jsx')
    })

    it('includes every MainLayout source file in the authenticated shell surface', () => {
        expect(ADDITIONAL_SURFACES['Shared authenticated shell']).toEqual(expect.arrayContaining(sourceFilesUnder('../layout/MainLayout')))
    })

    it('includes menu item title sources in the authenticated shell surface', () => {
        expect(ADDITIONAL_SURFACES['Shared authenticated shell']).toEqual(expect.arrayContaining(sourceFilesUnder('../menu-items')))
    })

    it('enumerates JavaScript and TypeScript source extensions under module roots', () => {
        expect(REQUIRED_MODULES.Assistants).toContain('../views/assistants/custom/toolAgentFlow.js')
    })

    it('recursively includes rendered shared UI dependencies', () => {
        expect(REQUIRED_MODULES.Chatflows).toEqual(
            expect.arrayContaining([
                '../layout/MainLayout/ViewHeader.jsx',
                '../ui-component/cards/ItemCard.jsx',
                '../ui-component/extended/ScheduleStatusBadge.jsx'
            ])
        )
    })
})

describe('G1 semantic contract coverage', () => {
    it('covers every required module and additional surface', () => {
        const coveredModules = new Set(CRITICAL_COPY_CONTRACTS.map(([moduleName]) => moduleName))
        const expectedModules = [...Object.keys(REQUIRED_MODULES), ...Object.keys(ADDITIONAL_SURFACES)]

        expect([...coveredModules].sort()).toEqual(expectedModules.sort())
    })
})

describe.each(CRITICAL_COPY_CONTRACTS)('G1 semantic copy contract: %s', (moduleName, relativePath, requiredCopy) => {
    it.each(requiredCopy)('renders the approved critical Chinese copy %s through a display sink', (copy) => {
        const displayedCopy = extractDisplayLiterals(readSource(relativePath)).map((finding) => finding.literal)

        expect(displayedCopy.some((literal) => literal.includes(copy))).toBe(true)
    })
})

describe.each(Object.entries(REQUIRED_MODULES))('G1 Chinese copy gate: %s', (moduleName, relativePaths) => {
    it('contains no unapproved English user-facing copy', () => {
        const findings = scanModule(moduleName, relativePaths)
        if (findings.length > 0) throw new Error(formatFindings(moduleName, findings))
    })
})

describe.each(Object.entries(ADDITIONAL_SURFACES))('G1 Chinese copy gate (additional): %s', (moduleName, relativePaths) => {
    it('contains no unapproved English user-facing copy', () => {
        const findings = scanModule(moduleName, relativePaths)
        if (findings.length > 0) throw new Error(formatFindings(moduleName, findings))
    })
})
