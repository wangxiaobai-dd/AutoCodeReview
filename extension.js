const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const chardet = require('chardet');
const iconv = require('iconv-lite');

// ─── 配置 ────────────────────────────────────────────────
function cfg() {
    return vscode.workspace.getConfiguration('auto-code-review');
}

// ─── HTTP 工具 ────────────────────────────────────────────
function httpGet(url) {
    return new Promise((resolve, reject) => {
        log(`HTTP GET: ${url}`);
        http.get(url, (res) => {
            let buf = '';
            res.on('data', chunk => buf += chunk);
            res.on('end', () => {
                log(`HTTP GET 响应 [${res.statusCode}]: ${url}`);
                try { resolve(JSON.parse(buf)); }
                catch { resolve(buf); }
            });
        }).on('error', (e) => {
            log(`HTTP GET 失败 [${url}]: ${e.message}`);
            reject(e);
        });
    });
}

function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        log(`HTTP POST: ${url}`);
        const payload = JSON.stringify(body);
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let buf = '';
            res.on('data', chunk => buf += chunk);
            res.on('end', () => {
                log(`HTTP POST 响应 [${res.statusCode}]: ${url}`);
                try { resolve(JSON.parse(buf)); }
                catch { resolve(buf); }
            });
        });
        req.on('error', (e) => {
            log(`HTTP POST 失败 [${url}]: ${e.message}`);
            reject(e);
        });
        req.write(payload);
        req.end();
    });
}

// ─── 工具函数 ─────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    console.log(`[AutoCodeReview] ${msg}`);
}

function showInfo(msg)  { vscode.window.showInformationMessage(`[AutoCodeReview] ${msg}`); }
function showWarn(msg)  { vscode.window.showWarningMessage(`[AutoCodeReview] ${msg}`); }
function showError(msg) { vscode.window.showErrorMessage(`[AutoCodeReview] ${msg}`); }
function setStatus(msg) { vscode.window.setStatusBarMessage(`[AutoCodeReview] ${msg}`); }

// ─── 激活入口 ─────────────────────────────────────────────
async function activate(context) {
    log('插件已激活');

    const autoStart = cfg().get('autoStart');
    if (autoStart) {
        setTimeout(() => startReview(false), 3000);
    } else {
        log('autoStart=false，跳过自动触发');
    }

    const cmd = vscode.commands.registerCommand('auto-code-review.run', () => {
        log('手动触发');
        startReview(true);
    });
    context.subscriptions.push(cmd);
}

// ─── 防重入锁 ─────────────────────────────────────────────
let reviewing = false;

async function startReview(active = false) {
    if (reviewing) {
        log('已有检查在进行中，忽略本次触发');
        if (active) showWarn('已有检查在进行中，请等待完成后再试');
        return;
    }
    reviewing = true;
    try {
        await doReview(active);
    } finally {
        reviewing = false;
    }
}

