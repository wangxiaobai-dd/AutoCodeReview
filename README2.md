# Auto Code Review — 补充说明

本文档配合根目录 **README.md** 使用，补充约定、开发调试与排错；**日常使用请优先看 README.md**。

## 与 README 的关系

- **README.md**：如何用（CLI / UI）、配置项、命令与输出文件路径。  
- **本文档**：结果与 Skill 约定、UI 模式下的 `done` 机制、源码调试、常见问题。

## 审查范围与 diff 来源

- 扩展按文件名排序**串行**处理目录内全部 `*.diff`。  
- 扩展以必填项 **`svnWorkingDir`** 为根解析 diff 中的路径；当引用到的源文件中**不包含 `.h` / `.cpp`** 时，该条 diff 可能被跳过（不写入审查块）。  
- `generateSvnDiffToday` 为 `true` 时，会在检查前对 SVN 工作副本执行更新，并按 `svnDiffLookbackDays`、`svnAuthor` 生成 diff 文件。

## Skill 与结果格式

- 扩展会把 `skillFile` 路径写入提示词，请保证该文件对 Agent 可读。  
- 结果文本建议按块书写，块尾使用 **`=== END ===`**，以便 HTML 报告分条展示。  
- 头部行建议与扩展生成的格式一致，包含 **REVISION**、提交说明、**AUTHOR**，便于报告侧栏与按作者筛选。

## UI（Composer）模式专有

- 扩展会暂存剪贴板 → 聚焦 Composer → 粘贴提示词 → 模拟 **Enter**；全部投递结束后尝试恢复剪贴板。  
- 每条 diff 对应一个 **`.done` 空文件**（路径与结果 run 文件及 revision 相关）；扩展轮询等待该文件出现后视为本条完成。  
- 若 Enter 无效，请检查 Composer 是否在前台、`robotjs` 是否与当前环境匹配（Windows 下常见）。  
- `waitTimeout` 为单条等待秒数，超时会在输出中提示。

## Agent CLI 模式

- 启动前会检测 `agentCliCommand` 是否可执行（PATH 或绝对路径）。  
- 失败时日志中会包含 stdout/stderr 片段，便于排查。  
- `agentCliEnv` 按行解析为环境变量，适合配置 `NODE_EXTRA_CA_CERTS` 等。

## 从源码调试

克隆仓库后在根目录执行 `npm install`，用 Cursor/VS Code 打开工程，**F5** 启动扩展开发宿主；仓库内修改 `extension.js`、`media/report-template.html` 后重新加载窗口或重启宿主即可验证。

## 常见问题

| 现象 | 建议 |
|------|------|
| 提示未配置 `diffDir` / `resultDir` / `skillFile` / `svnWorkingDir` |
| 开启 CLI 但提示命令不可用 | 检查 `agentCliCommand`、PATH，或改为可执行文件的绝对路径。 |
| `diff 目录不存在` | 确认 `useDailySubDir` 与目录是否一致；或开启 `generateSvnDiffToday`（需本机 `svn` 可用）。 |
| UI 模式一直超时 | 增大 `waitTimeout`；确认 Agent 已写入结果并创建 `.done`；确认 Composer 与焦点正常。 |
| 今日已检查过 | 删除或改名 `ai_result.YYYY-MM-DD`，或使用**手动触发**（会清空当日结果再跑）。 |

## 仓库主要文件

| 路径 | 作用 |
|------|------|
| `extension.js` | 扩展入口、配置、SVN diff、CLI/UI 审查、结果与 HTML 生成。 |
| `media/report-template.html` | HTML 报告模板与样式。 |
| `package.json` | 命令与配置项声明（以实际文件为准）。 |
