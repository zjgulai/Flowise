import { useCallback, useMemo, useRef, useState } from 'react'

import { Box, Button, Chip, IconButton, MenuItem, Select, Tooltip, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconArrowsMaximize, IconPlus, IconTrash, IconVariable } from '@tabler/icons-react'

import { getMetadataDisplayText } from '@/core/primitives'
import type { InputParam, NodeData } from '@/core/types'

import { ExpandTextDialog } from './ExpandTextDialog'
import { TooltipWithParser } from './TooltipWithParser'
import { toSuggestionItems } from './toSuggestionItems'
import { useStableKeys } from './useStableKeys'
import { VariableInput } from './VariableInput'
import type { VariableItem } from './VariablePicker'

const MESSAGE_ROLES = [
    { label: '系统', value: 'system' },
    { label: '助手', value: 'assistant' },
    { label: '开发者', value: 'developer' },
    { label: '用户', value: 'user' }
] as const

type MessageRole = (typeof MESSAGE_ROLES)[number]['value']

export interface MessageEntry {
    role: MessageRole | ''
    content: string
}

export interface MessagesInputProps {
    inputParam: InputParam
    data: NodeData
    disabled?: boolean
    /** Variable items for `{{ }}` autocomplete in message content fields. */
    variableItems?: VariableItem[]
    onDataChange?: (params: { inputParam: InputParam; newValue: unknown }) => void
}

/**
 * Specialized array input for message entries (Agent + LLM nodes).
 * Each entry has a role dropdown (system/assistant/developer/user)
 * and a multiline content textarea with variable support ({{ variable }} syntax).
 */
