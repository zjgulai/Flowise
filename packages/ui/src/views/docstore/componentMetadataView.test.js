import {
    createDocStoreInputView,
    getDocStoreComponentDisplayDescription,
    getDocStoreComponentDisplayLabel,
    matchesDocStoreComponentSearch
} from './componentMetadataView'

describe('docstore component metadata view', () => {
    const component = {
        name: 'openAIEmbeddings',
        label: 'OpenAI Embeddings',
        displayLabel: 'OpenAI 嵌入模型',
        category: 'Embeddings',
        displayCategory: '嵌入模型',
        description: 'Create vector embeddings',
        displayDescription: '创建向量嵌入',
        inputs: [
            {
                name: 'mode',
                type: 'options',
                label: 'Mode',
                displayLabel: '模式',
                description: 'Select a mode',
                displayDescription: '选择一种模式',
                default: 'fast',
                options: [
                    { name: 'fast', label: 'Fast', displayLabel: '快速' },
                    { name: 'accurate', label: 'Accurate', displayLabel: '精确' }
                ],
                datagrid: [{ field: 'source', headerName: 'Source', displayHeaderName: '来源' }]
            }
        ]
    }

    it('uses display copy for labels and descriptions while keeping the source DTO untouched', () => {
        expect(getDocStoreComponentDisplayLabel(component)).toBe('OpenAI 嵌入模型')
        expect(getDocStoreComponentDisplayDescription(component)).toBe('创建向量嵌入')
        expect(component.label).toBe('OpenAI Embeddings')
        expect(component.description).toBe('Create vector embeddings')
    })

    it('searches both raw machine-facing text and Chinese display text', () => {
        expect(matchesDocStoreComponentSearch(component, 'openaiembeddings')).toBe(true)
        expect(matchesDocStoreComponentSearch(component, 'Embeddings')).toBe(true)
        expect(matchesDocStoreComponentSearch(component, '向量嵌入')).toBe(true)
        expect(matchesDocStoreComponentSearch(component, '不存在')).toBe(false)
    })

    it('projects nested display fields without changing machine fields or defaults', () => {
        const savedInput = {
            name: 'mode',
            type: 'options',
            label: 'Mode',
            description: 'Select a mode',
            default: 'fast',
            options: [
                { name: 'fast', label: 'Fast' },
                { name: 'accurate', label: 'Accurate' }
            ],
            datagrid: [{ field: 'source', headerName: 'Source' }]
        }

        const view = createDocStoreInputView(savedInput, component)

        expect(view).toMatchObject({ name: 'mode', type: 'options', default: 'fast', label: '模式', description: '选择一种模式' })
        expect(view.options).toEqual([
            { name: 'fast', label: '快速' },
            { name: 'accurate', label: '精确' }
        ])
        expect(view.datagrid).toEqual([{ field: 'source', headerName: '来源' }])
        expect(savedInput).toEqual({
            name: 'mode',
            type: 'options',
            label: 'Mode',
            description: 'Select a mode',
            default: 'fast',
            options: [
                { name: 'fast', label: 'Fast' },
                { name: 'accurate', label: 'Accurate' }
            ],
            datagrid: [{ field: 'source', headerName: 'Source' }]
        })
    })

    it('projects primitive and object valueOptions while preserving their submitted values', () => {
        const savedInput = {
            name: 'rules',
            type: 'datagrid',
            datagrid: [
                { field: 'operation', type: 'singleSelect', valueOptions: ['Contains', 'Is Empty'] },
                { field: 'variable', type: 'freeSolo', valueOptions: [{ value: '$flow.input', label: 'Input Question' }] }
            ]
        }
        const currentComponent = {
            name: 'loader',
            inputs: [
                {
                    ...savedInput,
                    datagrid: [
                        {
                            ...savedInput.datagrid[0],
                            displayValueOptions: [
                                { value: 'Contains', label: '包含' },
                                { value: 'Is Empty', label: '为空' }
                            ]
                        },
                        {
                            ...savedInput.datagrid[1],
                            valueOptions: [{ value: '$flow.input', label: 'Input Question', displayLabel: '输入问题' }]
                        }
                    ]
                }
            ]
        }

        const view = createDocStoreInputView(savedInput, currentComponent)

        expect(view.datagrid[0].valueOptions).toEqual([
            { value: 'Contains', label: '包含' },
            { value: 'Is Empty', label: '为空' }
        ])
        expect(view.datagrid[1].valueOptions).toEqual([{ value: '$flow.input', label: '输入问题' }])
        expect(savedInput.datagrid[0].valueOptions).toEqual(['Contains', 'Is Empty'])
        expect(savedInput.datagrid[1].valueOptions).toEqual([{ value: '$flow.input', label: 'Input Question' }])
    })

    it('fails closed when primitive display options do not match saved machine values', () => {
        const savedInput = {
            name: 'rules',
            type: 'datagrid',
            datagrid: [{ field: 'operation', type: 'singleSelect', valueOptions: ['SAFE'] }]
        }
        const currentComponent = {
            name: 'loader',
            inputs: [
                {
                    ...savedInput,
                    datagrid: [
                        {
                            ...savedInput.datagrid[0],
                            displayValueOptions: [{ value: 'INJECTED', label: '伪造' }]
                        }
                    ]
                }
            ]
        }

        const view = createDocStoreInputView(savedInput, currentComponent)

        expect(view.datagrid[0].valueOptions).toEqual([{ value: 'SAFE', label: 'SAFE' }])
        expect(savedInput.datagrid[0].valueOptions).toEqual(['SAFE'])
    })

    it('fails closed when object display options do not match saved machine identity', () => {
        const savedInput = {
            name: 'rules',
            type: 'datagrid',
            datagrid: [
                {
                    field: 'variable',
                    type: 'freeSolo',
                    valueOptions: [{ value: '$flow.input', label: 'Input Question' }]
                }
            ]
        }
        const currentComponent = {
            name: 'loader',
            inputs: [
                {
                    ...savedInput,
                    datagrid: [
                        {
                            ...savedInput.datagrid[0],
                            valueOptions: [{ value: '$flow.other', label: 'Other Value', displayLabel: '其他值' }]
                        }
                    ]
                }
            ]
        }

        const view = createDocStoreInputView(savedInput, currentComponent)

        expect(view.datagrid[0].valueOptions).toEqual([{ value: '$flow.input', label: 'Input Question' }])
    })
})
