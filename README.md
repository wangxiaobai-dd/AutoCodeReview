# Auto Code Review

在 **Cursor** 中自动将指定目录下的 `.diff` 交给 Agent（Composer）审查，并把结果追加写入当天的结果文件。本文仅说明 **本地自查（local）** 相关配置与输出格式。

## 功能概览

| 能力 | 说明 |
|------|------|
| 批量审查 | 读取目录内全部 `*.diff`，按文件名排序**串行**处理 |
| 按日分子目录 | 可选从 `diffDir/YYYY-MM-DD/` 读 diff（默认开启） |
| 防重复 | `local`：今日结果文件已存在则跳过；`remote`：询问远端是否已检查 |
| 源文件引用 | 可选解析 diff 中的路径，在 prompt 中附加 `@本地绝对路径` |

## 安装与使用

### 仅使用扩展（一般用户）

1. 在 Cursor 中**安装本扩展**即可（例如：**扩展视图** → **从 VSIX 安装…** 选择打包好的 `.vsix`。
2. 在设置中配置 **必填项**（见下），保存后：
   - 命令面板执行 `Auto Code Review: 手动触发代码检查`。

## 配置说明

在 Cursor/VS Code 设置中搜索 **Auto Code Review**，或在 `settings.json` 中写入。

### 必填项

| 配置键 | 说明 |
|--------|------|
| `auto-code-review.diffDir` | diff 根目录。若 `useDailySubDir=true`，实际读取 `diffDir/YYYY-MM-DD/*.diff`。 |
| `auto-code-review.resultDir` | 审查结果输出目录（不存在会自动创建）。 |
| `auto-code-review.skillFile` | 审查用的 Skill/规则文件路径（建议填**绝对路径**）。 |
| `auto-code-review.svnWorkingDir`  | SVN 工作区根目录；与 `includeSvnSource` / `generateSvnDiffToday` 配合使用。 |

### 常用可选项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `auto-code-review.useDailySubDir` | boolean | `true` | `true`：从 `diffDir/当天日期/` 读 diff；`false`：直接从 `diffDir` 读。 |
| `auto-code-review.checkMode` | `"local"` | `local` | 本地自查：若当日结果文件已存在则视为已检查。 |
| `auto-code-review.includeSvnSource` | boolean | `true` | `true` 且配置了 `svnWorkingDir` 时，会从 diff 解析文件路径并在 prompt 中附加 `@绝对路径` 引用。 |
| `auto-code-review.generateSvnDiffToday` | boolean | `true` | 是否在开始检查前自动生成当天 SVN diff（写入 `diffDir/当天日期/` 或 `diffDir/` 取决于 `useDailySubDir`）。需要配置 `svnWorkingDir` 且本机可调用 `svn` 命令。 |
| `auto-code-review.svnAuthor` | string | `""` | SVN 作者过滤：不填/留空则生成当天所有作者 diff；填写作者后仅生成该作者 diff。 |
| `auto-code-review.exportHtml` | boolean | `true` | 全部 diff 处理完后，是否在结果目录额外生成 **`ai_result.YYYY-MM-DD.html`**。 |

### 配置示例（`settings.json`）

```json
{
  "auto-code-review.diffDir": "",
  "auto-code-review.useDailySubDir": true,
  "auto-code-review.resultDir": "",
  "auto-code-review.skillFile": "",
  "auto-code-review.checkMode": "local",
  "auto-code-review.svnWorkingDir": "",
  "auto-code-review.svnAuthor": "",
  "auto-code-review.includeSvnSource": true,
  "auto-code-review.exportHtml": true
}
```

## 结果文件

- **路径**：`{resultDir}/ai_result.YYYY-MM-DD`
- **文件名中的 revision 信息**：若 diff 文件名为 `12345_修复某bug.diff`，则会提示 Agent 写入结果头部为：  
  `REVISION:12345		修复某bug`  
- **HTML 报告**（默认开启）：与文本同目录生成 `ai_result.YYYY-MM-DD.html`（可用 `exportHtml` 关闭）。