// ─── 主流程 ───────────────────────────────────────────────
async function doReview(active = false) {
    const c = cfg();
    const diffDir        = c.get('diffDir');
    const resultDir      = c.get('resultDir');
    const skillFile      = c.get('skillFile');
    const waitTimeout    = c.get('waitTimeout') * 1000;
    const checkMode      = c.get('checkMode');
    const remoteBaseUrl  = c.get('remoteBaseUrl');
    const checkedApi     = c.get('remoteCheckedApi').replace(/\/?$/, '/');
    const doneApi        = c.get('remoteDoneApi').replace(/\/?$/, '/');
    const useDailySubDir = c.get('useDailySubDir');
    const taskName       = c.get('taskName');
    const svnWorkingDir  = c.get('svnWorkingDir');
    const includeSvnSource = c.get('includeSvnSource');

    if (!validateConfig({ diffDir, resultDir, skillFile, taskName })) return;

    const today      = new Date().toISOString().slice(0, 10);
    const resultFile = path.join(resultDir, `ai_result.${today}`);
    const targetDir  = useDailySubDir ? path.join(diffDir, today) : diffDir;

    if (!fs.existsSync(targetDir)) {
        showError(`diff 目录不存在: ${targetDir}`);
        return;
    }

    fs.mkdirSync(resultDir, { recursive: true });

    if (!active) {
        let done = false;
        try {
            done = await isDoneToday(checkMode, remoteBaseUrl, checkedApi, taskName, resultFile, today);
        } catch (e) {
            showError(`网络错误，无法询问远端：${e.message}`);
            log(`isDoneToday 网络错误: ${e.message}`);
            return;
        }
        if (done) {
            showInfo('自动检查，今日已检查过');
            return;
        }
    } else {
        if (fs.existsSync(resultFile)) {
            fs.writeFileSync(resultFile, '', 'utf-8');
            log(`已清空今日结果文件: ${resultFile}`);
        }
        showInfo('手动触发，开始检查...');
    }

    const diffFiles = fs.readdirSync(targetDir)
        .filter(f => f.endsWith('.diff'))
        .sort();

    if (diffFiles.length === 0) {
        showWarn('没有 diff 文件');
        await closeWindow(active);
        return;
    }

    log(`待检查: ${diffFiles.length} 个文件`);
    showInfo(`开始检查 ${diffFiles.length} 个文件...`);

    // 串行处理每个 diff
    for (let i = 0; i < diffFiles.length; i++) {
        const diffFile = diffFiles[i];
        const diffPath = path.join(targetDir, diffFile);

        log(`处理 (${i + 1}/${diffFiles.length}): ${diffFile}`);
        setStatus(`检查中 ${i + 1}/${diffFiles.length}: ${diffFile}`);

        // 记录发送前文件大小
        let sizeBefore = 0;
        if (fs.existsSync(resultFile)) {
            sizeBefore = fs.statSync(resultFile).size;
        }

        await sendToAgent(diffPath, resultFile, diffFile, skillFile, svnWorkingDir, includeSvnSource);

        // 等待本次结果写入
        const done = await waitForBlock(resultFile, sizeBefore, waitTimeout);
        if (!done) {
            log(`超时未完成: ${diffFile}`);
            showWarn(`超时未完成: ${diffFile}`);
        } else {
            log(`完成: ${diffFile}`);
        }

        if (i < diffFiles.length - 1) await delay(3000);
    }

    log(`全部完成，结果: ${resultFile}`);
    showInfo(`全部完成，结果: ${resultFile}`);
    setStatus('检查完成');

    await notifyDone(remoteBaseUrl, doneApi, taskName, today, resultFile);
    await closeWindow(active);
}

// ─── 配置校验 ─────────────────────────────────────────────
function validateConfig({ diffDir, resultDir, skillFile, taskName }) {
    if (!diffDir) {
        showError('未配置 diffDir，请在设置中配置 auto-code-review.diffDir');
        return false;
    }
    if (!resultDir) {
        showError('未配置 resultDir，请在设置中配置 auto-code-review.resultDir');
        return false;
    }
    if (!skillFile) {
        showError('未配置 skillFile，请在设置中配置 auto-code-review.skillFile');
        return false;
    }
    if (!taskName) {
        showError('未配置 taskName，请在设置中配置 auto-code-review.taskName');
        return false;
    }
    return true;
}

// ─── 今日是否已检查 ───────────────────────────────────────
async function isDoneToday(mode, remoteBaseUrl, checkedApi, taskName, resultFile, today) {
    if (mode === 'remote') {
        const url = `${remoteBaseUrl}${checkedApi}${taskName}?date=${today}`;
        log(`询问远端: ${url}`);
        const res = await httpGet(url);
        log(`远端返回: ${JSON.stringify(res)}`);
        return res.checked === true;
    }
    log(`本地自查: ${resultFile}`);
    return fs.existsSync(resultFile);
}

// ─── 通知远端完成 ─────────────────────────────────────────
async function notifyDone(remoteBaseUrl, doneApi, taskName, today, resultFile) {
    try {
        const url = `${remoteBaseUrl}${doneApi}${taskName}?date=${today}`;
        log(`通知远端: ${url}`);
        const res = await httpPost(url, {
            resultFile: resultFile,
            finishedAt: new Date().toISOString()
        });
        log(`已通知远端服务: ${JSON.stringify(res)}`);
    } catch (e) {
        log(`通知远端失败: ${e.message}`);
    }
}

