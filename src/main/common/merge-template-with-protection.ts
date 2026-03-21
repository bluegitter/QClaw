/**
 * 将模板配置深度覆盖到用户配置，同时保护指定路径的用户值不被覆盖
 *
 * 合并策略（"模板覆盖 + 白名单保护"）：
 * - 路径命中 protectedPaths → 跳过（保留用户值）
 * - 路径是 protectedPaths 的祖先（如 models.providers.qclaw 是 models.providers.qclaw.apiKey 的祖先）
 *   → 递归进子级，逐字段判断
 * - 两侧都是普通对象 → 递归合并
 * - 否则 → 用模板值覆盖用户值
 * - userConfig 中存在但模板中不存在的字段 → 保留不动
 *
 * @param userConfig 用户配置（会被原地修改）
 * @param templateConfig 模板配置（只读参考）
 * @param protectedPaths 需要保护的字段路径列表（点分隔，如 'gateway', 'models.providers.qclaw.apiKey'）
 * @returns 是否产生了变更
 */
export function mergeTemplateWithProtection(
  userConfig: Record<string, unknown>,
  templateConfig: Record<string, unknown>,
  protectedPaths: readonly string[],
): boolean {
  return mergeRecursive(userConfig, templateConfig, protectedPaths, '')
}

function mergeRecursive(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  protectedPaths: readonly string[],
  currentPath: string,
): boolean {
  let changed = false

  for (const key of Object.keys(source)) {
    const fullPath = currentPath ? `${currentPath}.${key}` : key
    const sourceValue = source[key]
    const targetValue = target[key]

    // 精确命中保护路径 → 跳过
    if (isProtected(fullPath, protectedPaths)) {
      continue
    }

    // 当前路径是某个保护路径的祖先 → 需要递归进子级逐字段判断
    if (isAncestorOfProtected(fullPath, protectedPaths)) {
      // 两侧都是对象才能递归
      if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
        const subChanged = mergeRecursive(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
          protectedPaths,
          fullPath,
        )
        if (subChanged) changed = true
        continue
      }

      // source 是对象但 target 不是 → 创建对象后递归（保护子路径）
      if (isPlainObject(sourceValue) && !isPlainObject(targetValue)) {
        const newObj: Record<string, unknown> = {}
        target[key] = newObj
        const subChanged = mergeRecursive(
          newObj,
          sourceValue as Record<string, unknown>,
          protectedPaths,
          fullPath,
        )
        // 始终标记变更（因为创建了新对象）
        changed = true
        if (subChanged) changed = true
        continue
      }

      // 其他情况（source 不是对象）→ 直接覆盖（不会影响子路径保护）
    }

    // 非保护路径：两侧都是对象 → 递归合并
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      const subChanged = mergeRecursive(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
        protectedPaths,
        fullPath,
      )
      if (subChanged) changed = true
      continue
    }

    // 非保护路径：用模板值覆盖
    if (!deepEqual(targetValue, sourceValue)) {
      target[key] = structuredClone(sourceValue)
      changed = true
    }
  }

  return changed
}

/**
 * 检查路径是否被保护（精确匹配）
 */
function isProtected(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((p) => p === path)
}

/**
 * 检查路径是否是某个保护路径的祖先
 * 例如 'models.providers.qclaw' 是 'models.providers.qclaw.apiKey' 的祖先
 */
function isAncestorOfProtected(path: string, protectedPaths: readonly string[]): boolean {
  const prefix = `${path}.`
  return protectedPaths.some((p) => p.startsWith(prefix))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 简易深度比较，用于判断是否需要覆盖
 * 通过 JSON 序列化比较，对配置对象场景足够
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return a === b
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
