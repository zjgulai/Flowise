import { resolveStickyNoteInputView } from './stickyNoteMetadata'

describe('Sticky Note metadata projection', () => {
    const makeFixture = (name) => {
        const inputParam = {
            id: `${name}_0-input-note-string`,
            name: 'note',
            type: 'string',
            label: 'Note',
            placeholder: 'Type something here',
            displayPlaceholder: '不可信的持久化显示文案',
            default: ''
        }
        return {
            inputParam,
            data: { name, inputParams: [inputParam], inputs: { note: '保留内容' } }
        }
    }

    it.each(['stickyNote', 'stickyNoteAgentflow'])(
        'renders the current Chinese placeholder for %s without changing saved schema or value',
        (name) => {
            const { data, inputParam } = makeFixture(name)
            const componentNodes = [
                {
                    name,
                    inputs: [
                        {
                            ...inputParam,
                            displayLabel: '备注',
                            displayPlaceholder: '在此输入内容'
                        }
                    ]
                }
            ]
            const original = structuredClone(data)

            const { inputParam: rawInputParam, renderInputParam } = resolveStickyNoteInputView(data, componentNodes)

            expect(rawInputParam).toBe(inputParam)
            expect(rawInputParam.placeholder).toBe('Type something here')
            expect(rawInputParam.displayPlaceholder).toBe('不可信的持久化显示文案')
            expect(renderInputParam.placeholder).toBe('在此输入内容')
            expect(renderInputParam).not.toHaveProperty('displayPlaceholder')
            expect(renderInputParam).not.toBe(rawInputParam)
            expect(data).toEqual(original)
        }
    )

    it('fails closed to the saved raw placeholder when the current registry item is unavailable', () => {
        const { data } = makeFixture('stickyNote')
        const { renderInputParam } = resolveStickyNoteInputView(data, undefined)

        expect(renderInputParam.placeholder).toBe('Type something here')
        expect(renderInputParam).not.toHaveProperty('displayPlaceholder')
    })
})
