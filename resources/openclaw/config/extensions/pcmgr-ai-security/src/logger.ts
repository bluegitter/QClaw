/**
 * 文件日志模块（无外部依赖，避免循环引用）
 *
 * 默认落盘到应用日志目录：
 *   - Windows: %APPDATA%\QClaw\logs\
 *   - macOS:   ~/Library/Logs/QClaw/
 * 调用 setLogFilePath 可切换路径。
 */

import fs from "node:fs";
import path from "node:path";

/** 默认日志目录：应用日志目录 */
function getDefaultLogDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
    return path.join(appData, "QClaw", "logs");
  }
  // macOS: ~/Library/Logs/QClaw/
  const home = process.env.HOME ?? "";
  return path.join(home, "Library", "Logs", "QClaw");
}

let logFilePath = "";

function getEffectiveLogPath(): string {
  if (logFilePath) return logFilePath;
  return path.join(getDefaultLogDir(), "pcmgr-ai-security_debug.log");
}

export function setLogFilePath(filePath: string): void {
  logFilePath = filePath;
}

export function getLogFilePath(): string {
  return getEffectiveLogPath();
}

/** 确保目标目录存在（仅在首次写入时创建，结果缓存） */
let dirEnsured = false;
function ensureLogDir(filePath: string): void {
  if (dirEnsured) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dirEnsured = true;
}

/**
 * 通用文件日志，始终落盘到日志文件。
 */
export function fileLog(message: string): void {
  const timestamp = new Date().toISOString();
  const target = getEffectiveLogPath();
  ensureLogDir(target);
  fs.appendFileSync(target, `[${timestamp}] ${message}\n`, "utf-8");
}
