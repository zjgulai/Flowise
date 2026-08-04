import { parseStoredAssistantResource } from './assistantResourceState'

const safeIdExcerpt = (value) => {
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (!sanitized) return '未知 ID'
    return sanitized.length > 24 ? `${sanitized.slice(0, 24)}…` : sanitized
}

export const buildOpenAIAssistantCardIndex = (value) => {
    if (!Array.isArray(value)) return { cards: [], invalidCount: 0 }

    const cards = value.flatMap((resource) => {
        const parsed = parseStoredAssistantResource(resource)
        if (!parsed.success) return []

        const displayName = parsed.data.details.name || `未命名助手（${safeIdExcerpt(parsed.data.details.id || parsed.data.id)}）`
        return [
            {
                resource,
                name: displayName,
                description: parsed.data.details.description,
                iconSrc: parsed.data.iconSrc,
                searchText: [displayName, parsed.data.details.name, parsed.data.id, parsed.data.details.id].join('\n').toLocaleLowerCase()
            }
        ]
    })

    return { cards, invalidCount: value.length - cards.length }
}

export const filterOpenAIAssistantCards = (cards, search = '') => {
    if (!Array.isArray(cards)) return []
    const normalizedSearch = typeof search === 'string' ? search.trim().toLocaleLowerCase() : ''
    return normalizedSearch ? cards.filter((card) => card.searchText.includes(normalizedSearch)) : cards
}

export const getOpenAIAssistantCards = (value, search = '') =>
    filterOpenAIAssistantCards(buildOpenAIAssistantCardIndex(value).cards, search)
