import { BaseToolkit, tool, Tool } from '@langchain/core/tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequest, CallToolResultSchema, ListToolsResult, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Readable } from 'stream'
import { RequestInit as NodeFetchRequestInit, Response as NodeFetchResponse } from 'node-fetch'
import { createFixedOriginPolicy, secureFetch } from '../../../src/httpSecurity'

const MCP_TRANSPORT_REQUEST_FAILED = 'MCP transport request failed.'
const MCP_TRANSPORT_CONNECTION_FAILED = 'MCP transport connection failed.'
const MCP_INITIALIZATION_FAILED = 'MCP initialization failed.'
const MCP_TOOL_REQUEST_FAILED = 'MCP tool request failed.'
const EMPTY_RESPONSE_BODY_STATUSES = new Set([204, 205, 304])
const MAX_MCP_REQUEST_HEADERS = 64
const MAX_MCP_HEADER_NAME_BYTES = 128
const MAX_MCP_HEADER_VALUE_BYTES = 8 * 1024
const MAX_MCP_HEADER_BYTES = 32 * 1024
const MCP_FORBIDDEN_REQUEST_HEADERS = new Set([
    'connection',
    'content-length',
    'expect',
    'forwarded',
    'host',
    'http2-settings',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto'
])

const disposeMcpRawBody = (rawBody: unknown): void => {
    if (!rawBody || typeof rawBody !== 'object') return
    const body = rawBody as { destroy?: () => void; cancel?: () => Promise<unknown> | unknown }
    if (typeof body.destroy === 'function') {
        try {
            body.destroy()
            return
        } catch {
            // Fall through to a web-stream cancellation attempt when present.
        }
    }
    if (typeof body.cancel === 'function') {
        try {
            Promise.resolve(body.cancel()).catch(() => undefined)
        } catch {
            // Empty-status cleanup must not expose transport data.
        }
    }
}

const normalizeMcpRequestHeaders = (staticHeaders: unknown, injectedHeaders: unknown): Record<string, string> | undefined => {
    const normalized = new Map<string, { name: string; value: string }>()
    let entryCount = 0
    let totalBytes = 0

    for (const source of [staticHeaders, injectedHeaders]) {
        if (source === undefined || source === null) continue
        const entries =
            source instanceof globalThis.Headers
                ? Array.from(source.entries())
                : typeof source === 'object' && !Array.isArray(source)
                ? Object.entries(source as Record<string, unknown>)
                : undefined
        if (!entries) throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)

        for (const [name, value] of entries) {
            entryCount += 1
            if (
                entryCount > MAX_MCP_REQUEST_HEADERS ||
                !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
                typeof value !== 'string' ||
                /[\u0000\r\n]/.test(value)
            ) {
                throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
            }

            const lowerName = name.toLowerCase()
            if (MCP_FORBIDDEN_REQUEST_HEADERS.has(lowerName)) throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)

            const nameBytes = Buffer.byteLength(name)
            const valueBytes = Buffer.byteLength(value)
            totalBytes += nameBytes + valueBytes
            if (nameBytes > MAX_MCP_HEADER_NAME_BYTES || valueBytes > MAX_MCP_HEADER_VALUE_BYTES || totalBytes > MAX_MCP_HEADER_BYTES) {
                throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
            }

            const existing = normalized.get(lowerName)
            normalized.set(lowerName, { name: existing?.name ?? name, value })
        }
    }

    if (normalized.size === 0) return undefined
    const headers: Record<string, string> = Object.create(null)
    for (const { name, value } of normalized.values()) headers[name] = value
    return headers
}

const createSdkClient = (): Client =>
    new Client(
        {
            name: 'flowise-client',
            version: '1.0.0'
        },
        {
            capabilities: {}
        }
    )

const closeSdkClient = async (client: Client): Promise<void> => {
    try {
        await client.close()
    } catch {
        // Best-effort cleanup only.
    }
}

/**
 * Converts node-fetch's pinned-agent response into the web Response expected by
 * the MCP SDK without copying or buffering streaming SSE bodies.
 */
