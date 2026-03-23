import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const requiredBuildOutputs = [
  path.join(projectRoot, 'out', 'main', 'index.cjs'),
  path.join(projectRoot, 'out', 'preload', 'index.cjs'),
  path.join(projectRoot, 'out', 'renderer', 'index.html'),
]
const bundledOpenClawDir = path.join(projectRoot, 'resources', 'openclaw')
const requiredBundledOpenClawOutputs = [
  path.join(bundledOpenClawDir, 'node_modules', 'openclaw'),
  path.join(bundledOpenClawDir, 'node_modules', 'openclaw', 'openclaw.mjs'),
]

function ensureBuildOutputs() {
  const missingOutputs = requiredBuildOutputs.filter((filePath) => !existsSync(filePath))

  if (missingOutputs.length === 0) {
    return
  }

  const result = spawnSync('pnpm', ['build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  const stillMissing = requiredBuildOutputs.filter((filePath) => !existsSync(filePath))
  if (stillMissing.length > 0) {
    throw new Error(`Build completed but required output is missing: ${stillMissing.join(', ')}`)
  }
}

function ensureBundledOpenClawRuntime() {
  const missingOutputs = requiredBundledOpenClawOutputs.filter((filePath) => !existsSync(filePath))

  if (missingOutputs.length === 0) {
    return
  }

  const installCommands = [
    ['ci'],
    ['install'],
  ]

  for (const args of installCommands) {
    const result = spawnSync('npm', args, {
      cwd: bundledOpenClawDir,
      stdio: 'inherit',
      env: process.env,
    })

    if (result.error) {
      throw result.error
    }

    if (result.status === 0) {
      const stillMissing = requiredBundledOpenClawOutputs.filter((filePath) => !existsSync(filePath))
      if (stillMissing.length === 0) {
        return
      }
    }
  }

  const stillMissing = requiredBundledOpenClawOutputs.filter((filePath) => !existsSync(filePath))
  if (stillMissing.length > 0) {
    throw new Error(`Bundled OpenClaw runtime is still missing after npm install attempts: ${stillMissing.join(', ')}`)
  }
}

function resolveElectronExecutable() {
  try {
    const executablePath = require('electron')

    if (!existsSync(executablePath)) {
      throw new Error(`Resolved Electron binary does not exist: ${executablePath}`)
    }

    return executablePath
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Electron binary is not available in this install.',
        `Details: ${detail}`,
        'Fix by reinstalling Electron assets:',
        '  pnpm rebuild electron',
        'If that still fails, run:',
        '  rm -rf node_modules pnpm-lock.yaml && pnpm install',
      ].join('\n'),
      { cause: error instanceof Error ? error : undefined },
    )
  }
}

const executablePath = resolveElectronExecutable()
ensureBuildOutputs()
ensureBundledOpenClawRuntime()

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(executablePath, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
