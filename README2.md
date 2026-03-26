# Auto Code Review

在 **Cursor** 中自动将指定目录下的 `.diff` 依次交给 Agent（Composer），按 **Skill 规则文件**（如 `check-code.md`）审查，并把结果追加写入当天的结果文件。适合配合 SVN/导出 diff 的流水线做每日代码审查。
## 功能概览

| 能力 | 说明 |
|------|------|
| 批量审查 | 读取目录内全部 `*.diff`，按文件名排序**串行**处理 |
| 按日分子目录 | 可选从 `diffDir/YYYY-MM-DD/` 读 diff（默认开启） |
| 防重复 | `local`：今日结果文件已存在则跳过；`remote`：询问远端是否已检查 |
| 源文件引用 | 可选解析 diff 中的路径，在 prompt 中附加 `@本地绝对路径` |
| 手动/自动 | 命令面板手动触发；或 `autoStart=true` 时扩展激活后约 3 秒自动跑一次 |

## 前置条件

1. **Cursor**（本扩展依赖 Cursor 提供的命令，如 `composer.focusComposer`）。
2. **Composer** 可用，且扩展会：聚焦 Composer → 粘贴提示词 → 模拟 **Enter** 发送（使用 `robotjs`）。
3. **Windows** 环境下 `robotjs` 通常需与本机 Node/构建工具链匹配；若 Enter 无效，请检查是否以兼容方式安装扩展依赖。

## 安装与使用

### 仅使用扩展（一般用户）

1. 在 Cursor 中**安装本扩展**即可（例如：**扩展视图** → **从 VSIX 安装…** 选择打包好的 `.vsix`；若已发布到扩展市场则直接搜索安装）。依赖会随扩展一并带上，**无需**在本机对仓库执行 `npm install`。
2. 在设置中配置 **必填项**（见下），保存后：
   - **手动**：命令面板执行 `Auto Code Review: 手动触发代码检查`（命令 ID：`auto-code-review.run`）。
   - **自动**：将 `auto-code-review.autoStart` 设为 `true`，启动 Cursor 后约 3 秒会自动尝试执行一次检查。

### 从源码开发与调试

克隆本仓库后，在仓库根目录执行 `npm install` 安装开发依赖，再用 Cursor 打开项目，按 **F5** 启动扩展开发宿主进行调试。

> **注意**：自动触发且非手动命令时，若今日已在 `local` 模式下判定「已检查」，会直接跳过；手动触发会先**清空**当日结果文件再重新跑。

## 配置说明

在 Cursor/VS Code 设置中搜索 **Auto Code Review**，或在 `settings.json` 中写入。

### 必填项

| 配置键 | 说明 |
|--------|------|
| `auto-code-review.diffDir` | diff 根目录。若 `useDailySubDir=true`，实际读取 `diffDir/YYYY-MM-DD/*.diff`。 |
| `auto-code-review.resultDir` | 审查结果输出目录（不存在会自动创建）。 |
| `auto-code-review.skillFile` | 审查用的 Skill/规则文件路径（建议填**绝对路径**，如 `check-code.md`）。 |
| `auto-code-review.taskName` | 任务名，用于远端接口路径中的 `<task>` 段（见下文）。**不能为空**。 |