const toSdkResponse = (response: NodeFetchResponse): globalThis.Response => {
    // Native web Responses reject informational statuses. Treat them as a
    // fixed transport failure instead of depending on a runtime RangeError.
    if (response.status < 200 || response.status > 599) throw new Error(MCP_TRANSPORT_REQUEST_FAILED)

    const headers = new globalThis.Headers()
    response.headers.forEach((value, name) => headers.append(name, value))
    const rawBody = response.body as unknown
    const isEmptyResponse = EMPTY_RESPONSE_BODY_STATUSES.has(response.status)
    if (isEmptyResponse) disposeMcpRawBody(rawBody)
    const body = isEmptyResponse
        ? null
        : rawBody instanceof Readable
        ? (Readable.toWeb(rawBody) as ReadableStream<Uint8Array>)
        : (rawBody as BodyInit | null)

    return new globalThis.Response(body, {
        status: response.status,
        // Do not propagate a remote-controlled status text into SDK errors.
        statusText: '',
        headers
    })
}

/**
 * Gives every MCP SDK HTTP operation the same pinned, redirect-aware transport.
 * The policy keeps authorization headers and endpoint tokens on the initially
 * configured origin and forces the default private/special-address deny list.
 */
const createMcpTransportFetch = (baseUrl: URL): FetchLike => {
    const policy = createFixedOriginPolicy(baseUrl.origin)

    return async (url, init) => {
        try {
            const response = await secureFetch(url.toString(), init as NodeFetchRequestInit, 5, undefined, policy)
            return toSdkResponse(response)
        } catch {
            throw new Error(MCP_TRANSPORT_REQUEST_FAILED)
        }
    }
}

export class MCPToolkit extends BaseToolkit {
    tools: Tool[] = []
    _tools: ListToolsResult | null = null
    model_config: any
    transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null
    client: Client | null = null
    serverParams: StdioServerParameters | any
    transportType: 'stdio' | 'sse' | 'http'
    /** Per-invocation HTTP headers injected at tools/call time; overrides static toolkit headers for the same names. */
    getToolCallHeaders?: () => Promise<Record<string, string>>
    constructor(serverParams: StdioServerParameters | any, transportType: 'stdio' | 'sse' | 'http') {
        super()
        this.serverParams = serverParams
        this.transportType = transportType
    }

    /**
     * Creates a new MCP client and connects it via the configured transport.
     * @param injectHeaders - Additional HTTP headers merged over static `serverParams.headers` for this connection. Used to pass per-invocation headers (e.g. from {@link getToolCallHeaders}) into SSE/HTTP transports.
     */
    async createClient(injectHeaders: Record<string, string> = {}): Promise<Client> {
        let client = createSdkClient()

        let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

        if (this.transportType === 'stdio') {
            // Compatible with overridden PATH configuration
            const params = {
                ...this.serverParams,
                env: {
                    ...(this.serverParams.env || {}),
                    PATH: process.env.PATH
                }
            }

            try {
                transport = new StdioClientTransport(params as StdioServerParameters)
                await client.connect(transport)
            } catch {
                await closeSdkClient(client)
                throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
            }
        } else {
            if (this.serverParams.url === undefined) {
                throw new Error('URL is required for SSE transport')
            }

            let baseUrl: URL
            try {
                baseUrl = new URL(this.serverParams.url)
                if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
                    throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
                }
            } catch {
                throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
            }
            const transportFetch = createMcpTransportFetch(baseUrl)
            let headers: Record<string, string> | undefined
            try {
                headers = normalizeMcpRequestHeaders(this.serverParams?.headers, injectHeaders)
            } catch {
                await closeSdkClient(client)
                throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
            }
            try {
                transport = new StreamableHTTPClientTransport(baseUrl, {
                    ...(headers ? { requestInit: { headers } } : {}),
                    fetch: transportFetch
                })
                await client.connect(transport)
            } catch {
                console.error('[MCPToolkit] Streamable HTTP transport unavailable; trying SSE fallback.')
                await closeSdkClient(client)
                client = createSdkClient()
                try {
                    transport = new SSEClientTransport(baseUrl, {
                        ...(headers ? { requestInit: { headers } } : {}),
                        fetch: transportFetch
                    })
                    await client.connect(transport)
                } catch {
                    await closeSdkClient(client)
                    throw new Error(MCP_TRANSPORT_CONNECTION_FAILED)
                }
            }
        }

