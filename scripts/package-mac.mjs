import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const electronApp = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
const outputDir = path.join(repoRoot, 'dist', 'mac')
const outputApp = path.join(outputDir, 'QClaw.app')
const outputResources = path.join(outputApp, 'Contents', 'Resources')
const outputMacOSDir = path.join(outputApp, 'Contents', 'MacOS')
const appPayload = path.join(outputResources, 'app')
const bundledOpenClawOutput = path.join(outputResources, 'openclaw')
const plistPath = path.join(outputApp, 'Contents', 'Info.plist')
const electronPackageJsonPath = path.join(repoRoot, 'node_modules', 'electron', 'package.json')

const sourceIconPng = path.join(repoRoot, 'src', 'renderer', 'assets', 'qm-icon.png')
const legacyAppIconIcns = path.join(
  repoRoot,
  '..',
  'QClaw-old',
  'src',
  'v0.1.1',
  'dist',
  'mac',
  'QClaw.app',
  'Contents',
  'Resources',
  'electron.icns',
)
const iconDir = path.join(repoRoot, 'resources', 'icons', 'app', 'mac')
const iconSetDir = path.join(iconDir, 'icon.iconset')
const iconIcnsPath = path.join(iconDir, 'icon.icns')
const bundleIconPath = path.join(outputResources, 'electron.icns')
const bundledOpenClawSource = path.join(repoRoot, 'resources', 'openclaw')

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  })

  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}`)
  }
}

function cleanDir(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true })
      return
    }

    const fallbackPath = `${targetPath}.stale-${Date.now()}`
    fs.renameSync(targetPath, fallbackPath)
    fs.rmSync(fallbackPath, { recursive: true, force: true })
  }
  fs.mkdirSync(targetPath, { recursive: true })
}

function copyRepoPayload() {
  fs.mkdirSync(appPayload, { recursive: true })

  for (const entry of fs.readdirSync(repoRoot)) {
    if (entry === 'dist' || entry === '.git' || entry === '.DS_Store') continue
    const src = path.join(repoRoot, entry)
    const dest = path.join(appPayload, entry)
    run('ditto', [src, dest])
  }
}

function copyBundledOpenClaw() {
  ensureExists(bundledOpenClawSource, 'Bundled OpenClaw resources')
  fs.rmSync(bundledOpenClawOutput, { recursive: true, force: true })
  run('ditto', [bundledOpenClawSource, bundledOpenClawOutput])
}

function renderIconVariant(filename, size) {
  run('sips', ['-z', String(size), String(size), sourceIconPng, '--out', path.join(iconSetDir, filename)])
}

function buildIcns() {
  if (fs.existsSync(iconIcnsPath)) {
    return
  }

  if (fs.existsSync(legacyAppIconIcns)) {
    fs.mkdirSync(iconDir, { recursive: true })
    fs.copyFileSync(legacyAppIconIcns, iconIcnsPath)
    return
  }

  ensureExists(sourceIconPng, 'Source icon')
  fs.mkdirSync(iconDir, { recursive: true })
  fs.rmSync(iconSetDir, { recursive: true, force: true })
  run('iconutil', ['-c', 'iconset', path.join(electronApp, 'Contents', 'Resources', 'electron.icns'), '-o', iconSetDir])

  renderIconVariant('icon_16x16.png', 16)
  renderIconVariant('icon_16x16@2x.png', 32)
  renderIconVariant('icon_32x32.png', 32)
  renderIconVariant('icon_32x32@2x.png', 64)
  renderIconVariant('icon_128x128.png', 128)
  renderIconVariant('icon_128x128@2x.png', 256)
  renderIconVariant('icon_256x256.png', 256)
  renderIconVariant('icon_256x256@2x.png', 512)
  renderIconVariant('icon_512x512.png', 512)
  renderIconVariant('icon_512x512@2x.png', 1024)

  fs.rmSync(iconIcnsPath, { force: true })
  run('iconutil', ['-c', 'icns', iconSetDir, '-o', iconIcnsPath])
}

function replaceBundleIcon() {
  ensureExists(iconIcnsPath, 'Generated icns icon')
  fs.copyFileSync(iconIcnsPath, bundleIconPath)
}

function renameBundleExecutable() {
  const sourceExecutablePath = path.join(outputMacOSDir, 'Electron')
  const targetExecutablePath = path.join(outputMacOSDir, 'QClaw')

  ensureExists(sourceExecutablePath, 'Bundle executable')
  fs.rmSync(targetExecutablePath, { force: true })
  fs.renameSync(sourceExecutablePath, targetExecutablePath)
}

function patchInfoPlist() {
  let plist = fs.readFileSync(plistPath, 'utf8')
  plist = plist.replace(
    /<key>CFBundleDisplayName<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleDisplayName</key>\n\t<string>QClaw</string>',
  )
  plist = plist.replace(
    /<key>CFBundleName<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleName</key>\n\t<string>QClaw</string>',
  )
  plist = plist.replace(
    /<key>CFBundleIdentifier<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleIdentifier</key>\n\t<string>com.tencent.qclaw</string>',
  )
  plist = plist.replace(
    /<key>CFBundleExecutable<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleExecutable</key>\n\t<string>QClaw</string>',
  )
  plist = plist.replace(
    /<key>CFBundleShortVersionString<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleShortVersionString</key>\n\t<string>0.1.1</string>',
  )
  plist = plist.replace(
    /<key>CFBundleVersion<\/key>\s*<string>[^<]+<\/string>/,
    '<key>CFBundleVersion</key>\n\t<string>0.1.1</string>',
  )

  fs.writeFileSync(plistPath, plist)
}

function buildAppSources() {
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  run(pnpmCommand, ['build'], { cwd: repoRoot })
}

function verifyPackagedEntry() {
  ensureExists(path.join(appPayload, 'out', 'main', 'index.cjs'), 'Packaged main entry')
  ensureExists(path.join(appPayload, 'out', 'preload', 'index.cjs'), 'Packaged preload entry')
  ensureExists(path.join(bundledOpenClawOutput, 'config', 'openclaw.json'), 'Bundled OpenClaw config')
  ensureExists(path.join(bundledOpenClawOutput, 'node_modules', 'openclaw', 'openclaw.mjs'), 'Bundled OpenClaw entry')
  ensureExists(bundleIconPath, 'Bundled app icon')
  ensureExists(path.join(outputMacOSDir, 'QClaw'), 'Bundled executable')
}

function verifyElectronShellVersion() {
  const expectedVersion = JSON.parse(fs.readFileSync(electronPackageJsonPath, 'utf8')).version
  const shellInfoPlistPath = path.join(
    outputApp,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Resources',
    'Info.plist',
  )
  const shellInfoPlist = fs.readFileSync(shellInfoPlistPath, 'utf8')
  const actualVersionMatch = shellInfoPlist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)

  if (!actualVersionMatch) {
    throw new Error('Unable to determine packaged Electron shell version from Info.plist')
  }

  if (actualVersionMatch[1] !== expectedVersion) {
    throw new Error(`Packaged Electron shell version mismatch: expected ${expectedVersion}, got ${actualVersionMatch[1]}`)
  }
}

function codesignApp() {
  run('codesign', ['--force', '--deep', '--sign', '-', outputApp])
}

function verifyCodeSignature() {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', outputApp])
}

function main() {
  ensureExists(electronApp, 'Electron.app template')
  buildIcns()
  buildAppSources()
  cleanDir(outputDir)
  fs.cpSync(electronApp, outputApp, { recursive: true, verbatimSymlinks: true })
  fs.rmSync(path.join(outputResources, 'default_app.asar'), { force: true })
  copyRepoPayload()
  copyBundledOpenClaw()
  replaceBundleIcon()
  renameBundleExecutable()
  patchInfoPlist()
  verifyPackagedEntry()
  verifyElectronShellVersion()
  codesignApp()
  verifyCodeSignature()

  console.log(`Packaged app: ${outputApp}`)
}

main()
