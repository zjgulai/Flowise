/**
 * HTML Templates for OAuth2 Callback Pages
 *
 * This module contains reusable HTML templates for OAuth2 authorization responses.
 * The templates provide consistent styling and behavior for success and error pages.
 */

import { getSecureAppUrl } from '../../enterprise/utils/url.util'

/**
 * Escapes HTML special characters to prevent XSS attacks
 */
const escapeHtml = (unsafe: string): string => {
    return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const serializeForInlineScript = (value: unknown): string =>
    JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
        const replacements: Record<string, string> = {
            '<': '\\u003c',
            '>': '\\u003e',
            '&': '\\u0026',
            '\u2028': '\\u2028',
            '\u2029': '\\u2029'
        }
        return replacements[character]
    })

const OAUTH2_ERROR_MESSAGE = '授权未完成，请返回应用后重试。'

export interface OAuth2PageOptions {
    title: string
    statusIcon: string
    statusText: string
    statusColor: string
    message: string
    details?: string
    postMessageType: 'OAUTH2_SUCCESS' | 'OAUTH2_ERROR'
    postMessageData: any
    autoCloseDelay: number
}

export const generateOAuth2ResponsePage = (options: OAuth2PageOptions): string => {
    const { title, statusIcon, statusText, statusColor, message, details, postMessageType, postMessageData, autoCloseDelay } = options

    // Escape all user-controlled content to prevent XSS
    const safeTitle = escapeHtml(title)
    const safeStatusIcon = escapeHtml(statusIcon)
    const safeStatusText = escapeHtml(statusText)
    const safeMessage = escapeHtml(message)
    const safeDetails = details ? escapeHtml(details) : undefined
    const postMessagePayload = serializeForInlineScript({ type: postMessageType, ...postMessageData })
    const postMessageOrigin = serializeForInlineScript(new URL(getSecureAppUrl()).origin)

    return `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <title>${safeTitle}</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background-color: #f5f5f5;
                }
                .container {
                    text-align: center;
                    background: white;
                    padding: 2rem;
                    border-radius: 8px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                    max-width: 500px;
                }
                .status {
                    color: ${statusColor};
                    font-size: 1.2rem;
                    margin-bottom: 1rem;
                }
                .message {
                    color: #666;
                    margin-bottom: 1rem;
                }
                .details {
                    background: #f9f9f9;
                    padding: 1rem;
                    border-radius: 4px;
                    font-size: 0.9rem;
                    color: #333;
                    text-align: left;
                    margin-top: 1rem;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="status">${safeStatusIcon} ${safeStatusText}</div>
                <div class="message">${safeMessage}</div>
                ${safeDetails ? `<div class="details">${safeDetails}</div>` : ''}
            </div>
            <script>
                // Notify parent window
                try {
                    if (window.opener) {
                        window.opener.postMessage(${postMessagePayload}, ${postMessageOrigin});
                    }
                } catch {
                    // The parent window may have closed before this callback completed.
                }

                // Close window after delay
                setTimeout(function() {
                    window.close();
                }, ${autoCloseDelay});
            </script>
        </body>
        </html>
    `
}

export const generateSuccessPage = (credentialId: string): string => {
    return generateOAuth2ResponsePage({
        title: 'OAuth2 授权成功',
        statusIcon: '✓',
        statusText: '授权成功',
        statusColor: '#4caf50',
        message: '授权已完成，您现在可以关闭此窗口。',
        postMessageType: 'OAUTH2_SUCCESS',
        postMessageData: {
            credentialId,
            success: true,
            message: 'OAuth2 授权已成功完成'
        },
        autoCloseDelay: 1000
    })
}

export const generateErrorPage = (_error: string, _message: string, _details?: string): string => {
    return generateOAuth2ResponsePage({
        title: 'OAuth2 授权失败',
        statusIcon: '✗',
        statusText: '授权失败',
        statusColor: '#f44336',
        message: OAUTH2_ERROR_MESSAGE,
        postMessageType: 'OAUTH2_ERROR',
        postMessageData: {
            success: false,
            message: OAUTH2_ERROR_MESSAGE
        },
        autoCloseDelay: 3000
    })
}
