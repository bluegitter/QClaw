/**
 * 统一熔断器
 *
 * 所有审核接口（/v2/moderate、/v2/moderate/skill、/v2/moderate/script）
 * 共享同一个熔断器实例。
 *
 * 熔断规则：
 * - 连续 N 次请求失败或超时 → 开启熔断
 * - 熔断持续固定时长后自动恢复（无需探测请求）
 * - 熔断期间所有审核请求跳过，等同放行
 */

import { LOG_TAG } from "./constants";
import { fileLog } from "./logger";

export interface CircuitBreakerConfig {
  /** 连续失败多少次后开启熔断，默认 3 */
  failureThreshold?: number;
  /** 熔断持续时长（毫秒），默认 120000（2 分钟） */
  cooldownMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000; // 2 分钟

export class CircuitBreaker {
  private consecutive_failures_ = 0;
  private tripped_at_: number | null = null;

  private failure_threshold_: number;
  private cooldown_ms_: number;

  private logger_: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void } | null = null;

  constructor(config?: CircuitBreakerConfig) {
    this.failure_threshold_ = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldown_ms_ = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** 绑定 logger（可选，用于输出熔断状态变化日志） */
  setLogger(logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void }): void {
    this.logger_ = logger;
  }

  /** 更新配置 */
  configure(config: CircuitBreakerConfig): void {
    if (config.failureThreshold !== undefined) {
      this.failure_threshold_ = config.failureThreshold;
    }
    if (config.cooldownMs !== undefined) {
      this.cooldown_ms_ = config.cooldownMs;
    }
  }

  /**
   * 是否处于熔断状态。
   *
   * 如果熔断时间已超过冷却期，自动恢复并返回 false。
   */
  isOpen(): boolean {
    if (this.tripped_at_ === null) {
      return false;
    }
    // 冷却期已过，自动恢复
    if (Date.now() - this.tripped_at_ >= this.cooldown_ms_) {
      const msg = `[${LOG_TAG}] Circuit-breaker auto-recovered after ${Math.round(this.cooldown_ms_ / 1000)}s cooldown.`;
      this.logger_?.info(msg);
      fileLog(msg);
      this.reset();
      return false;
    }
    return true;
  }

  /** 剩余冷却时间（毫秒），未熔断时返回 0 */
  remainingCooldownMs(): number {
    if (this.tripped_at_ === null) return 0;
    const elapsed = Date.now() - this.tripped_at_;
    return Math.max(0, this.cooldown_ms_ - elapsed);
  }

  /** 记录一次成功，重置失败计数 */
  recordSuccess(): void {
    if (this.consecutive_failures_ > 0) {
      this.consecutive_failures_ = 0;
    }
  }

  /**
   * 记录一次失败。
   *
   * 连续失败达到阈值时触发熔断。
   */
  recordFailure(): void {
    this.consecutive_failures_++;
    if (this.consecutive_failures_ >= this.failure_threshold_ && this.tripped_at_ === null) {
      this.tripped_at_ = Date.now();
      const msg =
        `[${LOG_TAG}] Circuit-breaker OPEN: ${this.consecutive_failures_} consecutive failures. ` +
        `All moderation requests will be skipped for ${Math.round(this.cooldown_ms_ / 1000)}s.`;
      this.logger_?.error(msg);
      fileLog(msg);
    }
  }

  /** 重置为初始状态 */
  reset(): void {
    this.consecutive_failures_ = 0;
    this.tripped_at_ = null;
  }

  /** 当前连续失败次数（仅用于日志/调试） */
  get consecutiveFailures(): number {
    return this.consecutive_failures_;
  }
}

/** 全局共享的熔断器实例 */
export const globalCircuitBreaker = new CircuitBreaker();