        return client
    }

    async initialize() {
        if (this._tools === null) {
            try {
                this.client = await this.createClient()
                this._tools = await this.client.request({ method: 'tools/list' }, ListToolsResultSchema)
                this.tools = await this.get_tools()
            } catch {
                throw new Error(MCP_INITIALIZATION_FAILED)
            } finally {
                // Close the initial client after initialization without exposing cleanup details.
                if (this.client) await closeSdkClient(this.client)
            }
        }
    }

    async get_tools(): Promise<Tool[]> {
        if (this._tools === null || this.client === null) {
            throw new Error('Must initialize the toolkit first')
        }
        const toolsPromises = this._tools.tools.map(async (tool: any) => {
            if (this.client === null) {
                throw new Error('Client is not initialized')
            }
            const argsSchema = tool.inputSchema ?? { type: 'object', properties: {} }
            return await MCPTool({
                toolkit: this,
                name: tool.name,
                description: tool.description || tool.name,
                argsSchema
            })
        })
        const res = await Promise.allSettled(toolsPromises)
        const errors = res.filter((r) => r.status === 'rejected')
        if (errors.length !== 0) {
            console.error('[MCPToolkit] Some MCP tools could not be resolved.')
        }
        const successes = res.filter((r) => r.status === 'fulfilled').map((r) => r.value)
        return successes
    }
}

export async function MCPTool({
    toolkit,
    name,
    description,
    argsSchema
}: {
    toolkit: MCPToolkit
    name: string
    description: string
    argsSchema: any
}): Promise<Tool> {
    return tool(
        async (input): Promise<string> => {
            let client: Client | undefined

            try {
                // Create a new client for this request.
                const toolCallHeaders = await toolkit.getToolCallHeaders?.()
                client = await toolkit.createClient(toolCallHeaders)
                const req: CallToolRequest = { method: 'tools/call', params: { name: name, arguments: input as any } }
                const res = await client.request(req, CallToolResultSchema)
                const content = res.content
                const contentString = JSON.stringify(content)
                return contentString
            } catch {
                throw new Error(MCP_TOOL_REQUEST_FAILED)
            } finally {
                // Always close the client after the request completes without exposing cleanup details.
                if (client) await closeSdkClient(client)
            }
        },
        {
            name: name,
            description: description,
            schema: argsSchema
        }
    )
}

export const validateArgsForLocalFileAccess = (args: string[]): void => {
    const dangerousPatterns = [
        // Absolute paths
        /^\//, // Unix absolute paths starting with /
        /^[a-zA-Z]:\\/, // Windows absolute paths like C:\

        // Relative paths that could escape current directory
        /\.\.\//, // Parent directory traversal with ../
        /\.\.\\/, // Parent directory traversal with ..\
        /^\.\./, // Starting with ..

        // Local file access patterns
        /^\.\//, // Current directory with ./
        /^~\//, // Home directory with ~/
        /^file:\/\//, // File protocol

        // Common file extensions that shouldn't be accessed
        /\.(exe|bat|cmd|sh|ps1|vbs|scr|com|pif|dll|sys)$/i,

        // File flags and options that could access local files
        /^--?(?:file|input|output|config|load|save|import|export|read|write)=/i,
        /^--?(?:file|input|output|config|load|save|import|export|read|write)$/i
    ]

    for (const arg of args) {
        if (typeof arg !== 'string') continue

        // Check for dangerous patterns
        for (const pattern of dangerousPatterns) {
            if (pattern.test(arg)) {
                throw new Error(`Argument contains potential local file access: "${arg}"`)
            }
        }

        // Check for null bytes
        if (arg.includes('\0')) {
            throw new Error(`Argument contains null byte: "${arg}"`)
        }

        // Check for very long paths that might be used for buffer overflow attacks
        if (arg.length > 1000) {
            throw new Error(`Argument is suspiciously long (${arg.length} characters): "${arg.substring(0, 100)}..."`)
        }
    }
}

