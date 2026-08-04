import { randomUUID } from 'crypto'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { IMetricsProvider } from '../Interface.Metrics'
import { auditLogger } from '../utils/logger'

export const MCP_HTTP_ROUTE = '/api/v1/mcp/:chatflowId'
export const EARLY_HTTP_METRICS_OBSERVED = 'flowiseEarlyHttpMetricsObserved'

const safeMethod = (method: string): string => (/^[A-Z]{1,16}$/.test(method) ? method : 'OTHER')

/**
 * MCP is mounted before the generic parser and request logger. This scoped
 * observer restores an allowlisted audit receipt and HTTP metrics without
 * reading headers, query parameters or request bodies.
 */
export const createMcpRequestObservability = (getMetricsProvider: () => IMetricsProvider | undefined): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const requestId = randomUUID()
        const method = safeMethod(req.method)
        const startedAt = process.hrtime.bigint()
        let recorded = false

        res.locals[EARLY_HTTP_METRICS_OBSERVED] = true

        const record = (completion: 'finish' | 'close'): void => {
            if (recorded) return
            recorded = true
            const durationMs = Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1_000_000)
            const statusCode = completion === 'close' && !res.writableEnded ? 499 : res.statusCode

            try {
                getMetricsProvider()?.observeHttpRequest?.({
                    method,
                    route: MCP_HTTP_ROUTE,
                    statusCode,
                    durationMs
                })
            } catch {
                // Metrics must never change the request outcome.
            }

            try {
                auditLogger.info('mcp_http_request', {
                    requestId,
                    method,
                    route: MCP_HTTP_ROUTE,
                    statusCode,
                    durationMs,
                    completion
                })
            } catch {
                // Audit transport failures must not change the request outcome.
            }
        }

        res.once('finish', () => record('finish'))
        res.once('close', () => record('close'))
        next()
    }
}
