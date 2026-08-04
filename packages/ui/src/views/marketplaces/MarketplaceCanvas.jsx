import { useEffect, useRef, useState } from 'react'
import ReactFlow, { Controls, Background, useNodesState, useEdgesState } from 'reactflow'
import 'reactflow/dist/style.css'
import '@/views/canvas/index.css'

import { useLocation, useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'

// material-ui
import { Toolbar, Box, AppBar } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import MarketplaceCanvasNode from './MarketplaceCanvasNode'
import MarketplaceCanvasHeader from './MarketplaceCanvasHeader'
import StickyNote from '../canvas/StickyNote'
import nodesApi from '@/api/nodes'
import useApi from '@/hooks/useApi'
import { SET_COMPONENT_NODES } from '@/store/actions'

// icons
import { IconMagnetFilled, IconMagnetOff, IconArtboard, IconArtboardOff } from '@tabler/icons-react'

const nodeTypes = { customNode: MarketplaceCanvasNode, stickyNote: StickyNote }
const edgeTypes = { buttonedge: '' }

// ==============================|| CANVAS ||============================== //

const MarketplaceCanvas = () => {
    const theme = useTheme()
    const navigate = useNavigate()
    const customization = useSelector((state) => state.customization)
    const dispatch = useDispatch()
    const getNodesApi = useApi(nodesApi.getAllNodes)

    const { state } = useLocation()
    const { flowData, name } = state

    // ==============================|| ReactFlow ||============================== //

    const [nodes, setNodes, onNodesChange] = useNodesState()
    const [edges, setEdges, onEdgesChange] = useEdgesState()
    const [isSnappingEnabled, setIsSnappingEnabled] = useState(false)
    const [isBackgroundEnabled, setIsBackgroundEnabled] = useState(true)

    const reactFlowWrapper = useRef(null)

    // ==============================|| useEffect ||============================== //

    useEffect(() => {
        if (flowData) {
            const initialFlow = JSON.parse(flowData)
            setNodes(initialFlow.nodes || [])
            setEdges(initialFlow.edges || [])
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flowData])

    useEffect(() => {
        getNodesApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getNodesApi.data) dispatch({ type: SET_COMPONENT_NODES, componentNodes: getNodesApi.data })
    }, [dispatch, getNodesApi.data])

    const onChatflowCopy = (flowData) => {
        const isAgentCanvas = (flowData?.nodes || []).some(
            (node) => node.data.category === 'Multi Agents' || node.data.category === 'Sequential Agents'
        )
        const templateFlowData = JSON.stringify(flowData)
        navigate(`/${isAgentCanvas ? 'agentcanvas' : 'canvas'}`, { state: { templateFlowData } })
    }

    return (
        <>
            <Box>
                <AppBar
                    enableColorOnDark
                    position='fixed'
                    color='inherit'
                    elevation={1}
                    sx={{
                        bgcolor: theme.palette.background.default
                    }}
                >
                    <Toolbar>
                        <MarketplaceCanvasHeader
                            flowName={name}
                            flowData={JSON.parse(flowData)}
                            onChatflowCopy={(flowData) => onChatflowCopy(flowData)}
                        />
                    </Toolbar>
                </AppBar>
                <Box sx={{ pt: '70px', height: '100vh', width: '100%' }}>
                    <div className='reactflow-parent-wrapper'>
                        <div className='reactflow-wrapper' ref={reactFlowWrapper}>
                            <ReactFlow
                                nodes={nodes}
                                edges={edges}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgesChange}
                                nodesDraggable={false}
                                nodeTypes={nodeTypes}
                                edgeTypes={edgeTypes}
                                fitView
                                minZoom={0.1}
                                snapGrid={[25, 25]}
                                snapToGrid={isSnappingEnabled}
                            >
                                <Controls
                                    className={customization.isDarkMode ? 'dark-mode-controls' : ''}
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'row',
                                        left: '50%',
                                        transform: 'translate(-50%, -50%)'
                                    }}
                                >
                                    <button
                                        className='react-flow__controls-button react-flow__controls-interactive'
                                        onClick={() => {
                                            setIsSnappingEnabled(!isSnappingEnabled)
                                        }}
                                        title='切换吸附'
                                        aria-label='切换吸附'
                                    >
                                        {isSnappingEnabled ? <IconMagnetFilled /> : <IconMagnetOff />}
                                    </button>
                                    <button
                                        className='react-flow__controls-button react-flow__controls-interactive'
                                        onClick={() => {
                                            setIsBackgroundEnabled(!isBackgroundEnabled)
                                        }}
                                        title='切换背景'
                                        aria-label='切换背景'
                                    >
                                        {isBackgroundEnabled ? <IconArtboard /> : <IconArtboardOff />}
                                    </button>
                                </Controls>
                                {isBackgroundEnabled && <Background color='#aaa' gap={16} />}
                            </ReactFlow>
                        </div>
                    </div>
                </Box>
            </Box>
        </>
    )
}

export default MarketplaceCanvas
