/**
 * Health check utilities for HTTP services
 */

import {
  HEALTH_CHECK_ENDPOINT,
  HEALTH_CHECK_TIMEOUT,
  HEALTH_CHECK_DEFAULT_RETRIES,
  HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS,
  HEALTH_WAIT_DEFAULT_RETRIES,
  HEALTH_WAIT_DEFAULT_RETRY_DELAY_MS,
} from './constants.js'
import { LOCALHOST_ADDRESS } from '../common/constants.js'

export interface HealthCheckOptions {
  port?: number
  timeout?: number
  retries?: number
  retryDelay?: number
  /** 可选的进程存活检查回调，返回 false 时提前终止等待 */
  isProcessAlive?: () => boolean
}

export async function checkHealth(
  port: number,
  timeout: number = HEALTH_CHECK_TIMEOUT
): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(`http://${LOCALHOST_ADDRESS}:${port}${HEALTH_CHECK_ENDPOINT}`, {
      signal: controller.signal,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })

    clearTimeout(timeoutId)
    return response.ok
  } catch {
    return false
  }
}

/**
 * Health check with retries
 */
export async function checkHealthWithRetry(
  options: HealthCheckOptions = {}
): Promise<boolean> {
  const {
    port = 0,
    timeout = HEALTH_CHECK_TIMEOUT,
    retries = HEALTH_CHECK_DEFAULT_RETRIES,
    retryDelay = HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS
  } = options

  for (let attempt = 1; attempt <= retries; attempt++) {
    const isHealthy = await checkHealth(port, timeout)
    if (isHealthy) {
      return true
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }
  }

  return false
}

/**
 * Wait for health check to pass
 */
export async function waitForHealth(
  options: HealthCheckOptions = {}
): Promise<void> {
  const {
    port = 0,
    timeout = HEALTH_CHECK_TIMEOUT,
    retries = HEALTH_WAIT_DEFAULT_RETRIES,
    retryDelay = HEALTH_WAIT_DEFAULT_RETRY_DELAY_MS,
    isProcessAlive
  } = options

  for (let attempt = 1; attempt <= retries; attempt++) {
    // 如果进程已退出，立即终止等待，避免无意义的轮询
    if (isProcessAlive && !isProcessAlive()) {
      throw new Error('Process exited during health check wait')
    }

    const isHealthy = await checkHealth(port, timeout)
    if (isHealthy) {
      return
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }
  }

  throw new Error(
    `Health check failed after ${retries} attempts. Gateway may not be running.`
  )
}

/**
 * Get health status details
 */
export interface HealthStatus {
  healthy: boolean
  statusCode?: number
  responseTime: number
  error?: string
}

export async function getHealthStatus(
  port: number,
  timeout: number = HEALTH_CHECK_TIMEOUT
): Promise<HealthStatus> {
  const startTime = Date.now()

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(`http://${LOCALHOST_ADDRESS}:${port}${HEALTH_CHECK_ENDPOINT}`, {
      signal: controller.signal,
      method: 'GET'
    })

    clearTimeout(timeoutId)

    return {
      healthy: response.ok,
      statusCode: response.status,
      responseTime: Date.now() - startTime
    }
  } catch (error) {
    const responseTime = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return {
      healthy: false,
      responseTime,
      error: errorMessage
    }
  }
}
