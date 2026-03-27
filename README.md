# Auto Code Review

在 **Cursor / VS Code** 中读取目录下的 `.diff`，按 Skill 规则做代码审查，并把结果写入当日结果文件；可选生成 HTML 报告。

## 两种审查方式

| 方式 | 配置 | 说明 |
|------|------|------|
| **Agent CLI**（默认） | `useAgentCli: true` | 通过子进程执行配置的命令（如 `agent`），直接拿到输出并写入结果文件，**不**经过 Composer 剪贴板。需本机可调用该命令（PATH 或绝对路径）。 |
| **UI（Composer）** | `useAgentCli: false` | 扩展将提示词写入剪贴板并投递到 **Composer**，依赖界面与 **Enter** 自动化（`robotjs`）。需人工保证 Composer 可用；扩展会等待每条任务对应的 **`.done` 空标记文件** 表示完成。 |

按需任选其一；一般优先使用 **CLI**，更稳定、可脚本化。

## 安装

在 Cursor 中：**扩展** → **从 VSIX 安装…**，选择本仓库打包的 `.vsix`。

## 配置

在设置中搜索 **Auto Code Review**，或在用户 `settings.json` 中配置。

### 必填

| 配置键 | 说明 |
|--------|------|
| `auto-code-review.diffDir` | 存放 `.diff` 的根目录。若开启按日分子目录，则实际读取 `diffDir/YYYY-MM-DD/*.diff`。 |
| `auto-code-review.resultDir` | 审查结果输出目录（不存在会自动创建）。 |
| `auto-code-review.skillFile` | 审查规则文件路径，建议**绝对路径**。 |
| `auto-code-review.svnWorkingDir` | SVN 工作副本根目录。用于解析 diff 路径、附加源文件引用、生成 SVN diff、`.h/.cpp` 过滤等。 |


### 开启 Agent CLI 时

| 配置键 | 说明 |
|--------|------|
| `auto-code-review.useAgentCli` | `true`（默认）使用 CLI。 |
| `auto-code-review.agentCliCommand` | 可执行命令名或路径，例如 `agent`。 |
| `auto-code-review.agentCliModel` | 模型参数；`auto` 或留空表示不显式指定。 |
| `auto-code-review.agentCliEnv` | 可选。多行 `KEY=VALUE`，合并进 CLI 子进程环境（如证书路径）。 |

### 常用可选项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `auto-code-review.useDailySubDir` | `true` | `true`：从 `diffDir/当天日期/` 读 diff；`false`：直接从 `diffDir` 读。 |
| `auto-code-review.generateSvnDiffToday` | `true` | 是否在检查前用 `svn` 自动生成当日（或可配置回溯天数）的 diff 到上述 diff 目录。需本机已安装 `svn` 命令。 |
| `auto-code-review.svnAuthor` | `""` | 仅当自动生成 SVN diff 时：留空表示所有作者；填写则只生成该作者的提交 diff。 |
| `auto-code-review.svnDiffLookbackDays` | `0` | 自动生成 SVN diff 时，`svn log` 覆盖从「今天」往前共 **N+1** 个日历日（含今天）。`0` 表示只包含当天。 |
| `auto-code-review.exportHtml` | `true` | 是否在结果同目录生成 **`ai_result.YYYY-MM-DD.html`**。 |
| `auto-code-review.waitTimeout` | `600` | **仅 UI 模式**：等待单条任务完成（`.done` 文件）的超时时间，单位**秒**。 |

### 配置示例

```json
{
  "auto-code-review.diffDir": "D:\\review\\diffs",
  "auto-code-review.useDailySubDir": true,
  "auto-code-review.resultDir": "D:\\review\\results",
  "auto-code-review.skillFile": "D:\\skills\\code-review-skill\\SKILL.md",
  "auto-code-review.useAgentCli": true,
  "auto-code-review.agentCliCommand": "agent",
  "auto-code-review.svnWorkingDir": "D:\\my-svn-wc",
  "auto-code-review.generateSvnDiffToday": true,
  "auto-code-review.exportHtml": true
}
```

## 如何使用

1. 按上表完成配置并保存。  
2. 确保当日要审查的 `.diff` 已出现在 `diffDir`（或对应日期子目录）中；若开启「当天生成 SVN diff」，扩展会先执行 `svn` 生成/更新 diff。  
3. 打开命令面板，执行：**`Auto Code Review: 手动触发代码检查`**（命令 ID：`auto-code-review.run`）。  
4. 同一时间只进行一轮检查；若已在运行中会提示等待完成。

说明：非手动自动触发（若你自行绑定）时，若当日固定结果文件 `ai_result.YYYY-MM-DD` 已存在，会视为今日已检查并跳过；**手动触发**会先清空当日该结果文件再执行。

## 输出结果

- **主结果文件（固定当天名）**：`{resultDir}/ai_result.YYYY-MM-DD`  
  每次运行内部先写入带时间戳的 run 文件，结束后**复制**到上述固定文件名，便于固定路径查看与「今日是否已跑」判断。
- **单次运行原始文件**：形如 `ai_result.YYYY-MM-DD.run-<时间戳>`，与上面固定文件内容一致时以本次 run 为准。
- **HTML 报告**（`exportHtml` 为 `true`）：`{resultDir}/ai_result.YYYY-MM-DD.html`，按 `=== END ===` 分块，侧栏可跳转；可按作者筛选（由结果头中的作者信息解析）。
- **单条 diff 对应的结果块**：建议 Skill 要求写入头部，格式含 **REVISION**、说明与 **AUTHOR**（扩展会按 diff 文件名与 SVN 信息生成）。正文为审查结论；块与块之间以 **`=== END ===`** 分隔便于 HTML 解析。

若使用 **UI 模式**，还需在 Skill/提示词中约定：Agent 在写完一条结果后创建对应的 **空 `.done` 文件**（扩展据此判断该条结束）；CLI 模式不依赖 `.done` 文件。
