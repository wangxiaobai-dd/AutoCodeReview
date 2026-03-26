const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const { marked } = require('marked');
const hljs = require('highlight.js');

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

function showInfo(msg) { vscode.window.showInformationMessage(`[AutoCodeReview] ${msg}`); }
function showWarn(msg) { vscode.window.showWarningMessage(`[AutoCodeReview] ${msg}`); }
function showError(msg) { vscode.window.showErrorMessage(`[AutoCodeReview] ${msg}`); }
function setStatus(msg) { vscode.window.setStatusBarMessage(`[AutoCodeReview] ${msg}`); }

// ─── 执行前清理（diff + 当日结果 + done 标记）────────────────────────
function clearBeforeRun({ targetDir, resultDir, resultFile }) {
    // 清理 targetDir 下历史 diff
    try {
        if (fs.existsSync(targetDir)) {
            for (const f of fs.readdirSync(targetDir)) {
                if (f.endsWith('.diff')) {
                    try { fs.unlinkSync(path.join(targetDir, f)); } catch { }
                }
            }
        }
    } catch (e) {
        log(`清理 diff 失败（忽略）: ${e.message}`);
    }

    // 清理当日结果文件
    try {
        if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
    } catch { }

    // 清理当日 HTML 报告
    try {
        const base = path.basename(resultFile);
        const htmlPath = path.join(path.dirname(resultFile), `${base}.html`);
        if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
    } catch { }

    // 清理 done 标记文件：ai_result.YYYY-MM-DD.*.done
    try {
        const base = path.basename(resultFile);
        if (fs.existsSync(resultDir)) {
            for (const f of fs.readdirSync(resultDir)) {
                if (f.startsWith(`${base}.`) && f.endsWith('.done')) {
                    try { fs.unlinkSync(path.join(resultDir, f)); } catch { }
                }
            }
        }
    } catch { }
}

