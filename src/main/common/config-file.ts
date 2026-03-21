import JSON5 from 'json5'
import fs from 'fs'
import fsPromises from 'fs/promises'

/**
 * JSON5 配置文件的统一读写工具
 *
 * 读取: 使用 JSON5 解析，兼容尾逗号、注释等 JSON5 语法
 * 写入: 输出标准 JSON（2 空格缩进），确保最大兼容性
 */

/**
 * 同步读取并解析 JSON5 配置文件
 */
export function readConfigFileSync<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON5.parse(raw) as T
}

/**
 * 异步读取并解析 JSON5 配置文件
 */
export async function readConfigFile<T = unknown>(filePath: string): Promise<T> {
  const raw = await fsPromises.readFile(filePath, 'utf-8')
  return JSON5.parse(raw) as T
}

/**
 * 同步写入配置文件（输出标准 JSON，2 空格缩进）
 */
export function writeConfigFileSync(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 异步写入配置文件（输出标准 JSON，2 空格缩进）
 */
export async function writeConfigFile(filePath: string, data: unknown): Promise<void> {
  await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 从配置文件中读取指定字段
 * 支持嵌套路径，如 'gateway.port'、'gateway.auth.token'
 *
 * @returns 字段值，路径不存在或读取失败时返回 undefined
 */
/**
 * 解析嵌套配置对象中指定路径的数组字段
 *
 * 沿 keyPath 逐层导航到叶子节点并返回其所在的父对象和数组引用。
 *
 * @param mode
 *   - 'ensure': 沿途缺失的中间层自动创建为空对象（适用于写入场景）
 *   - 'readonly': 沿途遇到缺失立即返回 null（适用于读取/清理场景）
 *
 * @returns `{ parent, leafKey, arr }` 或 `null`（readonly 模式下路径不完整时）
 */
export function resolveNestedArray(
  config: Record<string, unknown>,
  keyPath: readonly string[],
  mode: 'ensure' | 'readonly' = 'readonly',
): { parent: Record<string, unknown>; leafKey: string; arr: unknown[] } | null {
  let current: Record<string, unknown> = config
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i]!
    if (current[key] == null || typeof current[key] !== 'object') {
      if (mode === 'readonly') return null
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }

  const leafKey = keyPath[keyPath.length - 1]!
  const arr: unknown[] = Array.isArray(current[leafKey]) ? (current[leafKey] as unknown[]) : []
  return { parent: current, leafKey, arr }
}

export function readConfigField<T = unknown>(
  configPath: string,
  keyPath: string
): T | undefined {
  try {
    const config = readConfigFileSync<Record<string, unknown>>(configPath)

    const keys = keyPath.split('.')
    let value: unknown = config
    for (const key of keys) {
      if (value == null || typeof value !== 'object') {
        return undefined
      }
      value = (value as Record<string, unknown>)[key]
    }

    return value as T
  } catch {
    return undefined
  }
}
