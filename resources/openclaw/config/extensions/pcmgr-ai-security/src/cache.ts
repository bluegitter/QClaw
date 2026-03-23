/**
 * 电脑管家 AI 审核结果缓存 (PCMgr Moderation Cache)
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeMessage, calculateContentHash } from "./utils";
import { DecisionType } from "./client";

interface CacheEntry {
  reason: string;
  decision: DecisionType;
  timestamp: string;
}

interface CacheData {
  [key: string]: CacheEntry;
}

export class MessageCache {
  private cache: CacheData = {};
  private cachePath: string;
  private logger: any;
  private logTag: string;

  constructor(cachePath: string, logger: any, logTag: string = "pcmgr-ai-security") {
    this.cachePath = cachePath;
    this.logger = logger;
    this.logTag = logTag;
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.cachePath)) {
      try {
        const data = fs.readFileSync(this.cachePath, "utf-8");
        this.cache = JSON.parse(data);
      } catch (e) {
        this.logger.error(`[${this.logTag}] Failed to load message cache: ${e}`);
      }
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (e) {
      this.logger.error(`[${this.logTag}] Failed to save message cache: ${e}`);
    }
  }

  get(key: string): { reason: string; decision: DecisionType } | undefined {
    const entry = this.cache[key];
    if (entry) {
      return { reason: entry.reason, decision: entry.decision };
    }
    return undefined;
  }

  set(key: string, reason: string, decision: DecisionType): void {
    this.cache[key] = {
      reason,
      decision,
      timestamp: new Date().toISOString(),
    };
    this.save();
  }

  cleanup(api: any): void {
    this.logger.info(`[${this.logTag}] Starting message cache cleanup...`);

    const agentsDir = api.resolvePath("agents");
    if (!fs.existsSync(agentsDir)) {
      this.logger.warn(`[${this.logTag}] Agents directory not found at ${agentsDir}`);
      return;
    }

    this.logger.info(`[${this.logTag}] Agents directory: ${agentsDir}`);
    const activeKeys = new Set<string>();

    try {
      const agents = fs.readdirSync(agentsDir);
      for (const agentName of agents) {
        const agentPath = path.join(agentsDir, agentName);
        if (!fs.statSync(agentPath).isDirectory()) continue;

        const sessionsDir = path.join(agentPath, "sessions");
        const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
        if (!fs.existsSync(sessionsJsonPath)) continue;

        const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
        const sessionFiles: string[] = [];

        if (Array.isArray(sessionsData)) {
          sessionsData.forEach((s: any) => {
            if (s.sessionFile) sessionFiles.push(s.sessionFile);
          });
        } else if (typeof sessionsData === "object" && sessionsData !== null) {
          Object.values(sessionsData).forEach((s: any) => {
            if (s.sessionFile) sessionFiles.push(s.sessionFile);
          });
        }

        for (const sessionFile of sessionFiles) {
          const fullSessionPath = path.isAbsolute(sessionFile)
            ? sessionFile
            : path.join(sessionsDir, sessionFile);
          if (!fs.existsSync(fullSessionPath)) continue;

          const content = fs.readFileSync(fullSessionPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line);
              if (item.type === "message" && item.message) {
                const normalized = normalizeMessage(item.message, "openai");
                if (normalized.role === "user" && normalized.content) {
                  const key = calculateContentHash(normalized.content, i);
                  if (key) activeKeys.add(key);
                }
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          }
        }
      }

      let removedCount = 0;
      for (const key in this.cache) {
        if (!activeKeys.has(key)) {
          delete this.cache[key];
          removedCount++;
        }
      }

      if (removedCount > 0) {
        this.save();
        this.logger.info(
          `[${this.logTag}] Cache cleanup completed. Removed ${removedCount} stale entries.`
        );
      } else {
        this.logger.info(`[${this.logTag}] Cache cleanup completed. No stale entries found.`);
      }
    } catch (e) {
      this.logger.error(`[${this.logTag}] Failed to cleanup message cache: ${e}`);
    }
  }
}
