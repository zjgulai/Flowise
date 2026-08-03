import { useState, useEffect, useContext, Fragment } from 'react'
import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'
import axios from 'axios'

// Material
import Autocomplete, { autocompleteClasses, createFilterOptions } from '@mui/material/Autocomplete'
import { Popper, CircularProgress, TextField, Box, Typography, Tooltip } from '@mui/material'
import { useTheme, styled } from '@mui/material/styles'

// API
import credentialsApi from '@/api/credentials'

// const
import { baseURL } from '@/store/constant'
import { flowContext } from '@/store/context/ReactFlowContext'
import { getAvailableNodesForVariable } from '@/utils/genericHelper'
import { getMetadataDisplayText, getMetadataOptionSearchText } from '@/utils/componentMetadataDisplay'

const filterMetadataOptions = createFilterOptions({ stringify: getMetadataOptionSearchText })
const LOAD_STATUS = {
    IDLE: 'idle',
    LOADING: 'loading',
    READY: 'ready',
    EMPTY: 'empty',
    ERROR: 'error'
}
const EMPTY_OPTIONS_MESSAGE = '暂无可用选项'
const LOAD_OPTIONS_ERROR_MESSAGE = '加载选项失败，请稍后重试'
const SAFE_COMPONENT_NAME = /^[A-Za-z0-9_-]{1,128}$/

export const buildNodeLoadMethodUrl = (nodeName) => {
    if (typeof nodeName !== 'string' || !SAFE_COMPONENT_NAME.test(nodeName)) {
        throw new Error('invalid component name')
    }
    return `${baseURL}/api/v1/node-load-method/${encodeURIComponent(nodeName)}`
}

