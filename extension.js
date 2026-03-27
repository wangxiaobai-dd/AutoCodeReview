const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { execFileSync, execFile } = require('child_process');
const chardet = require('chardet');
const iconv   = require('iconv-lite');
const { marked } = require('marked');
const hljs    = require('highlight.js');

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════
const POLL_INTERVAL_MS  = 2000;
const MAX_BUFFER_BYTES  = 50 * 1024 * 1024;
const DIFF_EXT          = '.diff';
const DONE_EXT          = '.done';
const RESULT_PREFIX     = 'ai_result.';
const END_MARKER        = '=== END ===';

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════
const cfg = () => vscode.workspace.getConfiguration('auto-code-review');

// ═══════════════════════════════════════════════════════════
// 日志 / UI 通知
// ═══════════════════════════════════════════════════════════
const log       = msg => console.log(`[AutoCodeReview] ${msg}`);
const showInfo  = msg => vscode.window.showInformationMessage(`[AutoCodeReview] ${msg}`);
const showWarn  = msg => vscode.window.showWarningMessage(`[AutoCodeReview] ${msg}`);
const showError = msg => vscode.window.showErrorMessage(`[AutoCodeReview] ${msg}`);
const setStatus = msg => vscode.window.setStatusBarMessage(`[AutoCodeReview] ${msg}`);
const delay     = ms  => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════
// 激活入口
// ═══════════════════════════════════════════════════════════
async function activate(context) {
    log('插件已激活');
    try { loadReportTemplate(context); }
    catch (e) { log(`HTML 模板加载失败：${e.message}`); }

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-code-review.run', () => {
            log('手动触发');
            startReview(true);
        })
    );
}

// ═══════════════════════════════════════════════════════════
// 防重入锁
// ═══════════════════════════════════════════════════════════
let reviewing = false;

