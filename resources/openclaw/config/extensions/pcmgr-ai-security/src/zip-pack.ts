/**
 * Skill 目录打包器 — 使用 archiver 生成标准 ZIP
 *
 * 同步扫描 + 异步打包，返回 { zip_buffer, sha256_hash, total_size, file_count }
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";
import { PassThrough } from "node:stream";

/** 单个文件大小限制 5MB，超过跳过 */
const MAX_SINGLE_FILE_SIZE = 5 * 1024 * 1024;

/** 打包目录总大小限制 10MB */
export const MAX_PACKAGE_SIZE = 10 * 1024 * 1024;

/** 递归忽略的目录 / 文件名 */
const IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store", "__pycache__"]);

interface FileEntry {
  rel_path: string;
  abs_path: string;
  size: number;
}

function collectFiles(dir_path: string, base_dir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let items: string[];
  try {
    items = fs.readdirSync(dir_path);
  } catch {
    return entries;
  }

  for (const item of items) {
    if (IGNORED_NAMES.has(item)) continue;

    const full_path = path.join(dir_path, item);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full_path);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      entries.push(...collectFiles(full_path, base_dir));
    } else if (stat.isFile() && stat.size <= MAX_SINGLE_FILE_SIZE) {
      entries.push({
        rel_path: path.relative(base_dir, full_path).replace(/\\/g, "/"),
        abs_path: full_path,
        size: stat.size,
      });
    }
  }
  return entries;
}

export interface ZipPackResult {
  zip_buffer: Buffer;
  sha256_hash: string;
  total_size: number;
  file_count: number;
}

export async function packDirectoryToZip(dir_path: string): Promise<ZipPackResult | undefined> {
  if (!fs.existsSync(dir_path) || !fs.statSync(dir_path).isDirectory()) {
    return undefined;
  }

  const files = collectFiles(dir_path, dir_path);
  if (files.length === 0) return undefined;

  const total_raw_size = files.reduce((sum, f) => sum + f.size, 0);
  if (total_raw_size > MAX_PACKAGE_SIZE) {
    return undefined;
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];

  const passthrough = new PassThrough();
  passthrough.on("data", (chunk: Buffer) => chunks.push(chunk));

  archive.pipe(passthrough);

  for (const file of files) {
    archive.file(file.abs_path, { name: file.rel_path });
  }

  await archive.finalize();

  const zip_buffer = Buffer.concat(chunks);
  const sha256_hash = crypto.createHash("sha256").update(zip_buffer).digest("hex");

  return {
    zip_buffer,
    sha256_hash,
    total_size: zip_buffer.length,
    file_count: files.length,
  };
}
