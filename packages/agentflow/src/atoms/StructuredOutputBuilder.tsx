import { useCallback, useMemo, useState } from 'react'

import { Box, Button, Chip, IconButton, MenuItem, Select, TextField, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconArrowsMaximize, IconPlus, IconTrash } from '@tabler/icons-react'

import { ExpandTextDialog } from '@/atoms'
import { getMetadataDisplayText } from '@/core/primitives'
import type { InputParam, NodeData } from '@/core/types'

import { CodeInput } from './CodeInput'
import { TooltipWithParser } from './TooltipWithParser'
import { useStableKeys } from './useStableKeys'

const OUTPUT_TYPES = [
    { label: '字符串', value: 'string' },
    { label: '字符串数组', value: 'stringArray' },
    { label: '数字', value: 'number' },
    { label: '布尔值', value: 'boolean' },
    { label: '枚举', value: 'enum' },
    { label: 'JSON 数组', value: 'jsonArray' }
] as const

type OutputType = (typeof OUTPUT_TYPES)[number]['value']

export interface StructuredOutputEntry {
    key: string
    type: OutputType
    enumValues?: string
    jsonSchema?: string
    description?: string
}

export interface StructuredOutputBuilderProps {
    inputParam: InputParam
    data: NodeData
    disabled?: boolean
    onDataChange?: (params: { inputParam: InputParam; newValue: unknown }) => void
}

/**
 * Specialized array input for structured output schemas (Agent + LLM nodes).
 * Each entry has a key text field, a type dropdown, optional conditional fields
 * (enum values, JSON schema), and a description field.
 */
