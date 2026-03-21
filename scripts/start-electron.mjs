import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const electronPackageDir = path.join(
  projectRoot,
  'node_modules',
  '.pnpm',
  'electron@41.0.3',
  'node_modules',
  'electron',
)
const pathFile = path.join(electronPackageDir, 'path.txt')

if (!existsSync(pathFile)) {
  throw new Error(`Electron path.txt not found: ${pathFile}`)
}

const executableRelativePath = readFileSync(pathFile, 'utf-8').trim()
const executablePath = path.join(electronPackageDir, 'dist', executableRelativePath)

if (!existsSync(executablePath)) {
  throw new Error(`Electron binary not found: ${executablePath}`)
}

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
