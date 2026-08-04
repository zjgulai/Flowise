import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { Box, Chip } from '@mui/material'
import { useTheme } from '@mui/material/styles'

const DEFAULT_DAYS = [
    { label: '周一', value: '1' },
    { label: '周二', value: '2' },
    { label: '周三', value: '3' },
    { label: '周四', value: '4' },
    { label: '周五', value: '5' },
    { label: '周六', value: '6' },
    { label: '周日', value: '7' }
]

export const WeekDaysPicker = ({ value, options, onChange, disabled = false }) => {
    const theme = useTheme()
    const days = options?.length ? options.map((o) => ({ label: o.label, value: o.name })) : DEFAULT_DAYS

    const parseValue = (val) => {
        if (!val) return []
        if (Array.isArray(val)) return val
        if (typeof val === 'string')
            return val
                .split(',')
                .map((token) => token.trim())
                .filter(Boolean)
        return []
    }

    const [selected, setSelected] = useState(parseValue(value))

    useEffect(() => {
        setSelected(parseValue(value))
    }, [value])

    const toggle = (dayValue) => {
        if (disabled) return
        let next
        if (selected.includes(dayValue)) {
            next = selected.filter((d) => d !== dayValue)
        } else {
            next = [...selected, dayValue]
        }
        // Sort by the days array order
        next.sort((a, b) => days.findIndex((d) => d.value === a) - days.findIndex((d) => d.value === b))
        setSelected(next)
        onChange(next.join(','))
    }

    return (
        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {days.map((day) => {
                const isSelected = selected.includes(day.value)
                return (
                    <Chip
                        key={day.value}
                        label={day.label}
                        size='small'
                        disabled={disabled}
                        onClick={() => toggle(day.value)}
                        sx={{
                            cursor: disabled ? 'default' : 'pointer',
                            fontWeight: isSelected ? 600 : 400,
                            borderWidth: '1.5px',
                            borderStyle: 'solid',
                            borderColor: isSelected ? theme.palette.primary.main : theme.palette.grey[400],
                            backgroundColor: isSelected ? theme.palette.primary.main + '20' : 'transparent',
                            color: isSelected ? theme.palette.primary.main : theme.palette.text.primary,
                            '&:hover': disabled
                                ? {}
                                : {
                                      backgroundColor: isSelected ? theme.palette.primary.main + '35' : theme.palette.grey[200]
                                  }
                        }}
                    />
                )
            })}
        </Box>
    )
}

WeekDaysPicker.propTypes = {
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.string)]),
    options: PropTypes.arrayOf(
        PropTypes.shape({
            label: PropTypes.string,
            name: PropTypes.string
        })
    ),
    onChange: PropTypes.func.isRequired,
    disabled: PropTypes.bool
}
