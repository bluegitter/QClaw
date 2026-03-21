import fs from 'fs'
import path from 'path'
import { getStoreManager } from '../server/store/index.js'

const ALWAYS_ENABLED_BUNDLED_SKILL_IDS = new Set([
  'qclaw-rules',
])
const SKILL_SELECTION_STORE_KEY = 'skills.selection.enabledIds'

export type SkillDirectoryInfo = {
  id: string
  name: string
  description: string
  path: string
  isBundled: boolean
  alwaysEnabled: boolean
  source?: 'builtin' | 'project' | 'user'
  emoji?: string
  version?: string
  ownerId?: string
  fullDescription?: string
}

export type SkillDirectoryInspection = SkillDirectoryInfo & {
  isValid: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function listBundledSkillIds(bundledSkillsDir: string): string[] {
  if (!fs.existsSync(bundledSkillsDir)) {
    return []
  }

  return fs
    .readdirSync(bundledSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function readSkillMarkdownSummary(content: string, fallbackName: string): {
  name: string
  description: string
  emoji?: string
  ownerId?: string
  fullDescription: string
} {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())

  const titleLine = lines.find((line) => line.startsWith('# '))
  const name = titleLine?.replace(/^#\s+/, '').trim() || fallbackName

  const descriptionLines: string[] = []
  let collecting = false
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('```')) {
      if (collecting) {
        break
      }
      continue
    }

    collecting = true
    descriptionLines.push(line)
    if (descriptionLines.length >= 2) {
      break
    }
  }

  const emojiLine = lines.find((line) => /^emoji:\s*/i.test(line))
  const ownerLine = lines.find((line) => /^ownerId:\s*/i.test(line))

  return {
    name,
    description: descriptionLines.join(' ').trim(),
    emoji: emojiLine?.replace(/^emoji:\s*/i, '').trim().replace(/^["']|["']$/g, '') || undefined,
    ownerId: ownerLine?.replace(/^ownerId:\s*/i, '').trim().replace(/^["']|["']$/g, '') || undefined,
    fullDescription: content.trim(),
  }
}

function readSkillVersion(skillDir: string): string | undefined {
  const metaJsonPath = path.join(skillDir, 'meta.json')
  if (fs.existsSync(metaJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaJsonPath, 'utf-8')) as { version?: string }
      if (typeof meta.version === 'string' && meta.version.trim()) {
        return meta.version.trim()
      }
    } catch {
      // ignore invalid meta.json
    }
  }

  const packageJsonPath = path.join(skillDir, 'package.json')
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim()
      }
    } catch {
      // ignore invalid package.json
    }
  }

  return undefined
}

export function inspectSkillDirectory(
  skillDir: string,
  bundledSkillsDir?: string,
  managedSkillsDir?: string,
): SkillDirectoryInspection {
  const resolvedDir = path.resolve(skillDir)
  const skillId = path.basename(resolvedDir)
  const isBundled = bundledSkillsDir
    ? path.dirname(resolvedDir) === path.resolve(bundledSkillsDir)
    : false
  const managedRoot = managedSkillsDir ? path.resolve(managedSkillsDir) : ''
  const source =
    isBundled
      ? 'builtin'
      : managedRoot && path.dirname(resolvedDir) === managedRoot
        ? 'user'
        : 'project'
  const alwaysEnabled = ALWAYS_ENABLED_BUNDLED_SKILL_IDS.has(skillId)

  if (!fs.existsSync(resolvedDir)) {
    return {
      id: skillId,
      name: skillId,
      description: '',
      path: resolvedDir,
      isBundled,
      alwaysEnabled,
      source,
      isValid: false,
      error: '目录不存在',
    }
  }

  if (!fs.statSync(resolvedDir).isDirectory()) {
    return {
      id: skillId,
      name: skillId,
      description: '',
      path: resolvedDir,
      isBundled,
      alwaysEnabled,
      source,
      isValid: false,
      error: '所选路径不是目录',
    }
  }

  const skillFile = path.join(resolvedDir, 'SKILL.md')
  if (!fs.existsSync(skillFile)) {
    return {
      id: skillId,
      name: skillId,
      description: '',
      path: resolvedDir,
      isBundled,
      alwaysEnabled,
      source,
      isValid: false,
      error: '目录中未找到 SKILL.md',
    }
  }

  try {
    const raw = fs.readFileSync(skillFile, 'utf-8')
    const summary = readSkillMarkdownSummary(raw, skillId)
    const version = readSkillVersion(resolvedDir)
    return {
      id: skillId,
      name: summary.name,
      description: summary.description,
      path: resolvedDir,
      isBundled,
      alwaysEnabled,
      source,
      emoji: summary.emoji,
      version,
      ownerId: summary.ownerId,
      fullDescription: summary.fullDescription,
      isValid: true,
    }
  } catch (error) {
    return {
      id: skillId,
      name: skillId,
      description: '',
      path: resolvedDir,
      isBundled,
      alwaysEnabled,
      source,
      isValid: false,
      error: error instanceof Error ? error.message : '读取技能目录失败',
    }
  }
}

export function listBundledSkills(
  bundledSkillsDir: string,
  managedSkillsDir?: string,
): SkillDirectoryInfo[] {
  return listBundledSkillIds(bundledSkillsDir)
    .map((skillId) =>
      inspectSkillDirectory(path.join(bundledSkillsDir, skillId), bundledSkillsDir, managedSkillsDir),
    )
    .filter((item): item is SkillDirectoryInfo & { isValid: true } => item.isValid)
    .map(({ isValid: _isValid, error: _error, ...item }) => item)
}

export function getSelectedBundledSkillIds(
  _config: Record<string, unknown>,
  bundledSkillsDir: string,
): string[] {
  const availableIds = listBundledSkillIds(bundledSkillsDir)
  if (availableIds.length === 0) {
    return []
  }

  const store = getStoreManager()
  const storedEnabledIds = store.get<unknown>(SKILL_SELECTION_STORE_KEY)
  const rawEnabledIds = Array.isArray(storedEnabledIds)
    ? storedEnabledIds.filter((value): value is string => typeof value === 'string')
    : null

  const availableIdSet = new Set(availableIds)
  const selectedIds =
    rawEnabledIds && rawEnabledIds.length > 0
      ? rawEnabledIds.filter((id) => availableIdSet.has(id))
      : availableIds

  for (const skillId of ALWAYS_ENABLED_BUNDLED_SKILL_IDS) {
    if (availableIdSet.has(skillId) && !selectedIds.includes(skillId)) {
      selectedIds.push(skillId)
    }
  }

  return selectedIds
}

export function getSelectedBundledSkillDirs(
  config: Record<string, unknown>,
  bundledSkillsDir: string,
): string[] {
  return getSelectedBundledSkillIds(config, bundledSkillsDir).map((skillId) =>
    path.join(bundledSkillsDir, skillId),
  )
}
