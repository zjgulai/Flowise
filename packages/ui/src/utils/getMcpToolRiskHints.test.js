import { getMcpToolRiskHints } from './getMcpToolRiskHints'

describe('getMcpToolRiskHints', () => {
    it('applies the MCP conservative defaults when annotations are absent', () => {
        expect(getMcpToolRiskHints()).toEqual({
            readOnly: false,
            writable: true,
            additiveWrite: false,
            destructive: true,
            idempotent: false,
            nonIdempotent: true,
            openWorld: true,
            riskUnknown: true
        })
    })

    it('keeps an all-false declaration visibly writable, additive, and non-idempotent', () => {
        expect(getMcpToolRiskHints({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })).toEqual({
            readOnly: false,
            writable: true,
            additiveWrite: true,
            destructive: false,
            idempotent: false,
            nonIdempotent: true,
            openWorld: false,
            riskUnknown: false
        })
    })

    it('ignores write and retry hints for a declared read-only tool', () => {
        expect(getMcpToolRiskHints({ readOnlyHint: true, destructiveHint: true, idempotentHint: false, openWorldHint: false })).toEqual({
            readOnly: true,
            writable: false,
            additiveWrite: false,
            destructive: false,
            idempotent: false,
            nonIdempotent: false,
            openWorld: false,
            riskUnknown: false
        })
    })
})