### 常用可选项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `auto-code-review.useDailySubDir` | boolean | `true` | `true`：从 `diffDir/当天日期/` 读 diff；`false`：直接从 `diffDir` 读。 |
| `auto-code-review.autoStart` | boolean | `false` | 扩展激活后是否延迟约 3 秒自动执行一次检查。 |
| `auto-code-review.waitTimeout` | number | `600` | **单个 diff** 等待对应的 `done` 标记文件创建（空文件）的超时时间，单位 **秒**（内部会 ×1000 转为毫秒）。 |
| `auto-code-review.checkMode` | `"local"` \| `"remote"` | `"local"` | `local`：若当日结果文件已存在则视为已检查；`remote`：GET 远端接口判断是否已检查。 |
| `auto-code-review.remoteBaseUrl` | string | `http://127.0.0.1:9150` | 远端服务根地址。 |
| `auto-code-review.remoteCheckedApi` | string | `/api/review/checked` | 「是否已检查」接口路径前缀；最终 URL 见下文。 |
| `auto-code-review.remoteDoneApi` | string | `/api/review/done` | 「检查完成」接口路径前缀。 |
| `auto-code-review.svnWorkingDir` | string | `""` | SVN 工作区根目录；与 `includeSvnSource` 配合使用。 |
| `auto-code-review.includeSvnSource` | boolean | `true` | 为 `true` 且配置了 `svnWorkingDir` 时，会从 diff 中解析文件路径并附加 `@绝对路径` 引用。 |
| `auto-code-review.generateSvnDiffToday` | boolean | `true` | 是否在开始检查前自动生成当天 SVN diff（写入 `diffDir/当天日期/` 或 `diffDir/` 取决于 `useDailySubDir`）。需要配置 `svnWorkingDir` 且本机可调用 `svn` 命令。 |
| `auto-code-review.svnAuthor` | string | `""` | SVN 作者过滤：不填/留空则生成当天所有作者 diff；填写作者后仅生成该作者的 diff。 |
| `auto-code-review.exportHtml` | boolean | `true` | 全部 diff 处理完后，是否在结果目录额外生成 **`ai_result.YYYY-MM-DD.html`**（亮色排版、右侧条目导航、Markdown 渲染）。 |

### 配置示例（`settings.json`）

```json
{
  "auto-code-review.diffDir": "D:\\CursorAgent\\output",
  "auto-code-review.useDailySubDir": true,
  "auto-code-review.resultDir": "D:\\CursorAgent\\results",
  "auto-code-review.skillFile": "D:\\CursorAgent\\skills\\check-code.md",
  "auto-code-review.taskName": "code-review",
  "auto-code-review.autoStart": false,
  "auto-code-review.waitTimeout": 600,
  "auto-code-review.checkMode": "local",
  "auto-code-review.remoteBaseUrl": "http://127.0.0.1:9150",
  "auto-code-review.remoteCheckedApi": "/api/review/checked",
  "auto-code-review.remoteDoneApi": "/api/review/done",
  "auto-code-review.svnWorkingDir": "",
  "auto-code-review.svnAuthor": "",
  "auto-code-review.includeSvnSource": true,
  "auto-code-review.exportHtml": true
}
```

## 远端接口约定（`checkMode: remote`）

扩展会规范化路径（保证接口路径以 `/` 结尾再拼接 `taskName`）：

- **是否已检查**（GET）  
  `{remoteBaseUrl}{remoteCheckedApi}{taskName}?date=YYYY-MM-DD`  
  期望响应 JSON 中包含 `"checked": true` 表示今日已检查过。

- **检查完成通知**（POST）  
  `{remoteBaseUrl}{remoteDoneApi}{taskName}?date=YYYY-MM-DD`  
  请求体示例：`{ "resultFile": "<绝对路径>", "finishedAt": "<ISO8601>" }`。

本地模式不会强制要求远端服务可用；全部 diff 处理完后仍会**尝试**调用「完成」接口，失败仅打日志。

## 结果文件

- **路径**：`{resultDir}/ai_result.YYYY-MM-DD`
- **文件名中的 revision 信息**：若 diff 文件名为 `12345_修复某bug.diff`，则提示 Agent 写入的头部为：  
  `REVISION:12345		修复某bug`  
  （无下划线时整段 basename 视为 revision。）
- **完成判定**：扩展会等待 Agent 创建并触发后写入完成的 `done` 标记文件（空文件，位于 `{resultDir}` 下；文件名形如 `ai_result.YYYY-MM-DD.<revision>.done`）后才认为本条 diff 完成。请确保 Skill/提示词要求 Agent 在写入结果后创建该标记；`=== END ===` 主要用于 HTML 报告分块。
- **HTML 报告**（默认开启）：与文本同目录生成 `ai_result.YYYY-MM-DD.html`。亮色主题，右侧固定导航可跳转到各 Revision；按 `=== END ===` 分块渲染。**仅在所有 diff 检查完成后生成一次**（可用 `exportHtml` 关闭）。