export const validateCommandInjection = (args: string[]): void => {
    const dangerousPatterns = [
        // Shell metacharacters
        /[;&|`$(){}[\]<>]/,
        // Command chaining
        /&&|\|\||;;/,
        // Redirections
        />>|<<|>/,
        // Backticks and command substitution
        /`|\$\(/,
        // Process substitution
        /<\(|>\(/
    ]

    for (const arg of args) {
        if (typeof arg !== 'string') continue

        for (const pattern of dangerousPatterns) {
            if (pattern.test(arg)) {
                throw new Error(`Argument contains potentially dangerous characters: "${arg}"`)
            }
        }
    }
}

/**
 * Validates user-supplied env vars against the operator-controlled allow-list in
 * `CUSTOM_MCP_ALLOWED_ENV_VARS` (comma-separated names). Empty = none allowed.
 */
export const validateEnvironmentVariables = (env: Record<string, any>): void => {
    const allowedEnvVars = new Set(
        (process.env.CUSTOM_MCP_ALLOWED_ENV_VARS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    )

    for (const [key, value] of Object.entries(env)) {
        if (!allowedEnvVars.has(key)) {
            throw new Error(`Environment variable '${key}' is not allowed. Permitted: ${[...allowedEnvVars].join(', ') || '(none)'}`)
        }

        if (typeof value === 'string' && value.includes('\0')) {
            throw new Error(`Environment variable '${key}' contains null byte`)
        }
    }
}

/**
 * Validates that command arguments don't contain flags that enable arbitrary code execution
 * This prevents attacks where whitelisted commands are used with dangerous flags
 * (e.g., "npx -c malicious-command" or "python -c malicious-code")
 * @param command The command to validate
 * @param args The arguments to validate
 */
export const validateCommandFlags = (command: string, args: string[]): void => {
    // Define dangerous flags for each command that enable code execution
    const dangerousFlagsByCommand: Record<string, string[]> = {
        npx: [
            '-c', // Execute shell commands
            '--call', // Execute shell commands
            '--shell-auto-fallback', // Shell execution fallback
            '-y', // Auto-confirms installation prompts
            '--yes', // Auto-confirms installation prompts
            '--node-options' // Passes arbitrary Node flags to underlying process, bypassing node flag blocklist
        ],
        node: [
            '-e', // Execute JavaScript code
            '--eval', // Execute JavaScript code
            '-p', // Evaluate and print JavaScript code
            '--print', // Evaluate and print JavaScript code
            '--inspect', // Enable remote debugging (security risk)
            '--inspect-brk', // Enable remote debugging with breakpoint (security risk)
            '--experimental-policy', // Could load malicious policies
            '-r', // Short alias for --require
            '--require', // Preload a CommonJS module before script runs
            '--loader', // Custom ES module loader hook (code execution)
            '--experimental-loader', // Same as --loader, older Node alias
            '--import', // Preload ESM module before entry script (Node 18+)
            '--env-file' // Read env vars from a local file (Node 20+, local file access)
        ],
        python: [
            '-c', // Execute Python code
            '-m' // Run library modules (could run malicious modules)
        ],
        python3: [
            '-c', // Execute Python code
            '-m' // Run library modules (could run malicious modules)
        ],
        docker: [
            'run', // Run containers (too powerful)
            'build', // Pulls a container and executes the run instructions
            'exec', // Execute in containers
            'compose', // Subcommand that starts containers (same risk as run)
            '-v', // Mount host filesystems
            '--volume', // Mount host filesystems
            '--mount', // Alternative to -v/--volume for mounting host paths
            '--volumes-from', // Mount volumes from another container (filesystem access)
            '--privileged', // Privileged mode
            '--cap-add', // Add capabilities
            '--security-opt', // Modify security options
            '--device', // Add host device files to container (privilege escalation)
            '--entrypoint', // Override container entrypoint (arbitrary code execution)
            '--network', // Host network access (catches --network=host and --network host)
            '--pid', // Host PID namespace (catches --pid=host and --pid host)
            '--ipc', // Host IPC namespace (catches --ipc=host and --ipc host)
            '--env-file' // Read env vars from a local host file (local file access)
        ]
    }

    const dangerousFlags = dangerousFlagsByCommand[command] || []

    // Collect single-char dangerous flags (e.g. '-c' -> 'c') for combined flag detection
    const dangerousShortChars = new Set(dangerousFlags.filter((f) => /^-[a-zA-Z]$/.test(f)).map((f) => f[1].toLowerCase()))

    for (const arg of args) {
        if (typeof arg !== 'string') continue

        const normalizedArg = arg.toLowerCase().trim()

        // Check for dangerous flags in various forms (exact, =value, space-separated value)
        for (const flag of dangerousFlags) {
            const lowerCaseFlag = flag.toLowerCase()
            if (normalizedArg === lowerCaseFlag) {
                throw new Error(`Argument '${arg}' is not allowed for command '${command}'.`)
            }
            if (normalizedArg.startsWith(lowerCaseFlag + '=')) {
                throw new Error(`Argument '${arg}' contains flag '${flag}' that is not allowed for command '${command}'.`)
            }
            if (flag.startsWith('-') && normalizedArg.startsWith(lowerCaseFlag + ' ')) {
                throw new Error(`Argument '${arg}' contains flag '${flag}' that is not allowed for command '${command}'.`)
            }
        }

        // Check for combined short flags (e.g. "-yc" = "-y" + "-c")
        // A combined flag starts with a single '-', is not a long flag '--', and has multiple characters after '-'
        if (/^-[a-zA-Z]{2,}/.test(normalizedArg)) {
            const flagChars = normalizedArg.slice(1) // strip leading '-'
            for (const ch of flagChars) {
                if (dangerousShortChars.has(ch)) {
                    throw new Error(`Argument '${arg}' contains dangerous flag '-${ch}' for command '${command}'.`)
                }
            }
        }
    }
}

/**
 * Validates a user-supplied MCP server configuration against operator-controlled allow-lists.
 *
 * For stdio configs, the command must appear in the `CUSTOM_MCP_ALLOWED_COMMANDS` allow-list
 * (comma-separated, empty = none allowed). The list is empty by default, so no command can run
 * until an operator explicitly opts in. To enable local/custom stdio MCP servers, set
 * `CUSTOM_MCP_PROTOCOL=stdio` and `CUSTOM_MCP_ALLOWED_COMMANDS` in your env file
 * (see docker/.env.example, docker/worker/.env.example, packages/server/.env.example).
 */
export const validateMCPServerConfig = (serverParams: any): void => {
    // Validate the entire server configuration
    if (!serverParams || typeof serverParams !== 'object') {
        throw new Error('Invalid server configuration')
    }

    // Command allowlist - operator-controlled via CUSTOM_MCP_ALLOWED_COMMANDS (empty = none allowed)
    const allowedCommands = (process.env.CUSTOM_MCP_ALLOWED_COMMANDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    if (serverParams.command && !allowedCommands.includes(serverParams.command)) {
        throw new Error(`Command '${serverParams.command}' is not allowed. Permitted: ${allowedCommands.join(', ') || '(none)'}`)
    }

    // Validate arguments if present
    if (serverParams.args && Array.isArray(serverParams.args)) {
        validateArgsForLocalFileAccess(serverParams.args)
        validateCommandInjection(serverParams.args)

        // Validate command-specific dangerous flags
        if (serverParams.command) {
            validateCommandFlags(serverParams.command, serverParams.args)
        }
    }

    // Validate environment variables
    if (serverParams.env) {
        validateEnvironmentVariables(serverParams.env)
    }
}
