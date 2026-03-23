/**
 * JPrx 防重放签名模块
 *
 * 签名公式：sign = md5(data + key + rnd + date + gid)
 * 签名放置位置：HTTP Header `JPrx-Ctx: rnd=<rnd>; date=<date>; gid=<gid>; sg=<sign>`
 *
 * 规则：
 * - data 为 POST Body 原文，byte-level 一致
 * - rnd 为 16 位随机字符串，60 秒内不可重复
 * - date 为秒级 Unix 时间戳，与服务器时间差 ≤ 60s
 * - gid 为客户端设备 ID
 */

import crypto from "node:crypto";

// --- 签名密钥（XOR 混淆存储，运行时还原） ---
const _m = [0x5a, 0x7c, 0x1f, 0x4e, 0x2d, 0xa3, 0x8b, 0xf1, 0x47, 0x6e, 0x92, 0xd8, 0xb5, 0x53, 0xc6, 0x71];
const _d = [59, 79, 121, 121, 72, 154, 233, 195, 36, 95, 246, 237, 133, 101, 242, 73];

/** 获取签名密钥 */
export function getSigningKey(): string {
  return _d.map((v, i) => String.fromCharCode(v ^ _m[i])).join("");
}

/**
 * 生成 16 位随机字符串（字母+数字）
 */
function generateRnd(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * 计算 JPrx 签名并返回 `JPrx-Ctx` header 值
 *
 * @param data  POST Body 原文（与实际发送的 body 完全一致）
 * @param gid   客户端设备标识（设备指纹）
 */
export function buildJprxCtxHeader(data: string, gid: string): string {
  const key = getSigningKey();
  const rnd = generateRnd();
  const date = Math.floor(Date.now() / 1000).toString();

  const signStr = data + key + rnd + date + gid;
  const sign = crypto.createHash("md5").update(signStr, "utf-8").digest("hex");

  return `rnd=${rnd}; date=${date}; gid=${gid}; sg=${sign}`;
}
