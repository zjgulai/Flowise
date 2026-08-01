import { useState } from 'react'
import { useSelector } from 'react-redux'

import { Popper, FormControl, TextField, Box, Typography } from '@mui/material'
import Autocomplete, { autocompleteClasses, createFilterOptions } from '@mui/material/Autocomplete'
import { useTheme, styled } from '@mui/material/styles'
import PropTypes from 'prop-types'

import { getMetadataDisplayText, getMetadataOptionSearchText } from '@/utils/componentMetadataDisplay'

export const filterDropdownOptions = createFilterOptions({ stringify: getMetadataOptionSearchText })
export const getDropdownOptionMachineValue = (option) => (typeof option === 'string' ? option : option?.name)
export const getDropdownOptionLabel = (option) =>
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

export const Dropdown = ({ name, value, loading, options, onSelect, disabled = false, freeSolo = false, disableClearable = false }) => {
    const customization = useSelector((state) => state.customization)
    const findMatchingOptions = (options = [], value) => options.find((option) => getDropdownOptionMachineValue(option) === value)
    const getDefaultOptionValue = () => ''
    let [internalValue, setInternalValue] = useState(value ?? 'choose an option')
    const theme = useTheme()

    return (
        <FormControl sx={{ mt: 1, width: '100%' }} size='small'>
            <Autocomplete
                id={name}
                disabled={disabled}
                freeSolo={freeSolo}
                disableClearable={disableClearable}
                size='small'
                loading={loading}
                options={options || []}
                filterOptions={filterDropdownOptions}
                getOptionLabel={getDropdownOptionLabel}
                value={findMatchingOptions(options, internalValue) || getDefaultOptionValue()}
                onChange={(e, selection) => {
                    const value = selection ? getDropdownOptionMachineValue(selection) ?? '' : ''
                    setInternalValue(value)
                    onSelect(value)
                }}
                PopperComponent={StyledPopper}
                renderInput={(params) => {
                    const matchingOption = findMatchingOptions(options, internalValue)
                    return (
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
                            InputProps={{
                                ...params.InputProps,
                                startAdornment: matchingOption?.imageSrc ? (
                                    <Box
                                        component='img'
                                        src={matchingOption.imageSrc}
                                        alt={getDropdownOptionLabel(matchingOption) || '已选选项'}
                                        sx={{
                                            width: 32,
                                            height: 32,
                                            borderRadius: '50%'
                                        }}
                                    />
                                ) : null
                            }}
                        />
                    )
                }}
                renderOption={(props, option) => (
                    <Box component='li' {...props} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {option.imageSrc && (
                            <img
                                src={option.imageSrc}
                                alt={option.description}
                                style={{
                                    width: 30,
                                    height: 30,
                                    padding: 1,
                                    borderRadius: '50%'
                                }}
                            />
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography variant='h5'>{getDropdownOptionLabel(option)}</Typography>
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

Dropdown.propTypes = {
    name: PropTypes.string,
    value: PropTypes.string,
    loading: PropTypes.bool,
    options: PropTypes.array,
    freeSolo: PropTypes.bool,
    onSelect: PropTypes.func,
    disabled: PropTypes.bool,
    disableClearable: PropTypes.bool
}
