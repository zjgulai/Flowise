export const WORKSPACE_EXPORT_ORDER = [
    'Agentflows',
    'Agentflows V2',
    'Assistants Custom',
    'Chatflows',
    'Chat Messages',
    'Chat Feedbacks',
    'Custom Templates',
    'Document Stores',
    'Executions',
    'Tools',
    'Variables'
]

export const WORKSPACE_EXPORT_DEFAULT_SELECTION = WORKSPACE_EXPORT_ORDER.filter(
    (value) => !['Chat Messages', 'Chat Feedbacks', 'Document Stores', 'Executions'].includes(value)
)

const orderSelection = (selection) => WORKSPACE_EXPORT_ORDER.filter((value) => selection.has(value))

export const updateWorkspaceExportSelection = (currentSelection, value, checked) => {
    const selection = new Set(currentSelection)
    if (checked) {
        selection.add(value)
        return orderSelection(selection)
    }
    selection.delete(value)
    return orderSelection(selection)
}
