import fs from 'fs'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import * as tar from 'tar'
import { inspectSkillDirectory } from './skill-selection.js'

type GitHubRepoRef = {
  owner: string
  repo: string
  branch?: string
  subPath?: string
}

const DOWNLOAD_TIMEOUT_MS = 20000
const DOWNLOAD_RETRY_COUNT = 3

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function sanitizeDirName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export function parseGitHubRepoUrl(input: string): GitHubRepoRef | null {
  const normalized = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const match = normalized.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?/i,
  )

  if (!match?.[1] || !match?.[2]) {
    return null
  }

  return {
    owner: match[1],
    repo: match[2],
    branch: match[3] || undefined,
    subPath: match[4] || undefined,
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeRedirectUrl(nextUrl: string, currentUrl: string): string {
  if (/^https?:\/\//i.test(nextUrl)) {
    return nextUrl
  }
  return new URL(nextUrl, currentUrl).toString()
}

function downloadToFile(url: string, destination: string, redirectCount = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const request = protocol.get(url, {
      headers: {
        'user-agent': 'QClaw/0.1.1 skill-import',
        accept: '*/*',
      },
      timeout: DOWNLOAD_TIMEOUT_MS,
      family: 4,
    }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        if (redirectCount >= 5) {
          reject(new Error('下载重定向次数过多'))
          return
        }
        downloadToFile(
          normalizeRedirectUrl(response.headers.location, url),
          destination,
          redirectCount + 1,
        ).then(resolve).catch(reject)
        return
      }

      if (!response.statusCode || response.statusCode >= 400) {
        response.resume()
        reject(new Error(`下载失败，状态码: ${response.statusCode ?? 'unknown'}`))
        return
      }

      const writer = fs.createWriteStream(destination)
      response.pipe(writer)
      writer.on('finish', () => {
        writer.close()
        resolve()
      })
      writer.on('error', (error) => {
        writer.close()
        reject(error)
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('下载超时'))
    })

    request.on('error', reject)
  })
}

async function downloadWithRetry(urls: string[], destination: string): Promise<void> {
  const errors: string[] = []

  for (const url of urls) {
    for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT; attempt += 1) {
      try {
        if (fs.existsSync(destination)) {
          fs.rmSync(destination, { force: true })
        }
        await downloadToFile(url, destination)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${url} (attempt ${attempt}): ${message}`)
        if (attempt < DOWNLOAD_RETRY_COUNT) {
          await wait(400 * attempt)
        }
      }
    }
  }

  throw new Error(
    `下载技能仓库失败，请检查网络连接。最近错误：${errors[errors.length - 1] || 'unknown'}`,
  )
}

function findInstalledRoot(extractRoot: string): string {
  const children = fs
    .readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractRoot, entry.name))

  if (children.length === 1) {
    return children[0]!
  }

  return extractRoot
}

function findSkillDirectories(rootDir: string, maxDepth = 3): string[] {
  const matches: string[] = []

  function walk(currentDir: string, depth: number) {
    if (fs.existsSync(path.join(currentDir, 'SKILL.md'))) {
      matches.push(currentDir)
      return
    }

    if (depth >= maxDepth) {
      return
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }

      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }

      walk(path.join(currentDir, entry.name), depth + 1)
    }
  }

  walk(rootDir, 0)
  return matches
}

function resolveSkillSourceDir(rootDir: string, subPath?: string): string {
  if (subPath) {
    return path.join(rootDir, subPath)
  }

  const rootSkillFile = path.join(rootDir, 'SKILL.md')
  if (fs.existsSync(rootSkillFile)) {
    return rootDir
  }

  const matches = findSkillDirectories(rootDir)

  if (matches.length === 1) {
    return matches[0]!
  }

  if (matches.length > 1) {
    throw new Error(
      `仓库中找到多个技能目录，请使用 GitHub 子目录链接导入，例如 /tree/main/<skill-dir>。候选目录：${matches
        .map((dirPath) => path.relative(rootDir, dirPath))
        .join('、')}`,
    )
  }

  return rootDir
}

export async function importSkillFromGitHub(
  repoUrl: string,
  managedSkillsDir: string,
  bundledSkillsDir: string,
) {
  const repoRef = parseGitHubRepoUrl(repoUrl)
  if (!repoRef) {
    throw new Error('请输入有效的 GitHub 仓库地址，例如：https://github.com/owner/repo')
  }

  const branch = repoRef.branch || 'main'
  const downloadUrls = [
    `https://codeload.github.com/${repoRef.owner}/${repoRef.repo}/tar.gz/refs/heads/${branch}`,
    `https://github.com/${repoRef.owner}/${repoRef.repo}/archive/refs/heads/${branch}.tar.gz`,
  ]
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-skill-'))
  const archivePath = path.join(tempRoot, 'skill.tar.gz')
  const extractRoot = path.join(tempRoot, 'extract')

  ensureDir(extractRoot)

  try {
    await downloadWithRetry(downloadUrls, archivePath)
    await tar.x({
      file: archivePath,
      cwd: extractRoot,
      gzip: true,
    })

    const installedRoot = findInstalledRoot(extractRoot)
    const sourceDir = resolveSkillSourceDir(installedRoot, repoRef.subPath)
    const inspected = inspectSkillDirectory(sourceDir, bundledSkillsDir, managedSkillsDir)
    if (!inspected.isValid) {
      throw new Error(
        inspected.error || '仓库中未找到 SKILL.md，请确认仓库根目录或指定子目录是有效技能目录',
      )
    }

    ensureDir(managedSkillsDir)
    const targetDir = path.join(
      managedSkillsDir,
      sanitizeDirName(inspected.id || repoRef.repo),
    )

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true })
    }

    fs.cpSync(sourceDir, targetDir, { recursive: true })
    return inspectSkillDirectory(targetDir, bundledSkillsDir, managedSkillsDir)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

export function removeManagedSkill(skillId: string, managedSkillsDir: string) {
  const safeSkillId = sanitizeDirName(skillId)
  const targetDir = path.join(managedSkillsDir, safeSkillId)

  if (!fs.existsSync(targetDir)) {
    return {
      success: false,
      message: '技能目录不存在',
    }
  }

  fs.rmSync(targetDir, { recursive: true, force: true })
  return {
    success: true,
    message: '技能已移除',
  }
}
