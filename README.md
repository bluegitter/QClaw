# QClaw

QClaw 是一个基于 Electron + Vue 的桌面应用，用于本地启动和管理 OpenClaw Gateway，并提供面向聊天场景的图形界面。

## 功能概览

- 本地启动、停止、重启 OpenClaw Gateway
- 内置聊天界面，直接连接本地 Gateway
- 自动管理默认配置、状态目录和本地运行时资源
- 支持模型配置、技能管理、会话管理和日志调试
- 提供 macOS 桌面应用打包脚本

## 目录结构

- `src/main`: Electron 主进程
- `src/preload`: preload 桥接层
- `src/renderer`: Vue 渲染进程
- `resources/openclaw`: OpenClaw 运行时资源、默认配置和扩展
- `resources/icons`: 应用和托盘图标资源
- `packages/shared`: 共享类型定义
- `packages/report`: 上报相关本地包
- `scripts`: 启动与打包脚本

## 环境要求

- Node.js 24.x
- `pnpm`
- macOS 打包需要系统自带的 `codesign`

## 安装依赖

```bash
pnpm install
```

## 开发

开发模式启动 Electron + Vite：

```bash
pnpm dev
```

如果要按接近正式应用的方式启动当前工程：

```bash
pnpm start
```

说明：

- `pnpm dev` 适合前端和主进程联调
- `pnpm start` 会通过 [start-electron.mjs](/Users/yanfei/Downloads/QClaw/scripts/start-electron.mjs) 直接启动本地 Electron 二进制

## 构建

生成主进程、preload 和渲染进程产物：

```bash
pnpm build
```

构建输出位于：

- `out/main`
- `out/preload`
- `out/renderer`

## 运行时路径

默认情况下，QClaw 会使用以下本地路径：

- 状态目录：`~/.qclaw`
- 配置文件：`~/.qclaw/openclaw.json`
- 默认 Gateway 端口：`28789`

可通过环境变量覆盖：

- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`
- `OPENCLAW_GATEWAY_PORT`

## macOS 打包

生成 macOS 应用：

```bash
pnpm package:mac
```

打包产物：

- `dist/mac/QClaw.app`

打包脚本位于 [package-mac.mjs](/Users/yanfei/Downloads/QClaw/scripts/package-mac.mjs)，当前流程会：

- 先执行 `pnpm build`
- 复制 Electron 模板应用
- 注入当前项目代码到 `QClaw.app`
- 替换默认应用图标
- 修改 `Info.plist`
- 执行 `codesign`

## 图标资源

macOS 应用图标默认读取：

- [icon.icns](/Users/yanfei/Downloads/QClaw/resources/icons/app/mac/icon.icns)

如果该文件不存在，打包脚本会尝试使用旧图标来源或回退生成流程。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm start
pnpm build
pnpm package:mac
```

## 故障排查

- `pnpm start` 失败时，先确认依赖已安装完成，且 `node_modules/electron/dist/Electron.app` 存在
- Gateway 无法连接时，先检查本地状态目录 `~/.qclaw` 和配置文件是否正常
- macOS 打包失败时，优先检查 `codesign`、图标文件和 `dist/mac/QClaw.app` 的旧残留

## 维护说明

- 修改主进程行为时，主要关注 `src/main`
- 修改前端交互时，主要关注 `src/renderer`
- 修改桥接 API 时，需要同时更新 `src/preload` 和 `packages/shared/index.d.ts`
