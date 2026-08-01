import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getEdgeDisplayLabel } from './edgeDisplayLabel'

describe('getEdgeDisplayLabel', () => {
    it.each([
        ['proceed', '继续'],
        ['Proceed', '继续'],
        ['reject', '拒绝'],
        ['Reject', '拒绝']
    ])('localizes the known human-input machine label %s for display only', (machineLabel, displayLabel) => {
        expect(getEdgeDisplayLabel(machineLabel, true)).toBe(displayLabel)
        expect(machineLabel).not.toBe(displayLabel)
    })

    it('preserves custom labels and every non-human label', () => {
        expect(getEdgeDisplayLabel('custom-approval', true)).toBe('custom-approval')
        expect(getEdgeDisplayLabel('Proceed', false)).toBe('Proceed')
        expect(getEdgeDisplayLabel('0', false)).toBe('0')
    })

    it('rejects non-string label payloads before they reach React', () => {
        expect(getEdgeDisplayLabel({ malicious: true }, true)).toBeUndefined()
        expect(getEdgeDisplayLabel(undefined, true)).toBeUndefined()
    })

    it('keeps unknown HTML-looking labels as escaped React text', () => {
        const machineLabel = '<img src=x onerror="globalThis.pwned=true">'
        const displayLabel = getEdgeDisplayLabel(machineLabel, true)
        const markup = renderToStaticMarkup(React.createElement('span', null, displayLabel))

        expect(displayLabel).toBe(machineLabel)
        expect(markup).toContain('&lt;img')
        expect(markup).not.toContain('<img')
    })
})