// ─── 激活入口 ─────────────────────────────────────────────
async function activate(context) {
    log('插件已激活');
    try {
        loadReportTemplate(context);
    } catch (e) {
        log(`HTML 模板加载失败：${e.message}`);
    }

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
    const diffDir = c.get('diffDir');
    const resultDir = c.get('resultDir');
    const skillFile = c.get('skillFile');
    const waitTimeout = c.get('waitTimeout') * 1000;
    const checkMode = c.get('checkMode');
    const remoteBaseUrl = c.get('remoteBaseUrl');
    const checkedApi = c.get('remoteCheckedApi').replace(/\/?$/, '/');
    const doneApi = c.get('remoteDoneApi').replace(/\/?$/, '/');
    const useDailySubDir = c.get('useDailySubDir');
    const taskName = c.get('taskName');
    const svnWorkingDir = c.get('svnWorkingDir');
    const svnAuthor = c.get('svnAuthor');
    const generateSvnDiffToday = c.get('generateSvnDiffToday');
    const includeSvnSource = c.get('includeSvnSource');
    const exportHtml = c.get('exportHtml', true);

    if (!validateConfig({ diffDir, resultDir, skillFile, taskName })) return;

    const today = new Date().toISOString().slice(0, 10);
    const resultFile = path.join(resultDir, `ai_result.${today}`);
    const targetDir = useDailySubDir ? path.join(diffDir, today) : diffDir;

    if (!fs.existsSync(targetDir)) {
        if (generateSvnDiffToday) {
            fs.mkdirSync(targetDir, { recursive: true });
        } else {
            showError(`diff 目录不存在: ${targetDir}`);
            return;
        }
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

    // 执行前清理：diff + 当日结果 + done 标记
    clearBeforeRun({ targetDir, resultDir, resultFile });

    // 可选：自动生成当天 SVN diff 文件
    if (generateSvnDiffToday) {
        if (!svnWorkingDir) {
            showError('已开启 auto-code-review.generateSvnDiffToday，但未配置 svnWorkingDir');
            return;
        }
        try {
            log(`开始生成当天 SVN diff（写入: ${targetDir}）`);
            showInfo('正在生成当天 SVN diff...');
            generateTodaySvnDiffs({ svnWorkingDir, targetDir, today, svnAuthor });
        } catch (e) {
            log(`生成 SVN diff 失败: ${e.message}`);
            showWarn(`生成 SVN diff 失败: ${e.message}`);
        }
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

    // 投递所有 diff 给 Agent（让其排队处理），同时并发等待每个 done 标记
    const initialSize = fs.existsSync(resultFile) ? fs.statSync(resultFile).size : 0;
    const waitPromises = [];
    const allDoneFiles = diffFiles.map(diffFile => {
        const { revision } = parseDiffFileName(diffFile);
        const doneFileName = sanitizeDoneName(revision);
        return `${resultFile}.${doneFileName}.done`;
    });
    const checkProgress = { doneCount: 0 };

    let savedClipboard = '';
    let clipboardSaved = false;
    try {
        savedClipboard = await vscode.env.clipboard.readText();
        clipboardSaved = true;
        log('已暂存剪贴板，投递完成后恢复');

        for (let i = 0; i < diffFiles.length; i++) {
            const diffFile = diffFiles[i];
            const diffPath = path.join(targetDir, diffFile);

            log(`投递 (${i + 1}/${diffFiles.length}): ${diffFile}`);
            setStatus(`投递中...${diffFile} (${i + 1}/${diffFiles.length})`);

            // 每个 diff 使用独立 done 标记，避免串写时误判
            // done 文件名只包含 diff 文件名里 "_" 前的版本号
            const { revision } = parseDiffFileName(diffFile);
            const doneFileName = sanitizeDoneName(revision);
            const doneFile = `${resultFile}.${doneFileName}.done`;
            if (fs.existsSync(doneFile)) {
                fs.unlinkSync(doneFile);
            }

            // 发送阶段仍按 UI 操作的节奏串行，但不会等待结果完成
            try {
                await sendToAgent(diffPath, resultFile, diffFile, skillFile, svnWorkingDir, includeSvnSource, doneFile);
            } catch (e) {
                log(`发送失败: ${diffFile} -> ${e.message}`);
                showWarn(`发送失败: ${diffFile}`);
            }

            waitPromises.push(
                waitForBlock(resultFile, initialSize, waitTimeout, doneFile, checkProgress, allDoneFiles, diffFiles)
                    .then(done => ({ diffFile, done }))
            );

            // 给 UI/Agent 一点缓冲，让排队更稳定
            if (i < diffFiles.length - 1) await delay(1000);
        }
    } finally {
        if (clipboardSaved) {
            try {
                await vscode.env.clipboard.writeText(savedClipboard);
                log('已恢复剪贴板（投递已完成）');
            } catch (e) {
                log(`恢复剪贴板失败: ${e.message}`);
            }
        }
    }

    updateCheckProgressFromDone(checkProgress, allDoneFiles, diffFiles);
    const results = await Promise.all(waitPromises);
    for (const r of results) {
        if (!r.done) {
            log(`超时未完成: ${r.diffFile}`);
            showWarn(`超时未完成: ${r.diffFile}`);
        } else {
            log(`完成: ${r.diffFile}`);
        }
    }

    log(`全部完成，结果: ${resultFile}`);
    let htmlNote = '';
    let htmlGenerated = false;
    if (exportHtml) {
        try {
            setStatus('生成 HTML 报告中...');
            const htmlPath = trySyncHtmlReport(resultFile, today);
            if (htmlPath) {
                htmlNote = ` 已生成 HTML: ${htmlPath}`;
                log(`已导出 HTML: ${htmlPath}`);
                htmlGenerated = true;
                setStatus('HTML 生成完毕');
                try {
                    // 用系统默认浏览器打开生成的报告
                    await vscode.env.openExternal(vscode.Uri.file(htmlPath));
                    log(`已在浏览器打开 HTML: ${htmlPath}`);
                } catch (e) {
                    log(`打开 HTML 失败: ${e.message}`);
                }
            } else {
                log('未生成 HTML：结果文件不存在或尚未写入');
            }
        } catch (e) {
            log(`导出 HTML 失败: ${e.message}`);
            showWarn(`导出 HTML 失败: ${e.message}`);
        }
    }
    showInfo(`全部完成，结果: ${resultFile}${htmlNote}`);
    setStatus(htmlGenerated ? '检查完成（HTML 已生成）' : '检查完成');

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
    if (!remoteBaseUrl || !doneApi || !taskName) {
        return;
    }
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
async function sendToAgent(diffPath, resultFile, diffFile, skillPath, svnWorkingDir, includeSvnSource, doneFile) {
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
        `结果追加写入文件：${resultFile}，写入头部为：${header}\n\n` +
        `本次写入完成后，请创建标记文件（空文件即可）：${doneFile}\n` +
        `创建完成即表示本次任务结束，标记文件创建完成后不要删除。`;

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
    const idx = baseName.indexOf('_');
    if (idx === -1) return { revision: baseName, submitMsg: '' };
    return {
        revision: baseName.substring(0, idx),
        submitMsg: baseName.substring(idx + 1)
    };
}

// ─── 生成当天 SVN diff 文件 ───────────────────────────────────────
function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatSvnDate(d) {
    // 使用本地时间，生成类似 2026-03-25T09:30:00
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function decodeXmlEntities(s) {
    return String(s || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (m, num) => String.fromCharCode(parseInt(num, 10)));
}

function parseSvnLogXml(xml) {
    // 解析 svn log --xml 输出，提取 revision + 第一行 commit message
    const results = [];
    const entries = [...String(xml).matchAll(/<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g)];
    for (const m of entries) {
        const revision = String(m[1]);
        const block = String(m[2]);
        const authorMatch = block.match(/<author>([\s\S]*?)<\/author>/);
        const author = authorMatch ? decodeXmlEntities(authorMatch[1]).trim() : '';
        const msgMatch = block.match(/<msg>([\s\S]*?)<\/msg>/);
        const rawMsg = msgMatch ? decodeXmlEntities(msgMatch[1]) : '';
        const firstLine = rawMsg.split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || rawMsg.trim();
        results.push({ revision, msg: firstLine, author });
    }
    return results;
}

function runSvn(args, cwd) {
    log(`runSvn: ${args.join(' ')} in ${cwd}`);
    return execFileSync('svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sanitizeDiffSubmitMsg(msg) {
    // 仍保留中文，只移除 Windows 非法字符，并把空白压成下划线
    const safe = sanitizeDoneName(msg);
    return safe.trim().replace(/\\s+/g, '_');
}

function generateTodaySvnDiffs({ svnWorkingDir, targetDir, today, svnAuthor }) {
    // 清理当天目录里旧 diff，避免重复/过期
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const existingDiffs = fs.readdirSync(targetDir).filter(f => f.endsWith('.diff'));
    for (const f of existingDiffs) {
        fs.unlinkSync(path.join(targetDir, f));
    }

    // 先更新工作区（与 CursorAgent 的 SVN 处理逻辑一致）
    try {
        runSvn(['update'], svnWorkingDir);
    } catch (e) {
        showWarn(`svn update 失败（将继续尝试生成 diff）: ${e.message}`);
        log(`svn update 错误: ${e.message}`);
    }

    const authorFilter = String(svnAuthor || '').trim();

    // 生成“当天提交”的 revision
    // 用 -r {YYYY-MM-DD:YYYY-MM-DD}，避免使用 --start-date/--end-date 兼容性问题
    const startDate = today;
    // endDate 设为 today + 1 天，避免当天后续时间段无法被包含
    const endDt = new Date(`${today}T00:00:00`);
    endDt.setDate(endDt.getDate() + 1);
    const endDate = `${endDt.getFullYear()}-${pad2(endDt.getMonth() + 1)}-${pad2(endDt.getDate())}`;
    // 与 svn_diff.go 保持一致：{start}:{end}（每个日期各自带一层大括号）
    const revRange = `{${startDate}}:{${endDate}}`;
    const xml = runSvn([
        'log',
        '-v',
        '--xml',
        '-r',
        revRange,
        '.'
    ], svnWorkingDir);

    const entries = parseSvnLogXml(xml);
    if (entries.length === 0) {
        showWarn(`当天没有可生成的 SVN 提交：${today}`);
        return;
    }

    let generatedCount = 0;
    for (const { revision, msg, author } of entries) {
        log(`revision: ${revision}, msg: ${msg}, author: ${author}`);
        const n = parseInt(revision, 10);
        if (!Number.isFinite(n)) continue;

        // 如果配置了作者过滤，只生成对应作者的 diff
        if (authorFilter && author !== authorFilter) continue;

        const prev = String(n - 1);
        let diffText = '';
        try {
            // 与参考实现保持一致：用相邻 revision 范围生成 diff（prev:rev）
            diffText = runSvn(['diff', '-r', `${prev}:${revision}`, '.'], svnWorkingDir);
        } catch (e) {
            log(`svn diff ${prev}:${revision} 失败: ${e.message}`);
            continue;
        }

        const trimmed = String(diffText || '').trim();
        if (!trimmed) continue;

        const submit = sanitizeDiffSubmitMsg(msg || 'no_msg').slice(0, 80);
        let fileName = `${revision}_${submit}.diff`;

        // 避免同名冲突：追加序号
        let filePath = path.join(targetDir, fileName);
        if (fs.existsSync(filePath)) {
            let i = 2;
            while (true) {
                const candidate = `${revision}_${submit}_${i}.diff`;
                const candidatePath = path.join(targetDir, candidate);
                if (!fs.existsSync(candidatePath)) {
                    fileName = candidate;
                    filePath = candidatePath;
                    break;
                }
                i++;
            }
        }

        fs.writeFileSync(filePath, String(diffText), 'utf8');
        generatedCount++;
    }

    if (generatedCount === 0) {
        showWarn(`当天生成 diff 为空：${today}`);
    } else {
        showInfo(`已生成当天 SVN diff：${generatedCount} 个`);
    }
}

// ─── 构建结果头部 ─────────────────────────────────────────
function buildResultHeader(diffFile) {
    const { revision, submitMsg } = parseDiffFileName(diffFile);
    return `REVISION:${revision}\t\t${submitMsg}`;
}

// ─── 自动检测编码读取文件 ─────────────────────────────────
function readFileAuto(filePath) {
    const buf = fs.readFileSync(filePath);
    const detected = chardet.detect(buf) || 'utf-8';
    const encoding = detected === 'ISO-8859-1' ? 'GBK' : detected;
    log(`文件编码检测: ${filePath} -> ${detected} -> 使用: ${encoding}`);
    return iconv.decode(buf, encoding);
}

// ─── HTML 报告（审查结果导出）──────────────────────────────
marked.use({
    gfm: true,
    breaks: true
});

// 启用代码块语法高亮（本地依赖 highlight.js，不使用外部链接）
marked.use({
    renderer: {
        code(code, infostring) {
            const lang = String(infostring || '').trim().split(/\s+/)[0] || '';
            const safe = String(code || '');
            let html = '';
            try {
                if (lang && hljs.getLanguage(lang)) {
                    html = hljs.highlight(safe, { language: lang, ignoreIllegals: true }).value;
                } else {
                    html = hljs.highlightAuto(safe).value;
                }
            } catch (e) {
                log(`代码高亮失败: ${e.message}`);
                html = escapeHtml(safe);
            }
            const langClass = lang ? ` language-${escapeHtml(lang)}` : '';
            return `<pre><code class="hljs${langClass}">${html}</code></pre>`;
        },
        heading(text, level) {
            const t = String(text || '').trim();
            if (Number(level) === 2) {
                // 避免正文里出现 h2，改成与正文一致的段落样式
                return `<p class="md-h2">${escapeHtml(t)}</p>`;
            }
            return `<h${level}>${escapeHtml(t)}</h${level}>`;
        }
    }
});

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function sanitizeRichHtml(html) {
    return String(html)
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/javascript:/gi, '');
}

// ─── HTML 模板（从文件读取，避免把整段 HTML 写进 extension.js） ───
let reportTemplateHtml = null;

function loadReportTemplate(context) {
    if (reportTemplateHtml) return;
    const templatePath = path.join(context.extensionPath, 'media', 'report-template.html');
    reportTemplateHtml = fs.readFileSync(templatePath, 'utf-8');
    log(`已加载 HTML 模板: ${templatePath}`);
}

function applyTemplate(tpl, vars) {
    let out = tpl;
    for (const [k, v] of Object.entries(vars)) {
        // 用函数形式替换，避免 replacement string 中的 `$` 被当作特殊替换语义
        out = out.replace(new RegExp(`{{${k}}}`, 'g'), () => v);
    }
    return out;
}

function parseRevisionBlocks(raw) {
    const text = raw.replace(/^\uFEFF/, '');
    const chunks = text.split(/===\s*END\s*===/g).map(s => s.trim()).filter(Boolean);
    if (chunks.length === 0 && text.trim()) {
        chunks.push(text.trim());
    }
    return chunks.map(block => {
        const lines = block.split(/\r?\n/);
        let title = '审查条目';
        let bodyStart = 0;
        const first = lines[0] || '';
        if (first.startsWith('REVISION:')) {
            const rest = first.slice('REVISION:'.length).trim();
            const parts = rest.split(/\t+/).filter(Boolean);
            const rev = parts[0] || '';
            const msg = parts.slice(1).join(' ').trim();
            title = msg ? `${rev} — ${msg}` : (rev || title);
            bodyStart = 1;
        }
        const body = lines.slice(bodyStart).join('\n').trim();
        return { title, body };
    });
}

function renderMarkdownBody(body) {
    if (!body || !String(body).trim()) {
        return '<p class="empty">（无正文）</p>';
    }
    try {
        return sanitizeRichHtml(marked.parse(String(body)));
    } catch (e) {
        log(`Markdown 渲染失败: ${e.message}`);
        return `<pre class="md-fallback">${escapeHtml(String(body))}</pre>`;
    }
}

function buildHtmlDocumentFromTemplate({ date, blocks, sourcePath }) {
    const generated = new Date().toISOString();

    const navItems = blocks.map((b, i) => {
        const n = i + 1;
        const label = String(b.title);
        const short = label.length > 40 ? `${label.slice(0, 38)}…` : label;
        return `        <li><a href="#block-${n}" title="${escapeHtml(label)}"><span class="nav-idx">${n}</span><span class="nav-text">${escapeHtml(short)}</span></a></li>`;
    }).join('\n');

    const cards = blocks.map((b, i) => {
        const bodyHtml = renderMarkdownBody(b.body);
        return `
        <article class="card" id="block-${i + 1}">
            <header class="card-head">
                <span class="card-idx">${i + 1}</span>
                <div class="card-title">${escapeHtml(b.title)}</div>
            </header>
            <div class="md-body">${bodyHtml}</div>
        </article>`;
    }).join('\n');

    if (!reportTemplateHtml) {
        throw new Error('HTML 模板未加载：请确保 media/report-template.html 存在且已成功读取');
    }

    return applyTemplate(reportTemplateHtml, {
        DATE: escapeHtml(date),
        BLOCK_COUNT: String(blocks.length),
        SOURCE_PATH: escapeHtml(sourcePath),
        GENERATED: escapeHtml(generated),
        NAV_ITEMS: navItems,
        CARDS: cards
    });
}

/** 若结果文件存在则生成/覆盖 HTML，否则返回 null（不打断主流程） */
function trySyncHtmlReport(resultFile, today) {
    if (!fs.existsSync(resultFile)) {
        log('HTML 跳过：结果文件不存在');
        return null;
    }
    return writeResultHtmlReport(resultFile, today);
}

function writeResultHtmlReport(resultFile, today) {
    const raw = readFileAuto(resultFile);
    const blocks = parseRevisionBlocks(raw);
    const base = path.basename(resultFile);
    const htmlPath = path.join(path.dirname(resultFile), `${base}.html`);
    const html = buildHtmlDocumentFromTemplate({
        date: today,
        blocks: blocks.length ? blocks : [{ title: '（无内容）', body: '' }],
        sourcePath: resultFile
    });
    fs.writeFileSync(htmlPath, html, 'utf-8');
    return htmlPath;
}

// ─── 模拟 Enter 键 ────────────────────────────────────────
async function pressEnter() {
    const robot = require('robotjs');
    robot.keyToggle('enter', 'down');
    robot.keyToggle('enter', 'up');
    log('Enter 发送成功');
}

// ─── 根据 done 文件 + 已消费数量更新状态栏：当前文件名 + (cur/total) ─────
function updateCheckProgressFromDone(progress, allDoneFiles, diffFiles) {
    const total = diffFiles.length;
    if (total === 0) return;
    const pending = allDoneFiles.filter(f => fs.existsSync(f)).length;
    const finished = progress.doneCount + pending;
    const cur = Math.min(finished + 1, total);
    const name = diffFiles[cur - 1];
    setStatus(`检查中... ${name} (${cur}/${total})`);
}

// ─── 等待单个结果块写入 ───────────────────────────────────
async function waitForBlock(filePath, sizeBefore, timeout, doneFile, progress, allDoneFiles, diffFiles) {
    const interval = 2000;
    let elapsed = 0;
    while (elapsed < timeout) {
        if (doneFile && fs.existsSync(doneFile)) {
            // done 标记文件本身就是“本次任务完成”的信号
            // 直接删除 done 并结束等待，避免由于文件增长判断导致标记无法清理
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(doneFile); // 使用完删除 done 标记
                progress.doneCount++;
                return true;
            }
        }
        updateCheckProgressFromDone(progress, allDoneFiles, diffFiles);
        await delay(interval);
        elapsed += interval;
    }
    return false;
}

function sanitizeDoneName(name) {
    // 只替换 Windows 文件名不允许的字符，保留中文等 Unicode
    return String(name).replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '_');
}

// ─── 关闭窗口 ─────────────────────────────────────────────
async function closeWindow(active) {
    if (!active) {
        await delay(10000);
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
}

function deactivate() { }
module.exports = { activate, deactivate };