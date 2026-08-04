import { WORKSPACE_EXPORT_DEFAULT_SELECTION, WORKSPACE_EXPORT_ORDER, updateWorkspaceExportSelection } from './workspaceExportSelection'

describe('workspace export root selection', () => {
    it('does not preselect content-heavy history and document categories', () => {
        expect(WORKSPACE_EXPORT_DEFAULT_SELECTION).not.toEqual(
            expect.arrayContaining(['Chat Messages', 'Chat Feedbacks', 'Document Stores', 'Executions'])
        )
        expect(WORKSPACE_EXPORT_DEFAULT_SELECTION).toEqual(
            expect.arrayContaining([
                'Agentflows',
                'Agentflows V2',
                'Assistants Custom',
                'Chatflows',
                'Custom Templates',
                'Tools',
                'Variables'
            ])
        )
    })

    it('keeps a narrow feedback root selection explicit', () => {
        expect(updateWorkspaceExportSelection([], 'Chat Feedbacks', true)).toEqual(['Chat Feedbacks'])
    })

    it('keeps the requested display order without selecting unrelated categories', () => {
        expect(updateWorkspaceExportSelection(['Tools'], 'Custom Templates', true)).toEqual(['Custom Templates', 'Tools'])
    })

    it('removes only the selected category', () => {
        expect(updateWorkspaceExportSelection(WORKSPACE_EXPORT_ORDER, 'Tools', false)).toEqual(
            WORKSPACE_EXPORT_ORDER.filter((value) => value !== 'Tools')
        )
    })
})