export function MessagesInput({ inputParam, data, disabled = false, variableItems, onDataChange }: MessagesInputProps) {
    const theme = useTheme()
    const displayLabel = getMetadataDisplayText(inputParam, 'label', '消息')
    const displayDescription = getMetadataDisplayText(inputParam, 'description')
    const displayWarning = getMetadataDisplayText(inputParam, 'warning')
    const roleParam = inputParam.array?.find((param) => param.name === 'role')
    const contentParam = inputParam.array?.find((param) => param.name === 'content')
    const roleLabel = getMetadataDisplayText(roleParam, 'label', '角色')
    const contentLabel = getMetadataDisplayText(contentParam, 'label', '内容')
    const displayPlaceholder = getMetadataDisplayText(
        contentParam,
        'placeholder',
        getMetadataDisplayText(inputParam, 'placeholder', '消息内容（支持 {{ variable }} 语法）')
    )
    const roleOptions = useMemo(() => {
        const catalogOptions = roleParam?.options
            ?.filter((option): option is Exclude<(typeof roleParam.options)[number], string> => typeof option !== 'string')
            .map((option) => ({
                label: getMetadataDisplayText(option, 'label', option.label),
                value: option.name as MessageRole
            }))
        return catalogOptions?.length ? catalogOptions : MESSAGE_ROLES
    }, [roleParam])

    const messages = useMemo(
        () => (Array.isArray(data.inputs?.[inputParam.name]) ? (data.inputs[inputParam.name] as MessageEntry[]) : []),
        [data.inputs, inputParam.name]
    )

    const { keys: effectiveKeys, removeKey } = useStableKeys(messages.length, 'message')

    const suggestionItems = useMemo(() => toSuggestionItems(variableItems), [variableItems])

    const handleRoleChange = useCallback(
        (index: number, role: string) => {
            const updated = [...messages]
            updated[index] = { ...updated[index], role: role as MessageRole }
            onDataChange?.({ inputParam, newValue: updated })
        },
        [messages, inputParam, onDataChange]
    )

    // Track latest inline content locally so the expand dialog always has fresh values,
    // even if the parent hasn't round-tripped onDataChange back into data yet.
    // Keyed by item key values so deletes are a simple Map.delete() with no index rebasing.
    const latestContentRef = useRef<Map<string, string>>(new Map())

    const handleContentChange = useCallback(
        (index: number, content: string) => {
            latestContentRef.current.set(effectiveKeys[index], content)
            const updated = [...messages]
            updated[index] = { ...updated[index], content }
            onDataChange?.({ inputParam, newValue: updated })
        },
        [effectiveKeys, messages, inputParam, onDataChange]
    )

    const handleAddMessage = useCallback(() => {
        const newMessage: MessageEntry = { role: '', content: '' }
        onDataChange?.({ inputParam, newValue: [...messages, newMessage] })
    }, [messages, inputParam, onDataChange])

    const handleDeleteMessage = useCallback(
        (indexToDelete: number) => {
            latestContentRef.current.delete(effectiveKeys[indexToDelete])
            removeKey(indexToDelete)
            onDataChange?.({ inputParam, newValue: messages.filter((_, i) => i !== indexToDelete) })
        },
        [effectiveKeys, messages, inputParam, onDataChange, removeKey]
    )

    // Expand dialog state
    const [expandIndex, setExpandIndex] = useState<number | null>(null)

    const handleExpandOpen = useCallback((index: number) => {
        setExpandIndex(index)
    }, [])

    const handleExpandConfirm = useCallback(
        (value: string) => {
            if (expandIndex !== null) {
                latestContentRef.current.set(effectiveKeys[expandIndex], value)
                handleContentChange(expandIndex, value)
            }
            setExpandIndex(null)
        },
        [effectiveKeys, expandIndex, handleContentChange]
    )

    const handleExpandCancel = useCallback(() => {
        setExpandIndex(null)
    }, [])

    const isDeleteVisible = !inputParam.minItems || messages.length > inputParam.minItems
    const isAddDisabled = disabled || (!!inputParam.maxItems && messages.length >= inputParam.maxItems)

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

            {messages.map((message, index) => (
                <Box
                    key={effectiveKeys[index]}
                    sx={{
                        p: 2,
                        mx: 2,
                        mt: 2,
                        mb: 1,
                        border: 1,
                        borderColor: theme.palette.divider,
                        borderRadius: 2,
                        position: 'relative'
                    }}
                >
                    {/* Delete button — hidden (not just disabled) when at minItems */}
                    {isDeleteVisible && (
                        <IconButton
                            title='删除'
                            disabled={disabled}
                            onClick={() => handleDeleteMessage(index)}
                            sx={{
                                position: 'absolute',
                                height: '35px',
                                width: '35px',
                                right: 10,
                                top: 10,
                                '&:hover': { color: 'red' }
                            }}
                        >
                            <IconTrash />
                        </IconButton>
                    )}

                    {/* Index chip */}
                    <Chip label={`${index}`} size='small' sx={{ position: 'absolute', right: isDeleteVisible ? 45 : 10, top: 16 }} />

                    {/* Role field */}
                    <Box sx={{ p: 2 }}>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Typography>
                                {roleLabel}
                                <span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                        </div>
                        <Select
                            fullWidth
                            size='small'
                            value={message.role}
                            disabled={disabled}
                            onChange={(e) => handleRoleChange(index, e.target.value)}
                            sx={{ mt: 1 }}
                            data-testid={`role-select-${index}`}
                        >
                            {roleOptions.map((role) => (
                                <MenuItem key={role.value} value={role.value}>
                                    {role.label}
                                </MenuItem>
                            ))}
                        </Select>
                    </Box>

                    {/* Content field */}
                    <Box sx={{ p: 2 }}>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Typography>
                                {contentLabel}
                                <span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                            <div style={{ flexGrow: 1 }} />
                            <Tooltip title='输入 {{ 可选择变量'>
                                <span style={{ display: 'inline-flex' }}>
                                    <IconVariable size={20} style={{ color: 'teal' }} />
                                </span>
                            </Tooltip>
                            <IconButton
                                size='small'
                                sx={{ height: 25, width: 25, ml: 0.5 }}
                                title='展开'
                                color='primary'
                                disabled={disabled}
                                onClick={() => handleExpandOpen(index)}
                            >
                                <IconArrowsMaximize />
                            </IconButton>
                        </div>
                        <VariableInput
                            value={message.content}
                            onChange={(v) => handleContentChange(index, v)}
                            placeholder={displayPlaceholder}
                            disabled={disabled}
                            rows={4}
                            suggestionItems={suggestionItems}
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
                    onClick={handleAddMessage}
                >
                    添加{displayLabel}
                </Button>
            </Box>

            {/* Expand content dialog — conditionally mounted so it always initializes fresh */}
            {expandIndex !== null && (
                <ExpandTextDialog
                    open={true}
                    value={latestContentRef.current.get(effectiveKeys[expandIndex]) ?? messages[expandIndex]?.content ?? ''}
                    title={contentLabel}
                    placeholder={displayPlaceholder}
                    disabled={disabled}
                    inputType='string'
                    suggestionItems={suggestionItems}
                    onConfirm={handleExpandConfirm}
                    onCancel={handleExpandCancel}
                />
            )}
        </>
    )
}
