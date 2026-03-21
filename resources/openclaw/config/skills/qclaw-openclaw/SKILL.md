---
name: qclaw-openclaw
description: |
  [MANDATORY] 本环境没有全局 openclaw CLI。任何需要执行 openclaw 命令的场景（配置管理、
  定时任务、模型设置、Skills/Plugins 管理等）都必须通过本 skill 提供的脚本执行。
  禁止直接调用 `openclaw` 命令，禁止执行服务管理命令（gateway/daemon），
  OpenClaw 服务由 QClaw Electron 守护进程管理。
metadata: {"openclaw": {"emoji": "⚙️"}}
---

# QClaw OpenClaw CLI

## MANDATORY — 必读

**本环境没有全局安装 `openclaw` CLI。** 直接执行 `openclaw` 命令会失败。

所有需要调用 openclaw CLI 的操作（包括但不限于 `config`、`cron`、`skills`、`plugins`、`models`、`status` 等），
**必须且只能**通过本 skill 提供的 wrapper 脚本执行。不要尝试：

- ❌ `openclaw config get ...`（全局命令不存在）
- ❌ `npx openclaw ...`（环境变量不正确）
- ❌ 直接调用 `node openclaw.mjs ...`（缺少必要的环境变量和路径）

正确做法是使用本 skill 的脚本，它会自动设置所有必要的环境变量和路径。

OpenClaw 服务由 QClaw Electron 守护进程管理（自动拉起、熔断保护），禁止通过 CLI 直接启停服务。

## 执行方式

本 skill 提供跨平台脚本，位于 skill 目录的 `scripts/` 下。脚本会自动从 `~/.qclaw/qclaw.json` 读取运行时路径和环境变量。

### macOS

```bash
bash <skill_dir>/scripts/openclaw-mac.sh <command> [args...]
```

### Windows

```cmd
<skill_dir>\scripts\openclaw-win.cmd <command> [args...]
```

> `<skill_dir>` 是本 SKILL.md 所在的目录路径。

## 允许的命令

### config — 配置管理

```bash
# 读取配置值
bash <skill_dir>/scripts/openclaw-mac.sh config get <dot.path>

# 设置配置值
bash <skill_dir>/scripts/openclaw-mac.sh config set <dot.path> <value>

# 删除配置值
bash <skill_dir>/scripts/openclaw-mac.sh config unset <dot.path>
```

示例:
```bash
# 查看当前网关端口
bash <skill_dir>/scripts/openclaw-mac.sh config get gateway.port

# 设置默认模型
bash <skill_dir>/scripts/openclaw-mac.sh config set agents.defaults.model.primary "claude-sonnet-4-20250514"
```

### cron — 定时任务

```bash
# 列出所有定时任务
bash <skill_dir>/scripts/openclaw-mac.sh cron list

# 添加定时任务
bash <skill_dir>/scripts/openclaw-mac.sh cron add --trigger "<cron_expression>" --action "<prompt>"

# 编辑定时任务
bash <skill_dir>/scripts/openclaw-mac.sh cron edit <job_id> --trigger "<cron_expression>"

# 启用/禁用定时任务
bash <skill_dir>/scripts/openclaw-mac.sh cron enable <job_id>
bash <skill_dir>/scripts/openclaw-mac.sh cron disable <job_id>

# 删除定时任务
bash <skill_dir>/scripts/openclaw-mac.sh cron rm <job_id>

# 立即运行（调试）
bash <skill_dir>/scripts/openclaw-mac.sh cron run <job_id>

# 查看执行历史
bash <skill_dir>/scripts/openclaw-mac.sh cron runs

# 查看调度器状态
bash <skill_dir>/scripts/openclaw-mac.sh cron status
```

### models — 模型配置

```bash
# 查看已配置模型
bash <skill_dir>/scripts/openclaw-mac.sh models list

# 查看模型状态
bash <skill_dir>/scripts/openclaw-mac.sh models status

# 设置默认模型
bash <skill_dir>/scripts/openclaw-mac.sh models set <model_id>

# 设置图像模型
bash <skill_dir>/scripts/openclaw-mac.sh models set-image <model_id>

# 管理模型别名
bash <skill_dir>/scripts/openclaw-mac.sh models aliases --help

# 管理 fallback 列表
bash <skill_dir>/scripts/openclaw-mac.sh models fallbacks --help
```

### skills — Skills 管理

```bash
# 列出所有 skills
bash <skill_dir>/scripts/openclaw-mac.sh skills list

# 查看 skill 详情
bash <skill_dir>/scripts/openclaw-mac.sh skills info <skill_name>

# 检查 skills 就绪状态
bash <skill_dir>/scripts/openclaw-mac.sh skills check
```

### plugins — 插件管理

```bash
# 列出所有插件
bash <skill_dir>/scripts/openclaw-mac.sh plugins list

# 查看插件详情
bash <skill_dir>/scripts/openclaw-mac.sh plugins info <plugin_id>

# 启用/禁用插件
bash <skill_dir>/scripts/openclaw-mac.sh plugins enable <plugin_id>
bash <skill_dir>/scripts/openclaw-mac.sh plugins disable <plugin_id>

# 安装/卸载插件
bash <skill_dir>/scripts/openclaw-mac.sh plugins install <path_or_spec>
bash <skill_dir>/scripts/openclaw-mac.sh plugins uninstall <plugin_id>

# 诊断插件问题
bash <skill_dir>/scripts/openclaw-mac.sh plugins doctor
```

