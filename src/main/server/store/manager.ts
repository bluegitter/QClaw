import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { mainLogger } from '../../common/logger.js'
import { APP_STORE_FILE_NAME } from '../../common/constants.js'


export class StoreManager {
  private data: Record<string, unknown> = {}
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), APP_STORE_FILE_NAME)
    this.load()
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.data[key] = value
    this.save()
  }

  delete(key: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.data[key]
    this.save()
  }

  has(key: string): boolean {
    return key in this.data
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.data = JSON.parse(raw) as Record<string, unknown>
      }
    } catch (err) {
      mainLogger.warn(
        '[StoreManager] Failed to load store, starting fresh:',
        err instanceof Error ? err.message : 'Unknown error',
      )
      this.data = {}
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      mainLogger.error(
        '[StoreManager] Failed to save store:',
        err instanceof Error ? err.message : 'Unknown error',
      )
    }
  }
}

// 单例
let storeManagerInstance: StoreManager | null = null

export function getStoreManager(): StoreManager {
  if (!storeManagerInstance) {
    storeManagerInstance = new StoreManager()
  }
  return storeManagerInstance
}
