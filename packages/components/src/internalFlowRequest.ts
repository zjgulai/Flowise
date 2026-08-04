import { AxiosRequestConfig } from 'axios'
import { ICommonObject } from './Interface'
import { createFixedOriginPolicy, resolveFlowiseRequestTarget, secureAxiosRequest } from './httpSecurity'
import { isValidUUID } from './validator'

export const FLOWISE_REQUEST_ERROR = 'Failed to execute the selected flow.'
const FLOWISE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const FLOWISE_REQUEST_MAX_BODY_BYTES = 32 * 1024 * 1024
const FLOWISE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024

export interface InternalFlowRequestOptions {
    configuredBaseUrl?: unknown
    flowId: string
    body: ICommonObject
    apiKey?: unknown
    flowiseTool?: boolean
    evaluationRequestId?: unknown
}

/**
 * Calls a Flowise prediction endpoint without trusting request-derived Host data.
 * Persisted external targets are supported only over HTTPS and without
 * credentials; Flow API keys are bound exclusively to the canonical APP_URL
 * origin.
 */
export async function requestFlowisePrediction({
    configuredBaseUrl,
    flowId,
    body,
    apiKey,
    flowiseTool = false,
    evaluationRequestId
}: InternalFlowRequestOptions): Promise<any> {
    try {
        if (!isValidUUID(flowId)) throw new Error(FLOWISE_REQUEST_ERROR)
        const hasEvaluationRequestId = evaluationRequestId !== undefined
        if (hasEvaluationRequestId && (typeof evaluationRequestId !== 'string' || !isValidUUID(evaluationRequestId))) {
            throw new Error(FLOWISE_REQUEST_ERROR)
        }

        const target = resolveFlowiseRequestTarget(configuredBaseUrl)
        const hasApiKey = typeof apiKey === 'string' && apiKey.length > 0
        if (apiKey && !hasApiKey) throw new Error(FLOWISE_REQUEST_ERROR)
        if (new URL(target.baseUrl).protocol !== 'https:') {
            throw new Error(FLOWISE_REQUEST_ERROR)
        }
        if (hasApiKey && !target.isCanonicalOrigin) {
            throw new Error(FLOWISE_REQUEST_ERROR)
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(flowiseTool ? { 'flowise-tool': 'true' } : {}),
            ...(hasEvaluationRequestId
                ? {
                      'X-Request-ID': evaluationRequestId as string,
                      'X-Flowise-Evaluation': 'true'
                  }
                : {}),
            ...(hasApiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        }
        const requestConfig: AxiosRequestConfig = {
            method: 'POST',
            url: new URL(`/api/v1/prediction/${flowId}`, `${target.baseUrl}/`).toString(),
            headers,
            timeout: FLOWISE_REQUEST_TIMEOUT_MS,
            maxBodyLength: FLOWISE_REQUEST_MAX_BODY_BYTES,
            maxContentLength: FLOWISE_RESPONSE_MAX_BYTES,
            data: hasEvaluationRequestId
                ? {
                      ...body,
                      evaluationRunId: evaluationRequestId,
                      evaluation: true
                  }
                : body
        }

        const response = await secureAxiosRequest(requestConfig, 5, undefined, createFixedOriginPolicy(target.baseUrl))
        if (response.status < 200 || response.status >= 300) throw new Error(FLOWISE_REQUEST_ERROR)
        return response.data
    } catch {
        throw new Error(FLOWISE_REQUEST_ERROR)
    }
}
