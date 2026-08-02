import { createMetadataDisplayView, resolveCurrentMetadataItem } from '@/utils/componentMetadataDisplay'

/** Keep saved Sticky Note schema raw while projecting the current registry copy for rendering. */
export const resolveStickyNoteInputView = (data, componentNodes = []) => {
    const [inputParam] = data?.inputParams ?? []
    if (!inputParam) return { inputParam: undefined, renderInputParam: undefined }

    const componentMetadata = (componentNodes ?? []).find((component) => component.name === data?.name)
    const currentInputParam = resolveCurrentMetadataItem(componentMetadata, inputParam)
    return {
        inputParam,
        renderInputParam: createMetadataDisplayView(inputParam, currentInputParam ?? inputParam)
    }
}
