import { localizeOptionViews } from '@/utils/componentMetadataDisplay'

import { filterDropdownOptions, getDropdownOptionLabel, getDropdownOptionMachineValue } from './Dropdown'
import { filterMultiDropdownOptions, getMultiDropdownOptionLabel, getMultiDropdownOptionMachineValue } from './MultiDropdown'

const rawOptions = [
    { name: 'createChannel', label: 'Create Channel', description: 'Create a Microsoft Teams channel' },
    { name: 'deleteChannel', label: 'Delete Channel' }
]
const currentOptions = [
    {
        ...rawOptions[0],
        displayLabel: '创建频道',
        displayDescription: '创建一个 Microsoft Teams 频道'
    },
    { ...rawOptions[1], displayLabel: '删除频道' }
]

const filterWith = (filterOptions, getOptionLabel, options, inputValue) =>
    filterOptions(options, {
        inputValue,
        getOptionLabel
    })

describe('static metadata dropdown search', () => {
    it('filters single-select options by Chinese display text or raw English text and retains the machine name', () => {
        const options = localizeOptionViews(rawOptions, currentOptions)

        expect(filterWith(filterDropdownOptions, getDropdownOptionLabel, options, '创建频道')).toEqual([options[0]])
        expect(filterWith(filterDropdownOptions, getDropdownOptionLabel, options, 'Create Channel')).toEqual([options[0]])
        expect(filterWith(filterDropdownOptions, getDropdownOptionLabel, options, 'createChannel')).toEqual([options[0]])
        expect(getDropdownOptionMachineValue(options[0])).toBe('createChannel')
    })

    it('filters multi-select mixed options safely and retains string and object machine values', () => {
        const localizedOptions = localizeOptionViews(rawOptions, currentOptions)
        const options = ['raw-string-option', ...localizedOptions]

        expect(filterWith(filterMultiDropdownOptions, getMultiDropdownOptionLabel, options, 'raw-string')).toEqual(['raw-string-option'])
        expect(filterWith(filterMultiDropdownOptions, getMultiDropdownOptionLabel, options, '删除频道')).toEqual([localizedOptions[1]])
        expect(filterWith(filterMultiDropdownOptions, getMultiDropdownOptionLabel, options, 'Delete Channel')).toEqual([
            localizedOptions[1]
        ])
        expect(options.map(getMultiDropdownOptionMachineValue)).toEqual(['raw-string-option', 'createChannel', 'deleteChannel'])
    })
})
