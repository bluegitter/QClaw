import { app } from 'electron'
import { join } from 'node:path'

export function getAppResourcesPath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
}

export function getChannelFilePath(): string {
  return join(getAppResourcesPath(), 'channel.json')
}
