const { existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const nativeDir = __dirname

const platformMap = {
  'win32-x64': 'win32-x64-msvc',
  'win32-arm64': 'win32-arm64-msvc',
  'darwin-x64': ['darwin-universal', 'darwin-x64'],
  'darwin-arm64': ['darwin-universal', 'darwin-arm64'],
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu'
}

const requiredExports = [
  'initializeAppStorage',
  'listCustomHeaderSchemes',
  'upsertCustomHeaderScheme',
  'deleteCustomHeaderScheme',
  'reorderWorkspaceDirectories',
  'deleteWorkspaceDirectory',
  'listCheckpointDiffs',
  'restoreCheckpoints',
  'listCheckpointChangesBatch',
  'listCheckpointDiffsBatch',
  'listChatMessagesPaginated',
  'cancelRunningSubAgentSessions'
]

const platformName = platformMap[`${process.platform}-${process.arch}`]
const nodeFiles = readdirSync(nativeDir)
  .filter((file) => file.endsWith('.node'))
  .map((file) => join(nativeDir, file))

const platformNames = platformName
  ? Array.isArray(platformName)
    ? platformName
    : [platformName]
  : []
const platformCandidates = platformNames.length
  ? nodeFiles
      .filter((file) => platformNames.some((name) => file.includes(`snow_native.${name}`)))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  : []

const candidates = [
  ...platformCandidates,
  ...nodeFiles.filter((file) => !platformCandidates.includes(file))
]

const loadErrors = []
let nativeBinding = null

for (const candidate of candidates) {
  if (!existsSync(candidate)) {
    continue
  }

  try {
    const binding = require(candidate)
    const missingExports = requiredExports.filter(
      (exportName) => typeof binding[exportName] !== 'function'
    )

    if (missingExports.length > 0) {
      loadErrors.push(
        new Error(
          `${candidate} is missing native exports: ${missingExports.join(', ')}`
        )
      )
      continue
    }

    nativeBinding = binding
    break
  } catch (error) {
    loadErrors.push(error)
  }
}

if (!nativeBinding) {
  const hint =
    loadErrors.length > 0
      ? ` Last error: ${loadErrors[loadErrors.length - 1].message}`
      : ''
  throw new Error(
    `Unable to locate compiled snow_native *.node binding. Run npm run build:rust.${hint}`
  )
}

module.exports = nativeBinding
