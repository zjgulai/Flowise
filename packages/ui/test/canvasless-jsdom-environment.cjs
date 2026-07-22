const Module = require('node:module')

const originalLoad = Module._load
const originalResolveFilename = Module._resolveFilename
const canvasPath = originalResolveFilename.call(Module, 'canvas', module, false)
require.cache[canvasPath] = {
    id: canvasPath,
    filename: canvasPath,
    loaded: true,
    exports: {},
    children: [],
    paths: []
}
Module._resolveFilename = function resolveWithoutOptionalCanvas(request, parent, isMain, options) {
    if (request === 'canvas') {
        const error = new Error("Cannot find module 'canvas'")
        error.code = 'MODULE_NOT_FOUND'
        throw error
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
Module._load = function loadWithoutOptionalCanvas(request, parent, isMain) {
    if (request === 'canvas') return {}
    return originalLoad.call(this, request, parent, isMain)
}

let JsdomEnvironment
try {
    JsdomEnvironment = require('jest-environment-jsdom').TestEnvironment
} finally {
    Module._load = originalLoad
    Module._resolveFilename = originalResolveFilename
}

module.exports = JsdomEnvironment