export const parseAsyncMultiValue = (value) => {
    if (Array.isArray(value)) return value
    if (value === 'choose an option' || typeof value !== 'string' || value.length === 0) return []
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

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

const fetchList = async ({ name, nodeData, previousNodes, currentNode }) => {
    const selectedParam = nodeData.inputParams.find((param) => param.name === name)
    const loadMethod = selectedParam?.loadMethod

    let credentialId = nodeData.credential
    if (!credentialId && (nodeData.inputs?.credential || nodeData.inputs?.['FLOWISE_CREDENTIAL_ID'])) {
        credentialId = nodeData.inputs.credential || nodeData.inputs?.['FLOWISE_CREDENTIAL_ID']
    }

    const config = {
        headers: {
            'x-request-from': 'internal',
            'Content-type': 'application/json'
        },
        withCredentials: true
    }

    const response = await axios.post(
        buildNodeLoadMethodUrl(nodeData.name),
        { ...nodeData, loadMethod, previousNodes, currentNode, credential: credentialId },
        config
    )
    return Array.isArray(response.data) ? response.data : []
}

export const AsyncDropdown = ({
    name,
    nodeData,
    value,
    onSelect,
    isCreateNewOption,
    onCreateNew,
    credentialNames = [],
    disabled = false,
    freeSolo = false,
    disableClearable = false,
    multiple = false,
    fullWidth = false
}) => {
    const customization = useSelector((state) => state.customization)
    const theme = useTheme()

    const [open, setOpen] = useState(false)
    const [options, setOptions] = useState([])
    const [loading, setLoading] = useState(false)
    const [loadStatus, setLoadStatus] = useState(LOAD_STATUS.IDLE)
    const findMatchingOptions = (options = [], value) => {
        if (multiple) {
            const values = parseAsyncMultiValue(value)
            return options.filter((option) => values.includes(option.name))
        }
        return options.find((option) => option.name === value)
    }
    const getDefaultOptionValue = () => (multiple ? [] : '')
    const addNewOption = [{ label: '- 新建 -', name: '-create-' }]
    let [internalValue, setInternalValue] = useState(value ?? 'choose an option')
    const { reactFlowInstance } = useContext(flowContext)

    const fetchCredentialList = async () => {
        let names = ''
        if (credentialNames.length > 1) {
            names = credentialNames.join('&credentialName=')
        } else {
            names = credentialNames[0]
        }
        const resp = await credentialsApi.getCredentialsByName(names)
        if (!Array.isArray(resp.data)) return []

        return resp.data.map((credential) => ({
            label: credential.name,
            name: credential.id
        }))
    }

    useEffect(() => {
        let active = true

        const fetchData = async () => {
            setLoading(true)
            setLoadStatus(LOAD_STATUS.LOADING)
            try {
                let response = []
                if (credentialNames.length) {
                    response = await fetchCredentialList()
                } else {
                    const body = {
                        name,
                        nodeData
                    }
                    if (reactFlowInstance) {
                        const previousNodes = getAvailableNodesForVariable(
                            reactFlowInstance.getNodes(),
                            reactFlowInstance.getEdges(),
                            nodeData.id,
                            `${nodeData.id}-input-${name}-${nodeData.inputParams.find((param) => param.name === name)?.type || ''}`,
                            true
                        ).map((node) => ({ id: node.id, name: node.data.name, label: node.data.label, inputs: node.data.inputs }))

                        let currentNode = reactFlowInstance.getNodes().find((node) => node.id === nodeData.id)
                        if (currentNode) {
                            currentNode = {
                                id: currentNode.id,
                                name: currentNode.data.name,
                                label: currentNode.data.label,
                                inputs: currentNode.data.inputs
                            }
                            body.currentNode = currentNode
                        }

                        body.previousNodes = previousNodes
                    }

                    response = await fetchList(body)
                }

                if (!active) return

                const loadedOptions = response.map((option) =>
                    option.imageSrc ? { ...option, imageSrc: `${baseURL}/api/v1/node-icon/${encodeURIComponent(option.name)}` } : option
                )
                setOptions(isCreateNewOption ? [...loadedOptions, ...addNewOption] : loadedOptions)
                setLoadStatus(loadedOptions.length ? LOAD_STATUS.READY : LOAD_STATUS.EMPTY)
            } catch {
                if (!active) return
                setOptions(isCreateNewOption ? [...addNewOption] : [])
                setLoadStatus(LOAD_STATUS.ERROR)
            } finally {
                if (active) setLoading(false)
            }
        }

        fetchData()

        return () => {
            active = false
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const loadMessage =
        loadStatus === LOAD_STATUS.ERROR ? LOAD_OPTIONS_ERROR_MESSAGE : loadStatus === LOAD_STATUS.EMPTY ? EMPTY_OPTIONS_MESSAGE : ''

    return (
        <>
            <Autocomplete
                id={name}
                freeSolo={freeSolo}
                disabled={disabled}
                disableClearable={disableClearable}
                multiple={multiple}
                filterSelectedOptions={multiple}
                size='small'
                sx={{ mt: 1, width: fullWidth ? '100%' : multiple ? '90%' : '100%' }}
                open={open}
                onOpen={() => {
                    setOpen(true)
                }}
                onClose={() => {
                    setOpen(false)
                }}
                options={options}
                noOptionsText={loadStatus === LOAD_STATUS.ERROR ? LOAD_OPTIONS_ERROR_MESSAGE : EMPTY_OPTIONS_MESSAGE}
                filterOptions={filterMetadataOptions}
                getOptionLabel={(option) =>
                    typeof option === 'string' ? option : getMetadataDisplayText(option, 'label', option.label || option.name || '')
                }
                value={findMatchingOptions(options, internalValue) || getDefaultOptionValue()}
                onChange={(e, selection) => {
                    if (multiple) {
                        let value = ''
                        if (selection.length) {
                            const selectionNames = selection.map((item) => item.name)
                            value = JSON.stringify(selectionNames)
                        }
                        setInternalValue(value)
                        onSelect(value)
                    } else {
                        const value = selection ? selection.name : ''
                        if (isCreateNewOption && value === '-create-') {
                            onCreateNew()
                        } else {
                            setInternalValue(value)
                            onSelect(value)
                        }
                    }
                }}
                PopperComponent={StyledPopper}
                loading={loading}
                renderInput={(params) => {
                    const matchingOptions = multiple
                        ? findMatchingOptions(options, internalValue)
                        : [findMatchingOptions(options, internalValue)].filter(Boolean)

                    const textField = (
                        <TextField
                            {...params}
                            value={internalValue}
                            error={loadStatus === LOAD_STATUS.ERROR}
                            helperText={loadMessage || params.helperText}
                            FormHelperTextProps={{
                                ...(params.FormHelperTextProps || {}),
                                role: loadStatus === LOAD_STATUS.ERROR ? 'alert' : 'status'
                            }}
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
                                startAdornment: (
                                    <>
                                        {matchingOptions.map((option) =>
                                            option?.imageSrc ? (
                                                <Box
                                                    key={option.name}
                                                    component='img'
                                                    src={option.imageSrc}
                                                    alt={getMetadataDisplayText(option, 'label', option.label || '已选选项')}
                                                    sx={{
                                                        width: 32,
                                                        height: 32,
                                                        borderRadius: '50%',
                                                        marginRight: 0.5
                                                    }}
                                                />
                                            ) : null
                                        )}
                                        {params.InputProps.startAdornment}
                                    </>
                                ),
                                endAdornment: (
                                    <Fragment>
                                        {loading ? <CircularProgress color='inherit' size={20} /> : null}
                                        {params.InputProps.endAdornment}
                                    </Fragment>
                                )
                            }}
                        />
                    )

                    return !multiple ? (
                        textField
                    ) : (
                        <Tooltip title={parseAsyncMultiValue(internalValue).join(', ')} placement='top' arrow>
                            {textField}
                        </Tooltip>
                    )
                }}
                renderOption={(props, option) => (
                    <Box component='li' {...props} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {option.imageSrc && (
                            <img
                                src={option.imageSrc}
                                alt={getMetadataDisplayText(option, 'description', option.description)}
                                style={{
                                    width: 30,
                                    height: 30,
                                    padding: 1,
                                    borderRadius: '50%'
                                }}
                            />
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography variant='h5'>{getMetadataDisplayText(option, 'label', option.label)}</Typography>
                            {option.description && (
                                <Typography sx={{ color: customization.isDarkMode ? '#9e9e9e' : '' }}>
                                    {getMetadataDisplayText(option, 'description', option.description)}
                                </Typography>
                            )}
                        </div>
                    </Box>
                )}
            />
        </>
    )
}

AsyncDropdown.propTypes = {
    name: PropTypes.string,
    nodeData: PropTypes.object,
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.array, PropTypes.object]),
    onSelect: PropTypes.func,
    onCreateNew: PropTypes.func,
    disabled: PropTypes.bool,
    freeSolo: PropTypes.bool,
    credentialNames: PropTypes.array,
    disableClearable: PropTypes.bool,
    isCreateNewOption: PropTypes.bool,
    multiple: PropTypes.bool,
    fullWidth: PropTypes.bool
}
