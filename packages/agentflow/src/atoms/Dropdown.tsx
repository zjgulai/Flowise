import { useMemo } from 'react'

import { Box, FormControl, Popper, TextField, Typography } from '@mui/material'
import Autocomplete, { autocompleteClasses, createFilterOptions } from '@mui/material/Autocomplete'
import { styled, useTheme } from '@mui/material/styles'

import { getMetadataOptionSearchText } from '@/core/primitives'

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

export interface DropdownOption {
    label: string
    name: string
    description?: string
    imageSrc?: string
}

export interface DropdownProps {
    name?: string
    value: string
    options: ReadonlyArray<DropdownOption | string | null | undefined>
    onSelect: (value: string) => void
    disabled?: boolean
    loading?: boolean
    freeSolo?: boolean
    disableClearable?: boolean
}

const filterMetadataOptions = createFilterOptions<DropdownOption>({ stringify: getMetadataOptionSearchText })

const getSafeOptionLabel = (option: DropdownOption | string): string => {
    if (typeof option === 'string') return option
    if (typeof option.label === 'string') return option.label
    return typeof option.name === 'string' ? option.name : ''
}

/**
 * Autocomplete-based dropdown with search, image, and description support.
 * Mirrors the original Flowise Dropdown component.
 */
export function Dropdown({
    name,
    value,
    options = [],
    onSelect,
    disabled = false,
    loading = false,
    freeSolo = false,
    disableClearable = false
}: DropdownProps) {
    const theme = useTheme()

    const normalizedOptions = useMemo(
        () =>
            options.flatMap((option): DropdownOption[] => {
                if (typeof option === 'string') return option ? [{ label: option, name: option }] : []
                if (!option || typeof option !== 'object' || typeof option.name !== 'string' || !option.name) return []
                return [option]
            }),
        [options]
    )

    const resolvedValue = value ?? 'choose an option'
    const findMatchingOption = (val: string) => normalizedOptions.find((option) => option.name === val) ?? null

    return (
        <FormControl sx={{ mt: 1, width: '100%' }} size='small'>
            <Autocomplete
                id={name}
                disabled={disabled}
                freeSolo={freeSolo}
                disableClearable={disableClearable}
                size='small'
                loading={loading}
                options={normalizedOptions}
                filterOptions={filterMetadataOptions}
                value={findMatchingOption(resolvedValue)}
                getOptionLabel={getSafeOptionLabel}
                isOptionEqualToValue={(option, val) => option.name === val.name}
                onChange={(_e, selection) => {
                    const newValue = selection && typeof selection !== 'string' && typeof selection.name === 'string' ? selection.name : ''
                    onSelect(newValue)
                }}
                PopperComponent={StyledPopper}
                renderInput={(params) => {
                    const matchingOption = findMatchingOption(resolvedValue)
                    return (
                        <TextField
                            {...params}
                            sx={{
                                height: '100%',
                                '& .MuiInputBase-root': {
                                    height: '100%',
                                    '& fieldset': {
                                        borderColor: theme.palette.divider
                                    }
                                }
                            }}
                            InputProps={{
                                ...params.InputProps,
                                startAdornment: matchingOption?.imageSrc ? (
                                    <Box
                                        component='img'
                                        src={matchingOption.imageSrc}
                                        alt={getSafeOptionLabel(matchingOption) || 'Selected Option'}
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
                        {typeof option.imageSrc === 'string' && option.imageSrc && (
                            <img
                                src={option.imageSrc}
                                alt={getSafeOptionLabel(option)}
                                style={{
                                    width: 30,
                                    height: 30,
                                    padding: 1,
                                    borderRadius: '50%'
                                }}
                            />
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography variant='h5'>{getSafeOptionLabel(option)}</Typography>
                            {typeof option.description === 'string' && option.description && (
                                <Typography sx={{ color: theme.palette.text.secondary }}>{option.description}</Typography>
                            )}
                        </div>
                    </Box>
                )}
                sx={{ height: '100%' }}
            />
        </FormControl>
    )
}
