/**
 * CreateTask 接口标签/等级映射表
 *
 * 来源：CreateTask 接口文档（jiekou.md）中的 ResultType / ResultFirstLabel 定义。
 * 用于将接口返回的数字 code 和英文 key 转换为人类可读的中文描述。
 */

/**
 * ResultType（恶意类型 code）→ 中文名称映射
 *
 * ResultType 是 CreateTask 响应中 `Data.ResultType` 字段的值，
 * 表示命中的主要恶意类型。
 */
export const ResultTypeMap: Record<number, string> = {
  20001: "政治",
  20002: "色情",
  20004: "社会",
  20006: "违法",
  20013: "版权",
  21000: "其他",
};

/**
 * ResultFirstLabel 中的 key → 中文名称映射
 *
 * ResultFirstLabel 是 JSON 字符串，key 为英文标签名（如 "Political"、"Porn"），
 * 此映射用于将 key 转为中文，兼容接口返回的两种写法（如 Politics / Political）。
 */
export const FirstLabelKeyMap: Record<string, string> = {
  Politics: "政治",
  Political: "政治",
  Porn: "色情",
  Society: "社会",
  Illegality: "违法",
  Privacy: "隐私",
  Attack: "指令攻击",
  RedOne: "红一",
  Others: "其他",
};

/**
 * ResultTypeLevel（恶意程度等级）→ 中文描述映射
 *
 * ResultTypeLevel 是 CreateTask 响应中 `Data.ResultTypeLevel` 字段的值，
 * 表示命中内容的恶意程度，数值越大越严重。
 *
 * 对应关系：
 * - 100：正常（未命中任何规则）
 * - 200：疑似相关（弱信号，建议关注）
 * - 250：明确相关（中等信号）
 * - 300：疑似恶意（强信号，政治标签时表示红一相关）
 * - 400：明确恶意（最高级别，直接拦截）
 */
export const ResultLevelMap: Record<number, string> = {
  100: "正常",
  200: "疑似相关",
  250: "明确相关",
  300: "疑似恶意",
  400: "明确恶意",
};

/**
 * 根据恶意类型 code 获取中文名称
 *
 * @param code - ResultType 字段值，如 20001
 * @returns 对应的中文名称，未知 code 返回 "未知类型(code)"
 */
export const getResultTypeName = (code: number): string => {
  return ResultTypeMap[code] || `未知类型(${code})`;
};

/**
 * 根据恶意程度等级获取中文描述
 *
 * @param level - ResultTypeLevel 字段值，如 400
 * @returns 对应的中文描述，未知等级返回 "未知等级(level)"
 */
export const getResultLevelName = (level: number): string => {
  return ResultLevelMap[level] || `未知等级(${level})`;
};

/**
 * 解析 ResultFirstLabel JSON 字符串，返回命中的标签列表
 *
 * ResultFirstLabel 是 CreateTask 响应中的一级标签字段，格式为 JSON 字符串，示例：
 * ```json
 * {
 *   "Political": { "Level": "400", "Meaning": "政治or红一", "Label": 20001 },
 *   "Porn":      { "Level": "100", "Meaning": "色情",       "Label": 20002 }
 * }
 * ```
 *
 * 此函数遍历所有标签，过滤出 Level > minLevel 的命中项，
 * 返回格式为 "中文名(等级描述)" 的字符串数组，如 ["政治(明确恶意)"]。
 *
 * 注意：Level 字段可能是 number 或 string，函数内部统一用 Number() 转换。
 *
 * @param labelStr - CreateTask 响应中的 ResultFirstLabel 字段（JSON 字符串）
 * @param minLevel - 最低关注的恶意等级（默认 200，即"疑似相关"及以上）
 * @returns 命中的标签名称数组，如 ["政治(明确恶意)", "色情(疑似相关)"]；解析失败返回 []
 */
export const parseFirstLabels = (labelStr: string, minLevel: number = 200): string[] => {
  if (!labelStr) return [];

  try {
    const labels = JSON.parse(labelStr);
    const hitLabels: string[] = [];

    for (const [key, value] of Object.entries(labels)) {
      const item = value as any;
      if (!item || typeof item !== "object") continue;

      // Level 字段在不同版本的接口中可能是 number 或 string，统一转为 number
      // uilevel 是旧版字段名，Level 是新版字段名，兼容两种写法
      const level = Number(item.uilevel ?? item.Level ?? 100);

      if (level > minLevel) {
        // 优先使用接口返回的 Meaning 字段，其次查映射表，最后用 key 本身
        const meaning = item.strMeaning || item.Meaning || FirstLabelKeyMap[key] || key;
        hitLabels.push(`${meaning}(${getResultLevelName(level)})`);
      }
    }

    return hitLabels;
  } catch {
    // JSON 解析失败（如字段为空字符串或格式异常），返回空数组，不影响主流程
    return [];
  }
};
