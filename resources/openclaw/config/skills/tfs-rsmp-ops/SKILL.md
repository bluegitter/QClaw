---
name: tfs-rsmp-ops
description: 使用 Tellhow TFS/Azure DevOps Server REST API 对 DefaultCollection 尤其是 RSMP 项目执行项目查询、工作项类型查询、WIQL 查询、工作项查看，以及在明确授权下创建或更新工作项。适用于分析 TFS 项目、查询 Bug/任务、查看工作项详情、批量检索工作项、创建或更新工作项状态。
---

# TFS RSMP Operations

用于通过 Tellhow 内部 TFS/Azure DevOps Server REST API 操作 `DefaultCollection`，重点支持 `RSMP` 项目。

## 何时使用

- 用户要查询 TFS 项目列表
- 用户要查看 `RSMP` 或其他项目的工作项类型
- 用户要通过 WIQL 检索 Bug、任务、需求等工作项
- 用户要查看某个工作项详情
- 用户明确要求创建或更新工作项

## 不适用

- Git 代码仓库浏览、分支比较或代码审查
- 需要浏览器交互登录的页面自动化
- 未明确授权的批量修改

## 已验证的认证与接口结论

- 站点：`http://dev.tellhowsoft.com/DefaultCollection`
- 认证：`NTLM`
- 已验证可访问：
  - `GET /_apis/projects?api-version=2.0`
  - `GET /{project}/_apis/wit/workitemtypes?api-version=2.0`
  - `GET /_apis/connectionData?...`

不要把密码写入 Skill 文件或提交到仓库。  
执行前通过环境变量提供凭据：

```bash
export TFS_BASE_URL="http://dev.tellhowsoft.com/DefaultCollection"
export TFS_USERNAME="your-username"
export TFS_PASSWORD="your-password"
```

如未设置 `TFS_BASE_URL`，脚本默认使用 Tellhow 的 `DefaultCollection`。

## 标准工具

统一使用：

- `scripts/tfs_client.py`

## 常用操作

### 1. 查询项目列表

```bash
python3 {baseDir}/scripts/tfs_client.py list-projects
```

### 2. 查询项目工作项类型

```bash
python3 {baseDir}/scripts/tfs_client.py list-work-item-types --project RSMP
```

### 3. 通过 WIQL 查询工作项

```bash
python3 {baseDir}/scripts/tfs_client.py query-wiql \
  --project RSMP \
  --wiql "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.TeamProject] = 'RSMP' ORDER BY [System.ChangedDate] DESC"
```

### 4. 查看工作项详情

```bash
python3 {baseDir}/scripts/tfs_client.py get-work-item --project RSMP --id 12345
```

### 5. 创建工作项

仅当用户明确要求创建时才执行。

```bash
python3 {baseDir}/scripts/tfs_client.py create-work-item \
  --project RSMP \
  --type Bug \
  --title "示例缺陷标题" \
  --description "示例缺陷描述"
```

支持的扩展创建参数：

- `--activity`
- `--original-estimate`
- `--remaining-work`
- `--target-date`
- `--parent-id`

例如创建一个带父子关系的开发任务：

```bash
python3 {baseDir}/scripts/tfs_client.py create-work-item \
  --project RSMP \
  --type "任务" \
  --title "OS245流程合并加锁问题代码开发" \
  --description "完成情景“【OS245平台】流程合并加锁问题完善”（1475545）的代码开发工作。" \
  --assigned-to "李超 <TELLHOW\\lichao>" \
  --area-path "RSMP" \
  --iteration-path "RSMP\\迭代5-2026" \
  --activity "开发" \
  --original-estimate 8 \
  --remaining-work 8 \
  --target-date "2026-03-31T16:00:00Z" \
  --parent-id 1475545
```

### 5.1 RSMP 项目中“任务”类型的已验证必填字段

在 `RSMP` 项目里，创建 `任务` 类型时，除标题外，实测还可能被流程规则要求提供以下字段，否则会返回 `TF401320`：

- `Microsoft.VSTS.Common.Activity`（活动）
- `Microsoft.VSTS.Scheduling.OriginalEstimate`（初始估计）
- `Microsoft.VSTS.Scheduling.RemainingWork`（剩余工作）
- `Microsoft.VSTS.Scheduling.TargetDate`（目标日期）

已验证案例：以 `1475545` 用户情景创建开发任务时，缺少上述字段会依次触发校验错误。

处理建议：

- 创建 `任务` 前，先查看父工作项详情，尽量继承：
  - `System.AreaPath`
  - `System.IterationPath`
  - `System.AssignedTo`
  - `Microsoft.VSTS.Scheduling.TargetDate`
- 如果任务语义是“完成代码开发”，优先使用：
  - `活动` = `开发`
- `初始估计` / `剩余工作` 若用户未明确指定，可先参考同人、同迭代、同类任务的常见取值，再向用户回显确认或按项目惯例填写。
- 若脚本参数不足以表达这些字段或父子关联，可直接使用 TFS REST API 的 JSON Patch 方式创建，并在 `relations` 中补 `Hierarchy-Reverse` 父项关系。


### 6. 更新工作项

仅当用户明确要求更新时才执行。

```bash
python3 {baseDir}/scripts/tfs_client.py update-work-item \
  --project RSMP \
  --id 12345 \
  --state 已关闭 \
  --history "已按要求处理"
```

支持的扩展更新参数：

- `--activity`
- `--original-estimate`
- `--remaining-work`
- `--target-date`

例如更新任务工时与目标日期：

```bash
python3 {baseDir}/scripts/tfs_client.py update-work-item \
  --project RSMP \
  --id 1476865 \
  --activity "开发" \
  --original-estimate 8 \
  --remaining-work 4 \
  --target-date "2026-03-31T16:00:00Z" \
  --history "更新开发任务工时与目标日期"
```


## 执行规则

- 默认优先做只读查询
- 涉及创建、修改、状态流转、指派时，必须确保用户已明确说明要变更什么
- 创建或更新前，先回显拟提交的关键字段
- 如果接口返回 401/403，明确说明认证或权限问题
- 如果接口返回 404，先检查 URL 是否在 collection 级还是 project 级
- 输出结果时优先提炼关键信息，不要原样倾倒超长 JSON

## 故障排查

- 如果 Basic 认证失败，不要继续假设密码错误；此站点已验证应优先尝试 `NTLM`
- 如果 `/{project}/_apis/projects` 返回 404，说明项目级路径不适合该接口，应改用 collection 级 `/_apis/projects`
- 如果需要进一步分析可用资源位置，查询：

```bash
python3 {baseDir}/scripts/tfs_client.py connection-data
```