export function StructuredOutputBuilder({ inputParam, data, disabled = false, onDataChange }: StructuredOutputBuilderProps) {
    const theme = useTheme()
    const displayLabel = getMetadataDisplayText(inputParam, 'label', '结构化输出')
    const displayDescription = getMetadataDisplayText(inputParam, 'description')
    const displayWarning = getMetadataDisplayText(inputParam, 'warning')
    const childParams = useMemo(() => new Map((inputParam.array ?? []).map((param) => [param.name, param])), [inputParam.array])
    const keyParam = childParams.get('key')
    const typeParam = childParams.get('type')
    const enumValuesParam = childParams.get('enumValues')
    const jsonSchemaParam = childParams.get('jsonSchema')
    const descriptionParam = childParams.get('description')
    const keyLabel = getMetadataDisplayText(keyParam, 'label', '字段名')
    const typeLabel = getMetadataDisplayText(typeParam, 'label', '类型')
    const enumValuesLabel = getMetadataDisplayText(enumValuesParam, 'label', '枚举值')
    const enumValuesDescription = getMetadataDisplayText(enumValuesParam, 'description', '多个枚举值请使用英文逗号分隔')
    const enumValuesPlaceholder = getMetadataDisplayText(enumValuesParam, 'placeholder', '值1, 值2, 值3')
    const jsonSchemaLabel = getMetadataDisplayText(jsonSchemaParam, 'label', 'JSON Schema')
    const jsonSchemaDescription = getMetadataDisplayText(jsonSchemaParam, 'description', '结构化输出使用的 JSON Schema')
    const jsonSchemaPlaceholder = getMetadataDisplayText(
        jsonSchemaParam,
        'placeholder',
        '{ "key": { "type": "string", "description": "..." } }'
    )
    const descriptionLabel = getMetadataDisplayText(descriptionParam, 'label', '说明')
    const descriptionPlaceholder = getMetadataDisplayText(descriptionParam, 'placeholder', '请输入字段说明')
    const outputTypes = useMemo(() => {
        const catalogOptions = typeParam?.options
            ?.filter((option): option is Exclude<(typeof typeParam.options)[number], string> => typeof option !== 'string')
            .map((option) => ({
                label: getMetadataDisplayText(option, 'label', option.label),
                value: option.name as OutputType
            }))
        return catalogOptions?.length ? catalogOptions : OUTPUT_TYPES
    }, [typeParam])

    const entries = useMemo(
        () => (Array.isArray(data.inputs?.[inputParam.name]) ? (data.inputs[inputParam.name] as StructuredOutputEntry[]) : []),
        [data.inputs, inputParam.name]
    )

    const { keys: effectiveKeys, removeKey } = useStableKeys(entries.length, 'output')

    const handleFieldChange = useCallback(
        (index: number, field: string, value: string) => {
            const updated = [...entries]
            const updatedEntry = { ...updated[index], [field]: value }

            // Clear conditional fields when type changes
            if (field === 'type') {
                if (value !== 'enum') updatedEntry.enumValues = ''
                if (value !== 'jsonArray') updatedEntry.jsonSchema = ''
            }

            updated[index] = updatedEntry
            onDataChange?.({ inputParam, newValue: updated })
        },
        [entries, inputParam, onDataChange]
    )

    const handleAddEntry = useCallback(() => {
        const newEntry: StructuredOutputEntry = { key: '', type: 'string', description: '' }
        onDataChange?.({ inputParam, newValue: [...entries, newEntry] })
    }, [entries, inputParam, onDataChange])

    const handleDeleteEntry = useCallback(
        (indexToDelete: number) => {
            removeKey(indexToDelete)
            onDataChange?.({ inputParam, newValue: entries.filter((_, i) => i !== indexToDelete) })
        },
        [entries, inputParam, onDataChange, removeKey]
    )

    const isDeleteVisible = !inputParam.minItems || entries.length > inputParam.minItems
    const isAddDisabled = disabled || (!!inputParam.maxItems && entries.length >= inputParam.maxItems)

    // Expand dialog state for JSON Schema field
    const [expandOpen, setExpandOpen] = useState<{ index: number } | null>(null)

    return (
        <>
            {/* Section header */}
            <Box sx={{ p: 2, pb: 0 }}>
                <Typography>
                    {displayLabel}
                    {displayDescription && <TooltipWithParser title={displayDescription} />}
                    {displayWarning && <TooltipWithParser title={displayWarning} />}
                </Typography>
            </Box>

            {entries.map((entry, index) => (
                <Box
                    key={effectiveKeys[index]}
                    sx={{
                        p: 2,
                        mt: 2,
                        mb: 1,
                        border: 1,
                        borderColor: theme.palette.divider,
                        borderRadius: 2,
                        position: 'relative'
                    }}
                >
                    {/* Delete button */}
                    {isDeleteVisible && (
                        <IconButton
                            title='删除'
                            disabled={disabled}
                            onClick={() => handleDeleteEntry(index)}
                            sx={{
                                position: 'absolute',
                                height: '35px',
                                width: '35px',
                                right: 10,
                                top: 10,
                                '&:hover': { color: theme.palette.error.main }
                            }}
                        >
                            <IconTrash />
                        </IconButton>
                    )}

                    {/* Index chip */}
                    <Chip label={`${index}`} size='small' sx={{ position: 'absolute', right: isDeleteVisible ? 45 : 10, top: 16 }} />

                    {/* Key field */}
                    <Box sx={{ p: 2 }}>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Typography>
                                {keyLabel}
                                <span style={{ color: theme.palette.error.main }}>&nbsp;*</span>
                            </Typography>
                        </div>
                        <TextField
                            fullWidth
                            size='small'
                            value={entry.key}
                            disabled={disabled}
                            onChange={(e) => handleFieldChange(index, 'key', e.target.value)}
                            sx={{ mt: 1 }}
                            data-testid={`key-input-${index}`}
                        />
                    </Box>

                    {/* Type field */}
                    <Box sx={{ p: 2 }}>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Typography>
                                {typeLabel}
                                <span style={{ color: theme.palette.error.main }}>&nbsp;*</span>
                            </Typography>
                        </div>
                        <Select
                            fullWidth
                            size='small'
                            value={entry.type}
                            disabled={disabled}
                            onChange={(e) => handleFieldChange(index, 'type', e.target.value)}
                            sx={{ mt: 1 }}
                            data-testid={`type-select-${index}`}
                        >
                            {outputTypes.map((t) => (
                                <MenuItem key={t.value} value={t.value}>
                                    {t.label}
                                </MenuItem>
                            ))}
                        </Select>
                    </Box>

                    {/* Enum Values — conditional on type === 'enum' */}
                    {entry.type === 'enum' && (
                        <Box sx={{ p: 2 }}>
                            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                                <Typography>{enumValuesLabel}</Typography>
                                <TooltipWithParser title={enumValuesDescription} />
                            </div>
                            <TextField
                                fullWidth
                                size='small'
                                value={entry.enumValues ?? ''}
                                disabled={disabled}
                                onChange={(e) => handleFieldChange(index, 'enumValues', e.target.value)}
                                placeholder={enumValuesPlaceholder}
                                sx={{ mt: 1 }}
                                data-testid={`enum-values-${index}`}
                            />
                        </Box>
                    )}

                    {/* JSON Schema — conditional on type === 'jsonArray' */}
                    {entry.type === 'jsonArray' && (
                        <Box sx={{ p: 2 }}>
                            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                                <Typography>{jsonSchemaLabel}</Typography>
                                <TooltipWithParser title={jsonSchemaDescription} />
                                <div style={{ flexGrow: 1 }} />
                                <IconButton
                                    size='small'
                                    sx={{ height: 25, width: 25 }}
                                    title='展开'
                                    color='primary'
                                    disabled={disabled}
                                    onClick={() => setExpandOpen({ index })}
                                >
                                    <IconArrowsMaximize />
                                </IconButton>
                            </div>
                            <CodeInput
                                value={entry.jsonSchema ?? ''}
                                onChange={(val) => handleFieldChange(index, 'jsonSchema', val)}
                                language='json'
                                disabled={disabled}
                                height='200px'
                            />
                        </Box>
                    )}

                    {/* Description field */}
                    <Box sx={{ p: 2 }}>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Typography>
                                {descriptionLabel}
                                <span style={{ color: theme.palette.error.main }}>&nbsp;*</span>
                            </Typography>
                        </div>
                        <TextField
                            fullWidth
                            size='small'
                            value={entry.description ?? ''}
                            disabled={disabled}
                            onChange={(e) => handleFieldChange(index, 'description', e.target.value)}
                            placeholder={descriptionPlaceholder}
                            sx={{ mt: 1 }}
                            data-testid={`description-input-${index}`}
                        />
                    </Box>
                </Box>
            ))}

            {/* Add button */}
            <Box sx={{ px: 2, pb: 2 }}>
                <Button
                    fullWidth
                    size='small'
                    variant='outlined'
                    disabled={isAddDisabled}
                    sx={{ borderRadius: '16px', mt: 1 }}
                    startIcon={<IconPlus />}
                    onClick={handleAddEntry}
                >
                    添加{displayLabel}
                </Button>
            </Box>

            {/* Expand dialog for JSON Schema */}
            {expandOpen && (
                <ExpandTextDialog
                    open
                    value={entries[expandOpen.index]?.jsonSchema ?? ''}
                    title={jsonSchemaLabel}
                    placeholder={jsonSchemaPlaceholder}
                    disabled={disabled}
                    inputType='code'
                    language='json'
                    onConfirm={(val) => {
                        handleFieldChange(expandOpen.index, 'jsonSchema', val)
                        setExpandOpen(null)
                    }}
                    onCancel={() => setExpandOpen(null)}
                />
            )}
        </>
    )
}
