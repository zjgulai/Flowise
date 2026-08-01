import { useState } from 'react'
import { useSelector } from 'react-redux'

import { Popper, FormControl, TextField, Box, Typography } from '@mui/material'
import Autocomplete, { autocompleteClasses, createFilterOptions } from '@mui/material/Autocomplete'
import { useTheme, styled } from '@mui/material/styles'
import PropTypes from 'prop-types'

import { getMetadataDisplayText, getMetadataOptionSearchText } from '@/utils/componentMetadataDisplay'

export const filterMultiDropdownOptions = createFilterOptions({ stringify: getMetadataOptionSearchText })
export const getMultiDropdownOptionMachineValue = (option) => (typeof option === 'string' ? option : option?.name)
export const getMultiDropdownOptionLabel = (option) =>
    typeof option === 'string' ? option : getMetadataDisplayText(option, 'label', typeof option?.name === 'string' ? option.name : '')

const StyledPopper = styled(Popper)({
    boxShadow: '0px 8px 10px -5px rgb(0 0 0 / 20%), 0px 16px 24px 2px rgb(0 0 0 / 14%), 0px 6px 30px 5px rgb(0 0 0 / 12%)',
    borderRadius: '10px',
    [`& .${autocompleteClasses.listbox}`]: {
        boxSizing: 'border-box',
        '& ul': {
            padding: 10,
            margin: 10
        }
    }
})

export const MultiDropdown = ({ name, value, options, onSelect, formControlSx = {}, disabled = false, disableClearable = false }) => {
    const customization = useSelector((state) => state.customization)
    const findMatchingOptions = (options = [], internalValue) => {
        let values = []
        if ('choose an option' !== internalValue && internalValue && typeof internalValue === 'string') {
            try {
                const parsedValue = JSON.parse(internalValue)
                values = Array.isArray(parsedValue) ? parsedValue : []
            } catch {
                values = []
            }
        } else if (Array.isArray(internalValue)) values = internalValue
        return options.filter((option) => values.includes(getMultiDropdownOptionMachineValue(option)))
    }
    const getDefaultOptionValue = () => []
    let [internalValue, setInternalValue] = useState(value ?? [])
    const theme = useTheme()

    return (
        <FormControl sx={{ mt: 1, width: '100%', ...formControlSx }} size='small'>
            <Autocomplete
                id={name}
                disabled={disabled}
                disableClearable={disableClearable}
                size='small'
                multiple
                filterSelectedOptions
                options={options || []}
                filterOptions={filterMultiDropdownOptions}
                getOptionLabel={getMultiDropdownOptionLabel}
                value={findMatchingOptions(options, internalValue) || getDefaultOptionValue()}
                onChange={(e, selections) => {
                    let value = ''
                    if (selections.length) {
                        const selectionNames = []
                        for (let i = 0; i < selections.length; i += 1) {
                            selectionNames.push(getMultiDropdownOptionMachineValue(selections[i]))
                        }
                        value = JSON.stringify(selectionNames)
                    }
                    setInternalValue(value)
                    onSelect(value)
                }}
                PopperComponent={StyledPopper}
                renderInput={(params) => (
                    <TextField
                        {...params}
                        value={internalValue}
                        sx={{
                            height: '100%',
                            '& .MuiInputBase-root': {
                                height: '100%',
                                '& fieldset': {
                                    borderColor: theme.palette.grey[900] + 25
                                }
                            }
                        }}
                    />
                )}
                renderOption={(props, option) => (
                    <Box component='li' {...props}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography variant='h5'>{getMultiDropdownOptionLabel(option)}</Typography>
                            {getMetadataDisplayText(option, 'description') && (
                                <Typography sx={{ color: customization.isDarkMode ? '#9e9e9e' : '' }}>
                                    {getMetadataDisplayText(option, 'description')}
                                </Typography>
                            )}
                        </div>
                    </Box>
                )}
                sx={{ height: '100%' }}
            />
        </FormControl>
    )
}

MultiDropdown.propTypes = {
    name: PropTypes.string,
    value: PropTypes.string,
    options: PropTypes.array,
    onSelect: PropTypes.func,
    disabled: PropTypes.bool,
    formControlSx: PropTypes.object,
    disableClearable: PropTypes.bool
}