## 运行期行为摘要

- 同一时间只允许**一轮**检查；重复触发会提示「已有检查在进行中」。
- 多个 diff 之间间隔约 **3 秒**。
- **非手动**触发的完整流程结束后，约 **10 秒**会执行关闭窗口（`workbench.action.closeWindow`）；手动触发不会因此自动关窗。

## 常见问题

| 现象 | 处理建议 |
|------|----------|
| 提示未配置 `diffDir` / `resultDir` / `skillFile` / `taskName` | 在设置中补全四项必填。 |
| `diff 目录不存在` | 确认 `useDailySubDir` 与目录结构一致；当天应对应 `diffDir/YYYY-MM-DD/`。 |
| 一直超时未完成 | 增大 `waitTimeout`（秒）；确认 Agent 确实在往结果文件写入内容后创建了对应的 `done` 标记文件（空文件即可）；如生成 HTML 需要，Skill 仍应输出 `=== END ===`。 |
| Enter 未生效 / 无反应 | 检查 Composer 是否在前台、`robotjs` 是否安装成功、焦点是否被其他窗口抢占。 |
| 自动检查「今日已检查过」 | `local` 模式下删除或改名当日 `ai_result.YYYY-MM-DD`，或使用命令手动触发（会清空当日文件后重跑）。 |

## 核心工作流（运行时发生了什么）
1. 扩展读取配置，确定本次要检查的 `diff` 列表（按文件名排序）。
2. 对每个 `.diff`：
   - 拼装 prompt：包含 `Skill/规则文件` 的要求、当前 diff 路径（以及可选的 `@本地源文件引用`）。
   - 通过 VS Code 命令把 prompt 粘贴到 Composer，并模拟 `Enter` 触发提交。
   - 在本地并发等待该条任务对应的 `done` 标记文件创建（空文件，扩展拿到后会删除）。
3. 全部 `diff` 完成后，可选导出 HTML 报告。
4. 全部 `diff` 完成后：若 `remoteBaseUrl` / `remoteDoneApi` / `taskName` 配置齐全，扩展会尝试调用远端“完成”接口；否则跳过（只打日志不抛出）。

## 项目组成（你可以把它当作哪些模块）
- `extension.js`：扩展入口与核心流程（投递/等待/导出/通知）。
- `media/report-template.html`：HTML 报告的模板与样式（用于渲染右侧导航与亮色主题）。
- `skillFile`（例如 `check-code.md`）：你定义的“如何检查代码”的规则，扩展会把它当作提示词依据。

## 剪贴板与焦点行为
- 为了投递 prompt，扩展会临时覆写剪贴板并触发一次粘贴。
- **投递所有 diff 完成后**，扩展会把剪贴板恢复为用户投递前的原始内容，避免影响你后续复制/粘贴。
- 由于投递依赖“当前窗口焦点 + Composer 命令”，如果 Enter 或粘贴未生效，优先确认 Composer 是否仍在前台。

## Skill 输出约定（决定“结果长什么样”）
扩展认为“单条 diff 完成”的信号来自 `done` 标记文件（空文件），你的 Skill/提示词需要配合要求 Agent：
- 写入结果（并建议包含 `REVISION:<revision>` 头部，头部中包含修复说明，来自 diff 文件名）
- 写入完成后创建对应的 `done` 标记文件（扩展会等待它出现并在拿到后删除）

同时，若你开启 `exportHtml=true`，建议在结果文本中包含 `=== END ===`，因为 HTML 会按 `=== END ===` 分块渲染。

## HTML 报告约定
- 当 `exportHtml=true` 时，扩展在全部 diff 完成后生成：`ai_result.YYYY-MM-DD.html`
- 报告会按 `=== END ===` 分块渲染，并为每个 revision 提供可跳转导航
- 只在全部 diff 完成后生成一次；需要快速排查时可以临时关闭 `exportHtml` 降低额外步骤