### agents — Agent 工作区管理

```bash
# 列出 agents
bash <skill_dir>/scripts/openclaw-mac.sh agents list

# 添加新 agent
bash <skill_dir>/scripts/openclaw-mac.sh agents add <name>

# 删除 agent
bash <skill_dir>/scripts/openclaw-mac.sh agents delete <name>

# 设置 agent 身份
bash <skill_dir>/scripts/openclaw-mac.sh agents set-identity <name> --emoji "🤖"
```

### channels — 通道管理

```bash
# 列出通道
bash <skill_dir>/scripts/openclaw-mac.sh channels list

# 查看通道状态
bash <skill_dir>/scripts/openclaw-mac.sh channels status

# 查看通道能力
bash <skill_dir>/scripts/openclaw-mac.sh channels capabilities

# 查看通道日志
bash <skill_dir>/scripts/openclaw-mac.sh channels logs
```

### gateway — 网关状态查询（只读）

```bash
# 查看网关详细状态（只读，不操作服务）
bash <skill_dir>/scripts/openclaw-mac.sh gateway status
```

### 其他允许的命令

```bash
# 系统状态
bash <skill_dir>/scripts/openclaw-mac.sh status

# 网关健康检查
bash <skill_dir>/scripts/openclaw-mac.sh health

# 诊断
bash <skill_dir>/scripts/openclaw-mac.sh doctor

# 安全审计
bash <skill_dir>/scripts/openclaw-mac.sh security audit

# 记忆搜索
bash <skill_dir>/scripts/openclaw-mac.sh memory search <query>
bash <skill_dir>/scripts/openclaw-mac.sh memory status

# 会话列表
bash <skill_dir>/scripts/openclaw-mac.sh sessions list

# 日志查看
bash <skill_dir>/scripts/openclaw-mac.sh logs --follow

# 执行审批管理
bash <skill_dir>/scripts/openclaw-mac.sh approvals get
bash <skill_dir>/scripts/openclaw-mac.sh approvals allowlist --help

# 更新检查（仅查看状态，不执行更新）
bash <skill_dir>/scripts/openclaw-mac.sh update status
```

## 禁止的命令

以下命令**绝对禁止执行**，OpenClaw 服务生命周期由 QClaw Electron 守护进程统一管理：

| 命令 | 原因 |
|------|------|
| `gateway run/start/stop/restart` | 服务由 Electron ProcessSupervisor 管理 |
| `gateway install/uninstall` | 系统服务安装由 Electron 控制 |

> **注意**: `gateway status` 是**允许的**，它只是查询状态，不操作服务。
| `daemon start/stop/restart` | 同上，daemon 是 gateway 的别名 |
| `daemon install/uninstall` | 同上 |
| `node start/stop` | Node host 服务管理 |
| `reset` | 破坏性操作，会清除所有本地配置和状态 |
| `uninstall` | 破坏性操作，会卸载服务和数据 |

## 重启 OpenClaw 服务

如果需要重启 OpenClaw（例如修改配置后生效），**不要使用 gateway/daemon 命令**。

正确做法：读取 `~/.qclaw/qclaw.json` 中的 PID，发送 SIGTERM 信号，Electron 守护进程会自动拉起新进程。

### macOS

```bash
# 读取 PID
PID=$(cat ~/.qclaw/qclaw.json | python3 -c "import sys,json; print(json.load(sys.stdin)['cli']['pid'])")

# 优雅终止（Electron Supervisor 会自动重启）
kill "$PID"
```

### Windows

```cmd
REM 读取 PID（使用 PowerShell 解析 JSON）
for /f %%i in ('powershell -Command "(Get-Content ~/.qclaw/qclaw.json | ConvertFrom-Json).cli.pid"') do set PID=%%i

REM 终止进程（Electron Supervisor 会自动重启）
taskkill /PID %PID%
```

> 不要使用 `kill -9` 或 `taskkill /F`，优雅终止可以让 OpenClaw 正确清理资源。

## 故障排查

### `~/.qclaw/qclaw.json` 不存在

QClaw 桌面应用未启动或未成功启动 OpenClaw 服务。请先启动 QClaw 应用。

### PID 无效（进程不存在）

OpenClaw 服务可能正在重启中。等待几秒后重新读取 `qclaw.json`，PID 会在新进程启动后更新。

### 命令执行报 Gateway 连接失败

Gateway 服务可能未就绪。先检查健康状态：

```bash
bash <skill_dir>/scripts/openclaw-mac.sh health
```

如果持续失败，通过 kill PID 触发 Electron 守护进程重启服务。

### 脚本报错找不到 Node 二进制或 openclaw.mjs

`qclaw.json` 中的路径可能已过期（应用升级后路径变化）。重启 QClaw 应用，元信息文件会自动更新。
