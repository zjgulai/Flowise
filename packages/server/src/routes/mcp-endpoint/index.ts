import express from 'express'
import cors from 'cors'
import { StatusCodes } from 'http-status-codes'
import mcpEndpointController from '../../controllers/mcp-endpoint'

const router = express.Router()

// CORS: Use MCP_CORS_ORIGINS if set, otherwise allow only non-browser (no Origin header) requests.
// MCP desktop clients (Claude Desktop, Cursor, etc.) don't send an Origin header, so they pass through.
// Browser-based clients are restricted to the configured origins.
const mcpCorsOrigins = process.env.MCP_CORS_ORIGINS
const mcpCorsOptions: cors.CorsOptions = {
    origin: mcpCorsOrigins
        ? mcpCorsOrigins === '*'
            ? true
            : mcpCorsOrigins.split(',').map((o) => o.trim())
        : (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
              // No origin header (desktop/server-to-server) → allow
              // Browser origin → deny (no allowed list configured)
              callback(null, !origin)
          },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
}
router.use(cors(mcpCorsOptions))
// Handle preflight for all MCP routes
router.options('/:chatflowId', cors(mcpCorsOptions))

// MCP Streamable HTTP protocol routes (protocol version 2025-03-26)
// Auth: token must be provided via Authorization: Bearer <token> header
// POST — JSON-RPC messages (initialize, tools/list, tools/call, etc.)
router.post(
    '/:chatflowId',
    mcpEndpointController.getRateLimiterMiddleware,
    mcpEndpointController.authenticateToken,
    express.json({ limit: '1mb', type: 'application/json' }),
    mcpEndpointController.handlePost
)

// DELETE — Session termination (stateless mode returns 405)
router.delete('/:chatflowId', mcpEndpointController.handleDelete)

// Keep every MCP-shaped request on the bounded pre-parser path. Unknown methods
// and subpaths must not fall through to the application's global body parsers.
router.use((_req, res) =>
    res.status(StatusCodes.NOT_FOUND).json({
        jsonrpc: '2.0',
        error: {
            code: -32601,
            message: 'MCP endpoint not found'
        },
        id: null
    })
)

export default router