// ─── 发送消息给 Agent ─────────────────────────────────────
async function sendToAgent(diffPath, resultFile, diffFile, skillPath, svnWorkingDir, includeSvnSource) {
    let sourceRefs = '';
    if (includeSvnSource && svnWorkingDir) {
        try {
            const diffContent = readFileAuto(diffPath);
            log(`diff 前200字符: ${diffContent.substring(0, 200)}`);

            const relPaths = parseDiffFilePaths(diffContent);
            log(`解析到的相对路径: ${JSON.stringify(relPaths)}`);

            const validPaths = relPaths
                .map(p => path.join(svnWorkingDir, p))
                .filter(p => {
                    const exists = fs.existsSync(p);
                    log(`文件是否存在 [${p}]: ${exists}`);
                    return exists;
                });

            if (validPaths.length > 0) {
                sourceRefs = '\n\n如需查看完整源文件，可参考以下文件：\n' +
                    validPaths.map(p => `@${p}`).join('\n');
                log(`附加源文件引用: ${validPaths.join(', ')}`);
            } else {
                log(`未找到对应的 SVN 源文件，relPaths: ${JSON.stringify(relPaths)}`);
            }
        } catch (e) {
            log(`解析 diff 源文件失败: ${e.message}`);
        }
    }

    const header = buildResultHeader(diffFile);

    const prompt =
    `请使用 skill 文件 ${skillPath} 检查 @${diffPath}，只输出结果，不要其他操作。` +
    `${sourceRefs}\n\n` +
    `结果追加写入文件：${resultFile}，写入头部为：${header}`;

    await vscode.commands.executeCommand('composer.focusComposer');
    await delay(2000);

    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await delay(1000);

    await pressEnter();
}

// ─── 从 SVN diff 内容解析源文件路径 ──────────────────────
function parseDiffFilePaths(diffContent) {
    const paths = new Set();
    const lines = diffContent.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        const indexMatch = trimmed.match(/^Index:\s+(.+)$/);
        if (indexMatch) {
            paths.add(indexMatch[1].trim());
            continue;
        }

        const diffMatch = trimmed.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(\s+\(.*\))?$/);
        if (diffMatch) {
            const filePath = diffMatch[1].trim();
            if (filePath !== '/dev/null' && !filePath.includes('nonexistent')) {
                paths.add(filePath);
            }
        }
    }

    return [...paths];
}

// ─── 解析 diff 文件名 ─────────────────────────────────────
function parseDiffFileName(diffFile) {
    const baseName = path.basename(diffFile, '.diff');
    const idx      = baseName.indexOf('_');
    if (idx === -1) return { revision: baseName, submitMsg: '' };
    return {
        revision:  baseName.substring(0, idx),
        submitMsg: baseName.substring(idx + 1)
    };
}

// ─── 构建结果头部 ─────────────────────────────────────────
function buildResultHeader(diffFile) {
    const { revision, submitMsg } = parseDiffFileName(diffFile);
    return `REVISION:${revision}\t\t${submitMsg}`;
}

// ─── 自动检测编码读取文件 ─────────────────────────────────
function readFileAuto(filePath) {
    const buf      = fs.readFileSync(filePath);
    const detected = chardet.detect(buf) || 'utf-8';
    const encoding = detected === 'ISO-8859-1' ? 'GBK' : detected;
    log(`文件编码检测: ${filePath} -> ${detected} -> 使用: ${encoding}`);
    return iconv.decode(buf, encoding);
}

// ─── 模拟 Enter 键 ────────────────────────────────────────
async function pressEnter() {
    const robot = require('robotjs');
    robot.keyToggle('enter', 'down');
    robot.keyToggle('enter', 'up');
    log('Enter 发送成功');
}

// ─── 等待单个结果块写入 ───────────────────────────────────
async function waitForBlock(filePath, sizeBefore, timeout) {
    const interval = 2000;
    let elapsed    = 0;
    while (elapsed < timeout) {
        if (fs.existsSync(filePath)) {
            const content    = fs.readFileSync(filePath, 'utf-8');
            const newContent = content.slice(sizeBefore);
            if (newContent.includes('=== END ===')) {
                return true;
            }
        }
        await delay(interval);
        elapsed += interval;
    }
    return false;
}

// ─── 关闭窗口 ─────────────────────────────────────────────
async function closeWindow(active) {
    if (!active) {
        await delay(10000);
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
}

function deactivate() {}
module.exports = { activate, deactivate };