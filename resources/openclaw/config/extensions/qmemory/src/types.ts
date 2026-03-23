/** 任务状态 */
export type TaskStatus = "running" | "completed" | "failed" | "interrupted";

/** 工具调用步骤状态 */
export type StepStatus = "pending" | "completed" | "failed";

/** 单个工具调用步骤 */
export interface TaskStep {
  /** 步骤序号 */
  seq: number;
  /** 工具名称 */
  toolName: string;
  /** 工具调用 ID */
  toolCallId?: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 工具执行结果（完成后填充） */
  result?: unknown;
  /** 是否出错 */
  isError?: boolean;
  /** 步骤状态 */
  status: StepStatus;
  /** 步骤开始时间 */
  startedAt: number;
  /** 步骤完成时间 */
  completedAt?: number;
}

/** WAL 任务记录 */
export interface TaskRecord {
  /** 唯一任务 ID */
  taskId: string;
  /** Agent ID */
  agentId: string;
  /** 会话 Key */
  sessionKey: string;
  /** 原始用户提示词 */
  originalPrompt?: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 已执行的步骤列表 */
  steps: TaskStep[];
  /** 任务开始时间 */
  startedAt: number;
  /** 任务完成/中断时间 */
  endedAt?: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 插件配置 */
export interface QMemoryConfig {
  /** WAL 文件存储目录 */
  walDir?: string;
  /** 保留的最大 WAL 文件数量 */
  maxWalFiles?: number;
  /** WAL 文件保留时长（毫秒） */
  walRetentionMs?: number;
  /** 网关启动时是否自动检测并准备恢复 */
  autoRecovery?: boolean;
}

/** 日志接口 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** 恢复上下文信息 */
export interface RecoveryContext {
  /** 待恢复的任务记录 */
  task: TaskRecord;
  /** 已完成步骤的摘要（用于注入 prompt） */
  completedSummary: string;
}