async function startReview(active = false) {
    if (reviewing) {
        log('已有检查在进行中，忽略本次触发');
        if (active) showWarn('已有检查在进行中，请等待完成后再试');
        return;
    }
    reviewing = true;
    try     { await doReview(active); }
    finally { reviewing = false; log('检查完成'); }
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════
async function doReview(active = false) {
    const c = cfg();
    const opts = readConfig(c);
    if (!validateConfig(opts)) return;
    if (!validateAgentCli(opts)) return;

    const today             = new Date().toISOString().slice(0, 10);
    const canonicalResult   = path.join(opts.resultDir, `${RESULT_PREFIX}${today}`);
    const runTag            = new Date().toISOString().replace(/[:.]/g, '-');
    const resultFile        = `${canonicalResult}.run-${runTag}`;
    const targetDir         = opts.useDailySubDir ? path.join(opts.diffDir, today) : opts.diffDir;

    if (!prepareDirectories({ targetDir, resultDir: opts.resultDir, generateSvnDiffToday: opts.generateSvnDiffToday })) return;

    if (!active && fs.existsSync(canonicalResult)) {
        showInfo('自动检查，今日已检查过');
        return;
    }
    if (active) {
        clearTodayResults(opts.resultDir, canonicalResult);
        showInfo('手动触发，开始检查...');
    }

    cleanupBeforeRun({ targetDir, resultDir: opts.resultDir, canonicalResult, clearDiffs: opts.generateSvnDiffToday });

    if (opts.generateSvnDiffToday) {
        if (!opts.svnWorkingDir) { showError('已开启 generateSvnDiffToday，但未配置 svnWorkingDir'); return; }
        generateTodaySvnDiffs({
            svnWorkingDir: opts.svnWorkingDir,
            targetDir,
            today,
            svnAuthor: opts.svnAuthor,
            lookbackDays: opts.svnDiffLookbackDays
        });
    }

    const diffFiles = readDiffFiles(targetDir);
    if (!diffFiles) return;

    log(`待检查: ${diffFiles.length} 个文件`);
    showInfo(`开始检查 ${diffFiles.length} 个文件...`);

    if (opts.useAgentCli) {
        await runWithAgentCli({ diffFiles, targetDir, resultFile, opts });
    } else {
        await runWithCursorAgent({ diffFiles, targetDir, resultFile, opts });
    }

    syncCanonicalResult(resultFile, canonicalResult);
    await exportHtmlIfNeeded({ resultFile, canonicalResult, today, exportHtml: opts.exportHtml });
}

// ═══════════════════════════════════════════════════════════
// 配置读取
// ═══════════════════════════════════════════════════════════
function readConfig(c) {
    return {
        diffDir:               c.get('diffDir'),
        resultDir:             c.get('resultDir'),
        skillFile:             c.get('skillFile'),
        waitTimeout:           c.get('waitTimeout') * 1000,
        useDailySubDir:        c.get('useDailySubDir'),
        svnWorkingDir:         c.get('svnWorkingDir'),
        svnAuthor:             c.get('svnAuthor'),
        generateSvnDiffToday:  c.get('generateSvnDiffToday'),
        svnDiffLookbackDays:   Math.max(0, Math.floor(Number(c.get('svnDiffLookbackDays')) || 0)),
        exportHtml:            c.get('exportHtml', true),
        useAgentCli:           c.get('useAgentCli', true),
        agentCliCommand:       String(c.get('agentCliCommand') || '').trim(),
        agentCliModel:         String(c.get('agentCliModel')   || '').trim(),
        agentCliEnv:           c.get('agentCliEnv'),
    };
}

function validateConfig({ diffDir, resultDir, skillFile, svnWorkingDir }) {
    if (!diffDir)   { showError('未配置 diffDir');   return false; }
    if (!resultDir) { showError('未配置 resultDir'); return false; }
    if (!skillFile) { showError('未配置 skillFile'); return false; }
    if (!svnWorkingDir) { showError('未配置 svnWorkingDir'); return false; }
    return true;
}

function validateAgentCli({ useAgentCli, agentCliCommand }) {
    if (!useAgentCli) return true;
    if (!agentCliCommand) { showError('已开启 useAgentCli，但未配置 agentCliCommand'); return false; }
    if (!isCommandCallable(agentCliCommand)) { showError(`Agent CLI 命令不可用: ${agentCliCommand}`); return false; }
    return true;
}

// ═══════════════════════════════════════════════════════════
// 目录 / 文件准备
// ═══════════════════════════════════════════════════════════
function prepareDirectories({ targetDir, resultDir, generateSvnDiffToday }) {
    if (!fs.existsSync(targetDir)) {
        if (generateSvnDiffToday) { fs.mkdirSync(targetDir, { recursive: true }); }
        else { showError(`diff 目录不存在: ${targetDir}`); return false; }
    }
    fs.mkdirSync(resultDir, { recursive: true });
    return true;
}

function clearTodayResults(resultDir, canonicalResult) {
    if (fs.existsSync(canonicalResult)) {
        fs.writeFileSync(canonicalResult, '', 'utf-8');
        log(`已清空今日结果文件: ${canonicalResult}`);
    }
}

function cleanupBeforeRun({ targetDir, resultDir, canonicalResult, clearDiffs }) {
    if (clearDiffs && fs.existsSync(targetDir)) {
        safeDeleteFiles(targetDir, f => f.endsWith(DIFF_EXT));
    }
    const prefix = path.basename(canonicalResult);
    safeDeleteFiles(resultDir, f => f.startsWith(prefix));
}

function safeDeleteFiles(dir, predicate) {
    try {
        for (const f of fs.readdirSync(dir)) {
            if (predicate(f)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
        }
    } catch (e) { log(`清理文件失败（忽略）: ${e.message}`); }
}

function readDiffFiles(targetDir) {
    const files = fs.readdirSync(targetDir).filter(f => f.endsWith(DIFF_EXT)).sort();
    if (files.length === 0) { showWarn('没有 diff 文件'); return null; }
    return files;
}

function syncCanonicalResult(resultFile, canonicalResult) {
    try {
        if (fs.existsSync(resultFile)) {
            fs.copyFileSync(resultFile, canonicalResult);
            log(`已写回当天结果文件: ${canonicalResult}`);
        }
    } catch (e) { log(`写回当天结果文件失败: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════
// Cursor Agent 模式（UI 操作）
// ═══════════════════════════════════════════════════════════
async function runWithCursorAgent({ diffFiles, targetDir, resultFile, opts }) {
    const { skillFile, svnWorkingDir, waitTimeout } = opts;
    const initialSize  = fs.existsSync(resultFile) ? fs.statSync(resultFile).size : 0;
    const doneFiles    = makeDoneFilePaths(diffFiles, resultFile);
    const progress     = { doneCount: 0 };
    const waitPromises = [];

    let savedClipboard = '';
    try {
        savedClipboard = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('composer.focusComposer');
        await delay(1000);

        for (let i = 0; i < diffFiles.length; i++) {
            const diffFile = diffFiles[i];
            const diffPath = path.join(targetDir, diffFile);
            const doneFile = doneFiles[i];

            log(`投递 (${i + 1}/${diffFiles.length}): ${diffFile}`);
            setStatus(`投递中... ${diffFile} (${i + 1}/${diffFiles.length})`);

            if (fs.existsSync(doneFile)) fs.unlinkSync(doneFile);

            try {
                await sendToAgent({ diffPath, resultFile, diffFile, skillFile, svnWorkingDir, doneFile });
            } catch (e) {
                log(`发送失败: ${diffFile} -> ${e.message}`);
                showWarn(`发送失败: ${diffFile}`);
            }

            waitPromises.push(
                waitForDone({ resultFile, initialSize, timeout: waitTimeout, doneFile, progress, doneFiles, diffFiles })
                    .then(done => ({ diffFile, done }))
            );
        }
    } finally {
        try { await vscode.env.clipboard.writeText(savedClipboard); } catch {}
    }

    const results = await Promise.all(waitPromises);
    for (const { diffFile, done } of results) {
        if (!done) { log(`超时未完成: ${diffFile}`); showWarn(`超时未完成: ${diffFile}`); }
        else        { log(`完成: ${diffFile}`); }
    }
}

// ═══════════════════════════════════════════════════════════
// Agent CLI 模式
// ═══════════════════════════════════════════════════════════
async function runWithAgentCli({ diffFiles, targetDir, resultFile, opts }) {
    const { skillFile, svnWorkingDir, agentCliCommand, agentCliModel } = opts;

    for (let i = 0; i < diffFiles.length; i++) {
        const diffFile = diffFiles[i];
        const diffPath = path.join(targetDir, diffFile);

        log(`CLI 检查 (${i + 1}/${diffFiles.length}): ${diffFile}`);
        setStatus(`CLI 检查中... ${diffFile} (${i + 1}/${diffFiles.length})`);

        try {
            const header   = buildResultHeader(diffFile, svnWorkingDir);
            const agentOut = await runAgentCliForDiff({
                agentCliCommand, agentCliModel,
                workDir: svnWorkingDir || targetDir,
                diffPath, diffFile, skillPath: skillFile, svnWorkingDir
            });
            if (agentOut !== null && agentOut !== undefined) {
                appendReviewBlock(resultFile, header, agentOut);
            } else {
                ensureFileExists(resultFile);
                log(`CLI 跳过: ${diffFile}`);
            }
        } catch (e) {
            log(`CLI 检查失败: ${diffFile} -> ${e.message}`);
            showWarn(`CLI 检查失败: ${diffFile}\n${e.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════
// 源文件引用（SVN）—— 公共逻辑
// ═══════════════════════════════════════════════════════════
function buildSourceRefs(diffPath, svnWorkingDir) {
    if (!svnWorkingDir) return { sourceRefs: '', hasCppOrH: true, hasAnySource: false };

    try {
        const diffContent = readFileAuto(diffPath);
        const relPaths    = parseDiffFilePaths(diffContent);
        const validPaths  = relPaths.map(p => path.join(svnWorkingDir, p)).filter(p => fs.existsSync(p));
        const hasCppOrH   = validPaths.some(p => ['.h', '.cpp'].includes(path.extname(p).toLowerCase()));

        log(`源文件解析: relPaths=${relPaths.length} valid=${validPaths.length} hasCppOrH=${hasCppOrH}`);

        if (relPaths.length > 0 && !hasCppOrH) {
            return { sourceRefs: '', hasCppOrH: false, hasAnySource: validPaths.length > 0 };
        }
        const sourceRefs = validPaths.length > 0
            ? '\n\n如需查看完整源文件，可参考以下文件：\n' + validPaths.map(p => `@${p}`).join('\n')
            : '';
        return { sourceRefs, hasCppOrH: true, hasAnySource: validPaths.length > 0 };
    } catch (e) {
        log(`解析 diff 源文件失败: ${e.message}`);
        return { sourceRefs: '', hasCppOrH: true, hasAnySource: false };
    }
}

// ═══════════════════════════════════════════════════════════
// 发送消息给 Cursor Agent（UI 模式）
// ═══════════════════════════════════════════════════════════
async function sendToAgent({ diffPath, resultFile, diffFile, skillFile, svnWorkingDir, doneFile }) {
    const { sourceRefs, hasCppOrH } = buildSourceRefs(diffPath, svnWorkingDir);

    if (!hasCppOrH) {
        log(`跳过检查（无 .h/.cpp）: ${diffFile}`);
        showInfo(`跳过检查（无 .h/.cpp）: ${diffFile}`);
        ensureFileExists(resultFile);
        fs.writeFileSync(doneFile, '', 'utf-8');
        return;
    }

    const header = buildResultHeader(diffFile, svnWorkingDir);
    const prompt =
        `请使用 skill 文件 ${skillFile} 检查 @${diffPath}，只输出结果，不要其他操作。` +
        `禁止输出「按…格式、审查结果如下」等引导语，正文从 [文件名] 或直接按 skill 结构开始。` +
        `${sourceRefs}\n\n` +
        `结果追加写入文件：${resultFile}，写入头部为：${header}\n\n` +
        `本次写入完成后，请创建标记文件（空文件即可）：${doneFile}\n` +
        `创建完成即表示本次任务结束，标记文件创建完成后不要删除。`;

    await vscode.commands.executeCommand('composer.focusComposer');
    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await pressEnter();
}

// ═══════════════════════════════════════════════════════════
// Agent CLI 执行
// ═══════════════════════════════════════════════════════════
async function runAgentCliForDiff({ agentCliCommand, agentCliModel, workDir, diffPath, diffFile, skillPath, svnWorkingDir }) {
    const { sourceRefs, hasCppOrH } = buildSourceRefs(diffPath, svnWorkingDir);
    if (!hasCppOrH) return null;

    const prompt =
        `请使用 skill 文件 ${skillPath} 检查 @${diffPath}，只输出结果，不要其他操作。` +
        `${sourceRefs}\n\n` +
        `注意：只输出审查结果正文；不要输出 REVISION 头部、${END_MARKER}、` +
        `以及「按…格式、审查结果如下」等引导语，正文从 [文件名]`;

    const absWorkDir = path.resolve(workDir || path.dirname(diffPath));
    if (!fs.existsSync(absWorkDir)) throw new Error(`工作目录不存在: ${absWorkDir}`);

    const args = ['--trust', '--workspace', absWorkDir, '--output-format', 'text'];
    if (agentCliModel && !/^auto$/i.test(agentCliModel)) args.push('--model', agentCliModel);
    args.push('-p', prompt);

    log(`[AgentCLI] ${agentCliCommand} ${args.join(' ')}`);
    const extraEnv = parseEnvLines(cfg().get('agentCliEnv'));
    const { stdout } = await execFileAsync(agentCliCommand, args, {
        cwd: absWorkDir,
        env: { ...process.env, ...extraEnv }
    });
    return stdout;
}

// ═══════════════════════════════════════════════════════════
// 结果文件操作
// ═══════════════════════════════════════════════════════════

/** 去掉模型常输出的引导语，避免结果页/HTML 顶部出现废话 */
function stripLeadingReviewFluff(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const t = lines[i].trim();
        if (t === '') {
            i++;
            continue;
        }
        if (/^审查结果如下[：:]?\s*$/.test(t)) {
            i++;
            continue;
        }
        if (/^按.+的格式[,，]\s*审查结果如下[：:]?\s*$/.test(t)) {
            i++;
            continue;
        }
        // 两行：「按 … 的格式，」+「审查结果如下：」
        if (/^按.+的格式[,，]\s*$/.test(t)) {
            i++;
            if (i < lines.length && /^审查结果如下[：:]?\s*$/.test(lines[i].trim())) i++;
            continue;
        }
        if (/^按.+skill.+/i.test(t) && /审查结果如下/.test(t)) {
            i++;
            continue;
        }
        break;
    }
    return lines.slice(i).join('\n').trim();
}

function appendReviewBlock(resultFile, header, content) {
    const body  = stripLeadingReviewFluff(String(content || '').trim()) || '无问题';
    const block = `${header}\n${body}\n${END_MARKER}\n`;
    fs.appendFileSync(resultFile, block, 'utf-8');
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf-8');
}

// ═══════════════════════════════════════════════════════════
// Done 文件路径
// ═══════════════════════════════════════════════════════════
function makeDoneFilePaths(diffFiles, resultFile) {
    return diffFiles.map(f => {
        const { revision } = parseDiffFileName(f);
        return `${resultFile}.${sanitizeName(revision)}${DONE_EXT}`;
    });
}

// ═══════════════════════════════════════════════════════════
// 等待单个结果块写入（done 文件信号）
// ═══════════════════════════════════════════════════════════
async function waitForDone({ resultFile, timeout, doneFile, progress, doneFiles, diffFiles }) {
    let elapsed = 0;
    while (elapsed < timeout) {
        if (doneFile && fs.existsSync(doneFile) && fs.existsSync(resultFile)) {
            fs.unlinkSync(doneFile);
            progress.doneCount++;
            return true;
        }
        updateProgressStatus(progress, doneFiles, diffFiles);
        await delay(POLL_INTERVAL_MS);
        elapsed += POLL_INTERVAL_MS;
    }
    return false;
}

function updateProgressStatus(progress, doneFiles, diffFiles) {
    const total    = diffFiles.length;
    if (!total) return;
    const pending  = doneFiles.filter(f => fs.existsSync(f)).length;
    const finished = progress.doneCount + pending;
    const cur      = Math.min(finished + 1, total);
    setStatus(`检查中... ${diffFiles[cur - 1]} (${cur}/${total})`);
}

// ═══════════════════════════════════════════════════════════
// HTML 导出
// ═══════════════════════════════════════════════════════════
async function exportHtmlIfNeeded({ resultFile, canonicalResult, today, exportHtml }) {
    if (!exportHtml) {
        showInfo(`全部完成，结果: ${canonicalResult}`);
        setStatus('检查完成');
        return;
    }
    try {
        setStatus('生成 HTML 报告中...');
        const htmlPath = trySyncHtmlReport(resultFile, today);
        if (htmlPath) {
            const canonicalHtml = `${canonicalResult}.html`;
            try { fs.copyFileSync(htmlPath, canonicalHtml); } catch {}
            log(`已导出 HTML: ${htmlPath}`);
            setStatus('HTML 生成完毕');
            try { await vscode.env.openExternal(vscode.Uri.file(htmlPath)); } catch {}
            showInfo(`全部完成，结果: ${canonicalResult}  HTML: ${canonicalHtml}`);
        } else {
            showInfo(`全部完成，结果: ${canonicalResult}`);
        }
    } catch (e) {
        log(`导出 HTML 失败: ${e.message}`);
        showWarn(`导出 HTML 失败: ${e.message}`);
        showInfo(`全部完成，结果: ${canonicalResult}`);
    }
    setStatus('检查完成');
}

// ═══════════════════════════════════════════════════════════
// SVN 工具
// ═══════════════════════════════════════════════════════════
const svnAuthorCache = new Map();

function runSvn(args, cwd) {
    log(`runSvn: ${args.join(' ')} in ${cwd}`);
    return execFileSync('svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 将 YYYY-MM-DD 解析为本地日历日（与 formatDate 成对使用） */
function parseLocalDateYmd(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, m - 1, d);
}

function generateTodaySvnDiffs({ svnWorkingDir, targetDir, today, svnAuthor, lookbackDays = 0 }) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    safeDeleteFiles(targetDir, f => f.endsWith(DIFF_EXT));

    try { runSvn(['update'], svnWorkingDir); }
    catch (e) { showWarn(`svn update 失败: ${e.message}`); }

    const n = Math.max(0, Math.floor(Number(lookbackDays) || 0));
    const startDt = parseLocalDateYmd(today);
    startDt.setDate(startDt.getDate() - n);
    const startDate = formatDate(startDt);

    const endDt = parseLocalDateYmd(today);
    endDt.setDate(endDt.getDate() + 1);
    const endDate = formatDate(endDt);

    const revRange = `{${startDate}}:{${endDate}}`;
    log(`SVN log 范围 lookbackDays=${n}: ${revRange}`);

    const xml     = runSvn(['log', '-v', '--xml', '-r', revRange, '.'], svnWorkingDir);
    const entries = parseSvnLogXml(xml);

    for (const { revision, author } of entries) {
        svnAuthorCache.set(`${svnWorkingDir}::${revision}`, author);
    }
    const rangeHint = n === 0 ? today : `${startDate}～${today}`;
    if (!entries.length) { showWarn(`该范围内没有 SVN 提交：${rangeHint}`); return; }

    let count = 0;
    for (const { revision, msg, author } of entries) {
        const revNum = parseInt(revision, 10);
        if (!Number.isFinite(revNum)) continue;
        if (svnAuthor && author !== svnAuthor) continue;

        let diffText = '';
        try { diffText = runSvn(['diff', '-r', `${revNum - 1}:${revision}`, '.'], svnWorkingDir); }
        catch (e) { log(`svn diff 失败 ${revision}: ${e.message}`); continue; }

        if (!String(diffText).trim()) continue;

        const submit   = sanitizeName(msg || 'no_msg').slice(0, 80);
        const filePath = uniquePath(targetDir, `${revision}_${submit}${DIFF_EXT}`);
        fs.writeFileSync(filePath, String(diffText), 'utf8');
        count++;
    }

    count ? showInfo(`已生成 SVN diff：${count} 个（${rangeHint}）`) : showWarn(`该范围内生成 diff 为空：${rangeHint}`);
}

function getSvnAuthor(svnWorkingDir, revision) {
    if (!svnWorkingDir || !revision) return '';
    const key = `${svnWorkingDir}::${revision}`;
    if (svnAuthorCache.has(key)) return svnAuthorCache.get(key);
    try {
        const xml    = runSvn(['log', '--xml', '-r', revision, '.'], svnWorkingDir);
        const author = parseSvnLogXml(xml)[0]?.author || '';
        svnAuthorCache.set(key, author);
        return author;
    } catch (e) {
        log(`获取 SVN author 失败 rev=${revision}: ${e.message}`);
        svnAuthorCache.set(key, '');
        return '';
    }
}

function parseSvnLogXml(xml) {
    return [...String(xml).matchAll(/<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g)]
        .map(m => {
            const block  = String(m[2]);
            const author = (block.match(/<author>([\s\S]*?)<\/author>/) || [])[1] || '';
            const msg    = (block.match(/<msg>([\s\S]*?)<\/msg>/)      || [])[1] || '';
            const first  = decodeXmlEntities(msg).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
            return { revision: String(m[1]), msg: first, author: decodeXmlEntities(author).trim() };
        });
}

function decodeXmlEntities(s) {
    return String(s || '')
        .replace(/&lt;/g,   '<').replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g,  '&')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ═══════════════════════════════════════════════════════════
// 文件名 / 路径工具
// ═══════════════════════════════════════════════════════════
function parseDiffFileName(diffFile) {
    const base = path.basename(diffFile, DIFF_EXT);
    const idx  = base.indexOf('_');
    if (idx === -1) return { revision: base, submitMsg: '' };
    return { revision: base.slice(0, idx), submitMsg: base.slice(idx + 1) };
}

function buildResultHeader(diffFile, svnWorkingDir) {
    const { revision, submitMsg } = parseDiffFileName(diffFile);
    const author = getSvnAuthor(svnWorkingDir, revision);
    return `REVISION:${revision}\t\t${submitMsg}\t\tAUTHOR:${author}`;
}

function sanitizeName(name) {
    return String(name).replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '_');
}

function uniquePath(dir, fileName) {
    let filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) return filePath;
    const ext  = path.extname(fileName);
    const base = path.basename(fileName, ext);
    for (let i = 2; ; i++) {
        filePath = path.join(dir, `${base}_${i}${ext}`);
        if (!fs.existsSync(filePath)) return filePath;
    }
}

function formatDate(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ═══════════════════════════════════════════════════════════
// diff 内容解析
// ═══════════════════════════════════════════════════════════
function parseDiffFilePaths(diffContent) {
    const paths = new Set();
    for (const line of diffContent.split(/\r?\n/)) {
        const t = line.trim();
        const idx = t.match(/^Index:\s+(.+)$/);
        if (idx) { paths.add(idx[1].trim()); continue; }
        const diff = t.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(\s+\(.*\))?$/);
        if (diff) {
            const p = diff[1].trim();
            if (p !== '/dev/null' && !p.includes('nonexistent')) paths.add(p);
        }
    }
    return [...paths];
}

// ═══════════════════════════════════════════════════════════
// 文件读取（自动编码）
// ═══════════════════════════════════════════════════════════
function readFileAuto(filePath) {
    const buf      = fs.readFileSync(filePath);
    const detected = chardet.detect(buf) || 'utf-8';
    const encoding = detected === 'ISO-8859-1' ? 'GBK' : detected;
    log(`编码: ${filePath} -> ${detected} -> ${encoding}`);
    return iconv.decode(buf, encoding);
}

// ═══════════════════════════════════════════════════════════
// 模拟 Enter 键
// ═══════════════════════════════════════════════════════════
async function pressEnter() {
    const robot = require('robotjs');
    robot.keyToggle('enter', 'down');
    robot.keyToggle('enter', 'up');
    log('Enter 发送成功');
}

// ═══════════════════════════════════════════════════════════
// CLI 工具
// ═══════════════════════════════════════════════════════════
function isCommandCallable(cmd) {
    const s = String(cmd || '').trim();
    if (!s) return false;
    if (s.includes('/') || s.includes('\\')) return fs.existsSync(path.isAbsolute(s) ? s : path.resolve(s));
    try {
        const isWin = process.platform === 'win32';
        if (isWin) { execFileSync('where', [s], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
        else        { execFileSync('sh', ['-lc', `command -v ${JSON.stringify(s).slice(1, -1)}`], { stdio: ['ignore', 'pipe', 'ignore'] }); }
        return true;
    } catch { return false; }
}

function parseEnvLines(envText) {
    const out = {};
    for (const line of String(envText || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim())) {
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
}

function execFileAsync(file, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { ...opts, shell: process.platform === 'win32', windowsHide: true, maxBuffer: MAX_BUFFER_BYTES },
            (err, stdout, stderr) => {
                if (err) {
                    const msg = `Agent CLI 失败\ncmd: ${file} ${args.join(' ')}\n${stderr ? `stderr: ${stderr}\n` : ''}error: ${err.message}`;
                    log(msg);
                    return reject(Object.assign(new Error(msg), { cause: err }));
                }
                resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
            }
        );
    });
}

// ═══════════════════════════════════════════════════════════
// HTML 报告
// ═══════════════════════════════════════════════════════════
marked.use({ gfm: true, breaks: true, renderer: {
    html:    raw    => escapeHtml(String(raw || '')),
    heading: (t, l) => Number(l) === 2 ? `<p class="md-h2">${escapeHtml(String(t || ''))}</p>` : `<h${l}>${escapeHtml(String(t || ''))}</h${l}>`,
    code:    (code, info) => {
        const lang = String(info || '').trim().split(/\s+/)[0] || '';
        const safe = String(code || '');
        let hl = '';
        try { hl = lang && hljs.getLanguage(lang) ? hljs.highlight(safe, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(safe).value; }
        catch { hl = escapeHtml(safe); }
        return `<pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${hl}</code></pre>`;
    }
}});

const escapeHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escapeHtmlAttr = escapeHtml;

/** 从 REVISION 行末尾解析 AUTHOR:xxx */
function extractAuthorFromRevisionTitle(titleLine) {
    const m = String(titleLine || '').match(/\bAUTHOR:\s*(.*?)\s*$/);
    return m ? String(m[1] || '').trim() : '';
}

/** 网页标题/导航展示：不显示「AUTHOR:」字样，末尾直接接作者名 */
function formatRevisionTitleForDisplay(titleLine) {
    const s = String(titleLine || '');
    if (!s.startsWith('REVISION:')) return s;
    return s.replace(/\bAUTHOR:\s*/g, '');
}

let reportTemplateHtml = null;

function loadReportTemplate(context) {
    if (reportTemplateHtml) return;
    const p = path.join(context.extensionPath, 'media', 'report-template.html');
    reportTemplateHtml = fs.readFileSync(p, 'utf-8');
    log(`已加载 HTML 模板: ${p}`);
}

function trySyncHtmlReport(resultFile, today) {
    if (!fs.existsSync(resultFile)) { log('HTML 跳过：结果文件不存在'); return null; }
    const raw    = readFileAuto(resultFile);
    const blocks = parseRevisionBlocks(raw);
    const base   = path.basename(resultFile);
    const html   = buildHtmlDocument({
        date: today,
        blocks: blocks.length ? blocks : [{ title: '（无内容）', body: '', author: '' }],
        sourcePath: resultFile
    });
    const out    = path.join(path.dirname(resultFile), `${base}.html`);
    fs.writeFileSync(out, html, 'utf-8');
    return out;
}

function parseRevisionBlocks(raw) {
    return raw.replace(/^\uFEFF/, '').split(/===\s*END\s*===/g)
        .map(s => s.trim()).filter(Boolean)
        .map(block => {
            const lines = block.split(/\r?\n/);
            const first = lines[0] || '';
            if (first.startsWith('REVISION:')) {
                return {
                    title: first,
                    body: stripLeadingReviewFluff(lines.slice(1).join('\n')),
                    author: extractAuthorFromRevisionTitle(first)
                };
            }
            return { title: '审查条目', body: stripLeadingReviewFluff(block), author: '' };
        });
}

function buildAuthorFilterHtml(blocks) {
    const authors = blocks.map(b => String(b.author || '').trim());
    const uniq = [...new Set(authors.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const hasEmpty = authors.some(a => !a);
    let opts = '<option value="">全部作者</option>';
    if (hasEmpty) opts += '<option value="__EMPTY__">（未标注作者）</option>';
    for (const a of uniq) {
        opts += `<option value="${escapeHtmlAttr(a)}">${escapeHtml(a)}</option>`;
    }
    return `<div class="author-filter"><label for="author-filter">按作者</label><select id="author-filter" class="author-select">${opts}</select></div>`;
}

function buildHtmlDocument({ date, blocks, sourcePath }) {
    if (!reportTemplateHtml) throw new Error('HTML 模板未加载');
    const navItems = blocks.map((b, i) => {
        const displayTitle = formatRevisionTitleForDisplay(b.title);
        const author = String(b.author || '').trim();
        const dataAuthor = escapeHtmlAttr(author);
        const n = i + 1;
        return `<li class="nav-item" data-author="${dataAuthor}"><a href="#block-${n}" title="${escapeHtml(displayTitle)}">${n}. ${escapeHtml(displayTitle)}</a></li>`;
    }).join('\n');
    const cards = blocks.map((b, i) => {
        const displayTitle = formatRevisionTitleForDisplay(b.title);
        const author = String(b.author || '').trim();
        const dataAuthor = escapeHtmlAttr(author);
        return `
        <article class="card" id="block-${i + 1}" data-author="${dataAuthor}">
            <header class="card-head">
                <span class="card-idx">${i + 1}</span>
                <div class="card-title-wrap"><div class="card-title">${escapeHtml(displayTitle)}</div></div>
            </header>
            <div class="md-body">${renderMarkdownBody(b.body)}</div>
        </article>`;
    }).join('\n');

    return reportTemplateHtml
        .replace(/{{DATE}}/g, () => escapeHtml(date))
        .replace(/{{BLOCK_COUNT}}/g, () => String(blocks.length))
        .replace(/{{SOURCE_PATH}}/g, () => escapeHtml(sourcePath))
        .replace(/{{GENERATED}}/g, () => escapeHtml(new Date().toISOString()))
        .replace(/{{AUTHOR_FILTER}}/g, () => buildAuthorFilterHtml(blocks))
        .replace(/{{NAV_ITEMS}}/g, () => navItems)
        .replace(/{{CARDS}}/g, () => cards);
}

function renderMarkdownBody(body) {
    if (!body || !String(body).trim()) return '<p class="empty">（无正文）</p>';
    try {
        const html = String(marked.parse(normalizeReviewMarkdown(String(body))))
            .replace(/<script\b[\s\S]*?<\/script>/gi, '')
            .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
            .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
            .replace(/javascript:/gi, '');
        return decodeWhitelistedInlineTags(wrapReviewProblems(beautifyReviewSectionTitles(html)));
    } catch (e) {
        log(`Markdown 渲染失败: ${e.message}`);
        return `<pre class="md-fallback">${escapeHtml(String(body))}</pre>`;
    }
}

function normalizeReviewMarkdown(body) {
    const fileRe = /^\s*([^\s<>:"|?*]+?\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|jsx|ts|tsx|py|go|java|cs|rs|kt|swift|php|rb))\s*$/i;
    const isMark = s => /^(?:\s*(?:\[\s*(?:文件名|问题代码|修改建议)\s*\])\s*)$/u.test(String(s).trim());
    const lines  = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const out    = [];
    for (const line of lines) {
        const m = line.match(fileRe);
        if (m && !isMark(out[out.length - 1] || '')) { out.push('[文件名]'); }
        out.push(m ? m[1] : line);
    }
    return out.join('\n');
}

function beautifyReviewSectionTitles(html) {
    const sections = [
        { kind: 'file',    label: '文件名'  },
        { kind: 'code',    label: '问题代码' },
        { kind: 'suggest', label: '修改建议' }
    ];
    let out = String(html || '');
    for (const { kind, label } of sections) {
        const esc     = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wrapped = `(?:\\[|【)\\s*${esc}\\s*(?:\\]|】)\\s*(?:[:：])?`;
        const cls     = `review-section-title review-section-title--${kind}`;
        const inner   = `<span class="review-section-title__inner"><span class="review-section-title__text">${label}</span></span>`;
        const addCls  = (attrs, c) => {
            const s = String(attrs || '');
            const m = s.match(/\bclass\s*=\s*"([^"]*)"/i);
            return m ? s.replace(/\bclass\s*=\s*"([^"]*)"/i, `class="${m[1]} ${c}".trim()`) : `${s} class="${c}"`;
        };
        out = out
            .replace(new RegExp(`<p([^>]*)>\\s*(?:<strong>\\s*)?${wrapped}\\s*(?:</strong>\\s*)?(?:<br\\s*/?>|&lt;br&gt;)\\s*([\\s\\S]*?)</p>`, 'gi'),
                (_, attrs, tail) => {
                    const a = addCls(attrs, cls); const r = String(tail || '').trim();
                    return r ? `<p${a}>${inner}</p><p class="review-section-follow">${r}</p>` : `<p${a}>${inner}</p>`;
                })
            .replace(new RegExp(`<((?:p|h[1-6]))([^>]*)>\\s*(?:<strong>\\s*)?${wrapped}\\s*(?:</strong>\\s*)?</\\1>`, 'gi'),
                (_, tag, attrs) => `<${tag}${addCls(attrs, cls)}>${inner}</${tag}>`)
            .replace(new RegExp(`<p([^>]*)>\\s*([\\s\\S]*?)(?:<br\\s*\\/?>|&lt;br\\s*\\/?&gt;)\\s*(?:<strong>\\s*)?${wrapped}\\s*(?:</strong>\\s*)?</p>`, 'gi'),
                (_, attrs, pre) => {
                    const p = String(pre || '').trim(); const a = addCls('', cls);
                    return p ? `<p${String(attrs||'')}>${p}</p><p${a}>${inner}</p>` : `<p${a}>${inner}</p>`;
                });
    }
    return out;
}

function wrapReviewProblems(html) {
    return String(html || '').replace(
        /(<p[^>]*review-section-title--file[^>]*>[\s\S]*?<\/p>)([\s\S]*?)(?=<p[^>]*review-section-title--file[^>]*>|$)/gi,
        (_, first, tail) => `<div class="review-problem">${first}${tail}</div>`
    );
}

function decodeWhitelistedInlineTags(html) {
    return String(html || '').replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/&lt;code&gt;/gi, '<code>').replace(/&lt;\/code&gt;/gi, '</code>');
}

function deactivate() {}
module.exports = { activate, deactivate };