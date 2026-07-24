#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs'

const fail = (message) => {
    process.stderr.write(`Docker Hub immutability verification failed: ${message}\n`)
    process.exit(1)
}

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) fail('invalid arguments')
    values.set(key, value)
}

const repository = values.get('--repository')
const gitTag = values.get('--git-tag')
const releaseTag = values.get('--release-tag')
const settingsPath = values.get('--settings')

if (values.size !== 4 || !repository || !gitTag || !releaseTag || !settingsPath) fail('missing required arguments')
if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository)) fail('repository is invalid')
if (!/^git-[0-9a-f]{40}$/.test(gitTag)) fail('Git tag is invalid')
if (!/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/.test(releaseTag)) {
    fail('release tag is invalid')
}

let stat
try {
    stat = lstatSync(settingsPath)
} catch {
    fail('repository settings evidence is unavailable')
}
if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 131_072) fail('repository settings evidence is invalid')

let document
try {
    document = JSON.parse(readFileSync(settingsPath, 'utf8'))
} catch {
    fail('repository settings evidence is not valid JSON')
}

if (document?.namespace !== repository.split('/')[0] || document?.name !== repository.split('/')[1]) {
    fail('repository settings evidence targets another repository')
}

const settings = document?.immutable_tags_settings
if (settings?.enabled !== true || !Array.isArray(settings.rules)) fail('server-side immutable tags are not enabled')

const rules = settings.rules
if (rules.length > 32 || rules.some((rule) => typeof rule !== 'string' || rule.length === 0 || rule.length > 512)) {
    fail('immutable tag rules are invalid')
}
// Docker Hub evaluates selective rules with Go RE2 semantics. Reinterpreting
// those expressions with JavaScript RegExp can disagree with the registry and
// can introduce catastrophic backtracking. Require the unambiguous server-side
// policy instead: enabled immutability with no selective rules means every tag
// in this dedicated release repository is immutable.
if (rules.length !== 0) fail('repository must enforce immutability for all tags')

process.stdout.write(`Docker Hub server-side immutability verified for ${repository}: ${gitTag}, ${releaseTag}\n`)
