/**
 * 审核服务 API 端点配置
 *
 * 支持多环境切换：test（测试）/ production（正式）
 * 自动检测：若 C:\tmp\openclaw2\test.txt 存在则使用 test 环境，否则使用 production 环境。
 * 也可通过 setEndpointEnv() 手动切换。
 */

import { existsSync } from "node:fs";

export type EndpointEnv = "test" | "production";


export interface EndpointSet {
  /** 通用内容审核 */
  moderate: string;
  /** Skill 审核 */
  moderateSkill: string;
  /** 脚本审核 */
  moderateScript: string;
  /** 打包 Skill 审核 */
  moderateSkillPackage: string;
}

/** 各环境端点配置 */
const ENV_ENDPOINTS: Record<EndpointEnv, EndpointSet> = {
  test: {
    moderate: "https://jprx.sparta.html5.qq.com/api/v1/4065",
    moderateSkill: "https://jprx.sparta.html5.qq.com/api/v1/4070",
    moderateScript: "https://jprx.sparta.html5.qq.com/api/v1/4071",
    moderateSkillPackage: "https://jprx.sparta.html5.qq.com/api/v1/4077",
  },
  production: {
    moderate: "https://jsonproxy.3g.qq.com/api/v1/4065",
    moderateSkill: "https://jsonproxy.3g.qq.com/api/v1/4070",
    moderateScript: "https://jsonproxy.3g.qq.com/api/v1/4071",
    moderateSkillPackage: "https://jsonproxy.3g.qq.com/api/v1/4077",
  },
};

/** 测试环境标记文件，存在则使用 test 环境，否则使用 production */
const TEST_MARKER_FILE = "C:\\tmp\\openclaw2\\test.txt";

function detectEnv(): EndpointEnv {
  return existsSync(TEST_MARKER_FILE) ? "test" : "production";
}

let currentEnv: EndpointEnv = detectEnv();

/** 切换端点环境 */
export function setEndpointEnv(env: EndpointEnv): void {
  currentEnv = env;
}

/** 获取当前环境名称 */
export function getEndpointEnv(): EndpointEnv {
  return currentEnv;
}

/** 获取当前环境的端点配置 */
export function getEndpoints(): Readonly<EndpointSet> {
  return ENV_ENDPOINTS[currentEnv];
}

// ---- 便捷访问（兼容现有代码，运行时跟随环境切换）----

/** 通用内容审核 URL */
export function getModerateUrl(): string {
  return ENV_ENDPOINTS[currentEnv].moderate;
}

/** Skill 审核 URL */
export function getModerateSkillUrl(): string {
  return ENV_ENDPOINTS[currentEnv].moderateSkill;
}

/** 脚本审核 URL */
export function getModerateScriptUrl(): string {
  return ENV_ENDPOINTS[currentEnv].moderateScript;
}

/** 打包 Skill 审核 URL */
export function getModerateSkillPackageUrl(): string {
  return ENV_ENDPOINTS[currentEnv].moderateSkillPackage;
}
