// Endpoint OpenAI-compatible: /v1/models, /v1/chat/completions
// Streaming sungguhan token-by-token — kompatibel dengan OpenAI SDK,
// 9router (Round Robin / passthrough), dan ekstensi VS Code seperti
// Cline, Roo Code, Continue, Kilo Code.
//
// Mendukung Tool Calling untuk Hermes Agent, Claude Code, Codex CLI,
// dan klien lain yang mengandalkan format OpenAI tool_calls.

import express from 'express';
import { config } from '../config.js';
import { getAccountForRequest, relogin } from '../accounts/manager.js';
import { runChat, isReasonerModel, isTokenExpiredError } from '../chat/service.js';
import { buildCombinedPrompt } from '../util/promptBuilder.js';
import { setSseHeaders, buildChatChunk, writeSseChunk, writeSseDone } from '../util/sse.js';
import { createLogger } from '../util/logger.js';
import { parseToolCallsFromText, stripToolCalls, hasToolCalls } from '../util/toolCallParser.js';

/**
 * Deteksi dan konversi blok kode markdown mencurigakan (bash/shell/html) 
 * yang seharusnya adalah tool call menjadi format tool_calls OpenAI.
 * 
 * DeepSeek sometimes "bocor" dan menuliskan perintah shell/file langsung di markdown
 * alih-alih menggunakan format <tool_calls> XML yang benar.
 * Fungsi ini menangkap pola seperti:
 * - ```bash\ncat > file.txt << 'EOF'\n...```
 * - ```html\n<!DOCTYPE html>\n<html>...```
 * - ```sh\nmkdir -p ...```
 * dan mengkonversinya menjadi tool_calls yang valid.
 */
function detectAndConvertMarkdownToolLeaks(text) {
    if (!text || typeof text !== 'string') return null;
    
    const toolCalls = [];
    
    // Pattern untuk mendeteksi blok bash/shell yang menulis ke file
    // Contoh: ```bash\ncat > index.html << 'EOF'\n...```
    const bashFileWritePattern = /```(?:bash|sh|shell)?\s*\n(cat\s+>|echo\s+[^|>].*>|tee\s+|>)\s+([^\n]+)\n([\s\S]*?)```/gi;
    
    let match;
    while ((match = bashFileWritePattern.exec(text)) !== null) {
        const command = match[1].trim();
        const filePath = match[2].trim();
        const content = match[3];
        
        // Deteksi apakah ini benar-benar menulis file
        if (filePath && (content || command.startsWith('cat') || command.startsWith('echo'))) {
            // Parse argument content
            let parsedArgs;
            try {
                // Coba parse sebagai JSON jika content adalah JSON
                parsedArgs = JSON.parse(content);
            } catch {
                // Jika bukan JSON, kirim sebagai string di parameter 'content'
                parsedArgs = { content: content };
            }
            
            // Jika ada path file, tambahkan ke arguments
            if (filePath) {
                parsedArgs.path = filePath;
            }
            
            toolCalls.push({
                id: `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'function',
                function: {
                    name: 'write_file',
                    arguments: JSON.stringify(parsedArgs)
                }
            });
        }
    }
    
    // Pattern untuk mendeteksi perintah terminal (mkdir, rm, touch, dll)
    const terminalCmdPattern = /```(?:bash|sh|shell)?\s*\n(mkdir|rmdir|rm|touch|chmod|chown|cp|mv)\s+([^\n]+)\n```/gi;
    
    while ((match = terminalCmdPattern.exec(text)) !== null) {
        const cmd = match[1].trim();
        const args = match[2].trim();
        
        toolCalls.push({
            id: `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'function',
            function: {
                name: 'terminal',
                arguments: JSON.stringify({ command: `${cmd} ${args}` })
            }
        });
    }
    
    // Pattern untuk mendeteksi HTML yang ditulis langsung (bukan sebagai response, tapi sebagai file creation)
    // Ini sangat sering terjadi di akun baru — model menulis <!DOCTYPE html> langsung di chat
    const htmlFilePattern = /<!DOCTYPE\s+html>[\s\S]*?<\/html>/gi;
    
    if (htmlFilePattern.test(text)) {
        // Cari semua dokumen HTML dalam teks
        const htmlMatches = text.match(/<!DOCTYPE\s+html>[\s\S]*?<\/html>/gi);
        if (htmlMatches) {
            for (const htmlContent of htmlMatches) {
                // Coba deteksi nama file dari konteks sekitarnya
                const fileNameMatch = text.match(/(?:index|main|app|page|home)\.html/i);
                const fileName = fileNameMatch ? fileNameMatch[0] : 'index.html';
                
                toolCalls.push({
                    id: `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: fileName, content: htmlContent })
                    }
                });
            }
        }
    }
    
    return toolCalls.length > 0 ? toolCalls : null;
}

const log = createLogger('V1');
const router = express.Router();

// Model list — diperluas untuk kompatibilitas dengan Hermes Agent
router.get('/models', (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
        object: 'list',
        data: [
            { id: 'deepseek-chat', object: 'model', created, owned_by: 'deepseek' },
            { id: 'deepseek-reasoner', object: 'model', created, owned_by: 'deepseek' },
            // Alias untuk kompatibilitas Hermes Agent / Claude Code / Codex
            { id: 'deepseek-v3', object: 'model', created, owned_by: 'deepseek' },
            { id: 'deepseek-r1', object: 'model', created, owned_by: 'deepseek' }
        ]
    });
});

// Model detail
router.get('/models/:id', (req, res) => {
    const modelId = req.params.id;
    const created = Math.floor(Date.now() / 1000);
    res.json({
        id: modelId,
        object: 'model',
        created,
        owned_by: 'deepseek'
    });
});

router.post('/chat/completions', async (req, res) => {
    const account = await getAccountForRequest(req);
    if (!account || !account.token) {
        return res.status(401).json({
            error: {
                message:
                    'Akun DeepSeek tidak tersedia. Kirim header Authorization: Bearer *** ' +
                    'atau isi accounts.txt untuk Round Robin internal.',
                type: 'authentication_error'
            }
        });
    }

    const {
        messages = [],
        model = config.defaultModel,
        stream = false,
        tools = null,
        tool_choice = null
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'Field messages wajib berupa array dan tidak boleh kosong.',
                type: 'invalid_request_error'
            }
        });
    }

    // Resolve model alias
    const resolvedModel = resolveModelAlias(model);
    const hasTools = Array.isArray(tools) && tools.length > 0;
    
    const prompt = buildCombinedPrompt(messages, hasTools ? tools : null);
    const completionId = `chatcmpl-${Date.now()}`;
    const reasoner = isReasonerModel(resolvedModel);

    if (stream) {
        return handleStreamRequest({ req, res, account, prompt, model: resolvedModel, completionId, reasoner, hasTools });
    }
    return handleNonStreamRequest({ res, account, prompt, model: resolvedModel, completionId, reasoner, hasTools });
});

/**
 * Resolve model alias ke model DeepSeek yang sebenarnya
 */
function resolveModelAlias(model) {
    if (!model || typeof model !== 'string') return config.defaultModel;
    
    const lower = model.toLowerCase();
    
    // Alias mapping
    const aliases = {
        'deepseek-v3': 'deepseek-chat',
        'deepseek-r1': 'deepseek-reasoner',
        'deepseek-coder': 'deepseek-chat',
        // Alias umum dari Hermes Agent / OpenAI SDK
        'gpt-4': 'deepseek-chat',
        'gpt-4o': 'deepseek-chat',
        'gpt-4o-mini': 'deepseek-chat',
        'gpt-4.1': 'deepseek-chat',
        'gpt-5': 'deepseek-chat',
        'o3': 'deepseek-reasoner',
        'o3-mini': 'deepseek-reasoner',
        // Claude alias
        'claude-sonnet-4-20250514': 'deepseek-chat',
        'claude-3-5-sonnet': 'deepseek-chat',
        'claude-3-5-haiku': 'deepseek-chat',
        'claude-opus-4': 'deepseek-reasoner'
    };
    
    return aliases[lower] || model;
}

async function handleStreamRequest({ req, res, account, prompt, model, completionId, reasoner, hasTools }) {
    setSseHeaders(res);

    // Kirim chunk pembuka dengan role assistant — Cline & OpenAI SDK butuh ini.
    writeSseChunk(
        res,
        buildChatChunk({
            id: completionId,
            model,
            delta: { role: 'assistant', content: '' }
        })
    );

    let aborted = false;
    req.on('close', () => {
        aborted = true;
    });

    // Buffer untuk tool call detection saat streaming
    let toolCallBuffer = '';
    let toolCallMode = false;
    let toolCallsSent = false;
    let currentAccount = account;

    const streamDelta = (type, content) => {
        if (aborted) return;
        
        if (type === 'response') {
            if (hasTools) {
                toolCallBuffer += content;
                
                // Deteksi awal tool call
                if (!toolCallMode && hasToolCalls(toolCallBuffer)) {
                    toolCallMode = true;
                    // Kirim content sebelum tool call block
                    const beforeToolCall = toolCallBuffer.split(/<tool_calls>|<\|DSML\|tool_calls>/)[0];
                    if (beforeToolCall.trim()) {
                        writeSseChunk(res, buildChatChunk({ id: completionId, model, delta: { content: beforeToolCall } }));
                    }
                    return;
                }
                
                if (toolCallMode) {
                    // Cek apakah tool call block sudah selesai
                    if (toolCallBuffer.includes('</tool_calls>') || toolCallBuffer.includes('</|DSML|tool_calls>')) {
                        if (!toolCallsSent) {
                            toolCallsSent = true;
                            // Parse dan kirim tool calls
                            const toolCalls = parseToolCallsFromText(toolCallBuffer);
                            if (toolCalls && toolCalls.length > 0) {
                                emitToolCallChunks(res, completionId, model, toolCalls);
                            }
                        }
                    }
                    return;
                }
                
                // Normal content (belum ada tool call)
                writeSseChunk(res, buildChatChunk({ id: completionId, model, delta: { content } }));
            } else {
                writeSseChunk(res, buildChatChunk({ id: completionId, model, delta: { content } }));
            }
        } else if (type === 'reasoning' && reasoner) {
            writeSseChunk(
                res,
                buildChatChunk({
                    id: completionId,
                    model,
                    delta: { reasoning_content: content }
                })
            );
        } else if (type === 'tool_calls') {
            // Tool calls sudah di-parse oleh service layer
            if (!toolCallsSent) {
                toolCallsSent = true;
                emitToolCallChunks(res, completionId, model, content);
            }
        }
    };

    async function executeStream(attempt = 1) {
        try {
            await runChat({ account: currentAccount, prompt, model, hasTools, onDelta: streamDelta });
        } catch (firstError) {
            if (isTokenExpiredError(firstError)) {
                log.warn(`Token expired untuk ${currentAccount.email}, retry...`);
                try {
                    const refreshed = await relogin(currentAccount, 'RETRY');
                    if (!refreshed) throw new Error('Login ulang gagal setelah token expired.');
                    await runChat({ account: refreshed, prompt, model, hasTools, onDelta: streamDelta });
                } catch (retryError) {
                    log.error(`Retry gagal (${currentAccount.email}): ${retryError.message}`);
                    await handleFailover(retryError, attempt);
                }
            } else {
                log.error(`Chat gagal (${currentAccount.email}): ${firstError.message}`);
                await handleFailover(firstError, attempt);
            }
        }
    }

    async function handleFailover(error, attempt) {
        if (aborted) return;
        const parsedCreds = req.headers ? (req.headers.authorization || req.headers['x-api-key']) : null;
        const isRoundRobin = !parsedCreds || !parsedCreds.includes(':');

        if (isRoundRobin && attempt < 3) {
            log.warn(`[Failover] Beralih ke akun berikutnya, percobaan #${attempt + 1}...`);
            const nextAccount = await getAccountForRequest(req);
            if (nextAccount && nextAccount.email !== currentAccount.email) {
                currentAccount = nextAccount;
                toolCallBuffer = '';
                toolCallMode = false;
                toolCallsSent = false;
                await executeStream(attempt + 1);
                return;
            }
        }
        if (!aborted) {
            writeSseChunk(res, {
                error: { message: error.message, type: 'upstream_error' }
            });
        }
    }

    await executeStream();

    if (aborted) return;
    
    // Pemulihan jika terdeteksi toolCallMode tapi ternyata bukan tool call valid
    if (hasTools && toolCallMode) {
        if (!toolCallsSent) {
            const toolCalls = parseToolCallsFromText(toolCallBuffer);
            if (toolCalls && toolCalls.length > 0) {
                emitToolCallChunks(res, completionId, model, toolCalls);
                toolCallsSent = true;
            } else {
                // Coba deteksi markdown tool leaks (bash/html yang bocor)
                const markdownToolCalls = detectAndConvertMarkdownToolLeaks(toolCallBuffer);
                if (markdownToolCalls && markdownToolCalls.length > 0) {
                    log.info(`Auto-converted ${markdownToolCalls.length} markdown code block(s) to tool_calls`);
                    emitToolCallChunks(res, completionId, model, markdownToolCalls);
                    toolCallsSent = true;
                } else {
                    // Ternyata bukan tool call valid (bocor/salah tag/teks biasa).
                    // Kirimkan seluruh teks yang sempat ditahan ke client agar tidak hilang!
                    const beforeToolCall = toolCallBuffer.split(/<tool_calls>|<\|DSML\|tool_calls>/)[0];
                    const heldText = toolCallBuffer.substring(beforeToolCall.length);
                    writeSseChunk(res, buildChatChunk({ id: completionId, model, delta: { content: heldText } }));
                    log.warn("Tool call mode active but no valid tool calls parsed. Restored held text.");
                }
            }
        }
    }
    
    // FALLBACK: Jika TIDAK dalam toolCallMode tapi buffer mengandung markdown tool leaks
    // Ini menangani kasus di mana model TIDAK pernah menulis <tool_calls> sama sekali
    // tapi langsung menulis ```bash\ncat > file...``` atau HTML mentah di chat.
    if (hasTools && !toolCallMode && !toolCallsSent && toolCallBuffer) {
        const markdownToolCalls = detectAndConvertMarkdownToolLeaks(toolCallBuffer);
        if (markdownToolCalls && markdownToolCalls.length > 0) {
            log.info(`[Fallback] Auto-converted ${markdownToolCalls.length} markdown leak(s) to tool_calls`);
            emitToolCallChunks(res, completionId, model, markdownToolCalls);
            toolCallsSent = true;
        }
    }
    
    const finishReason = toolCallsSent ? 'tool_calls' : 'stop';
    writeSseChunk(
        res,
        buildChatChunk({ id: completionId, model, delta: {}, finishReason })
    );
    writeSseDone(res);
    log.info(`Stream selesai via ${currentAccount.email}${toolCallsSent ? ' (with tool_calls)' : ''}`);
}

/**
 * Emit tool call chunks dalam format OpenAI streaming
 */
function emitToolCallChunks(res, completionId, model, toolCalls) {
    for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        
        // Chunk pertama: kirim function name
        writeSseChunk(res, buildChatChunk({
            id: completionId,
            model,
            delta: {
                tool_calls: [{
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.function.name,
                        arguments: ''
                    }
                }]
            }
        }));
        
        // Chunk kedua: kirim arguments
        writeSseChunk(res, buildChatChunk({
            id: completionId,
            model,
            delta: {
                tool_calls: [{
                    index: i,
                    function: {
                        arguments: tc.function.arguments
                    }
                }]
            }
        }));
    }
}

async function handleNonStreamRequest({ res, account, prompt, model, completionId, reasoner, hasTools }) {
    try {
        let result;
        try {
            result = await runChat({ account, prompt, model, hasTools });
        } catch (firstError) {
            if (!isTokenExpiredError(firstError)) throw firstError;
            log.warn(`Token expired untuk ${account.email}, retry...`);
            const refreshed = await relogin(account, 'RETRY');
            if (!refreshed) throw new Error('Login ulang gagal setelah token expired.');
            result = await runChat({ account: refreshed, prompt, model, hasTools });
        }

        const message = { role: 'assistant', content: result.response || '' };
        
        // Tambahkan reasoning_content jika model reasoner
        if (reasoner && result.thinking) {
            message.reasoning_content = result.thinking;
        }
        
        // Tambahkan tool_calls jika ada
        if (result.tool_calls && result.tool_calls.length > 0) {
            message.tool_calls = result.tool_calls;
            // Jika ada tool calls, content bisa null sesuai OpenAI spec
            if (!message.content) message.content = null;
        }

        const finishReason = (result.tool_calls && result.tool_calls.length > 0) ? 'tool_calls' : 'stop';

        res.json({
            id: completionId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'deepseek-chat',
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
        log.info(`Response terkirim via ${account.email}${result.tool_calls ? ' (with tool_calls)' : ''}`);
    } catch (error) {
        log.error(`Chat gagal (${account.email}): ${error.message}`);
        res.status(500).json({
            error: { message: error.message, type: 'upstream_error' }
        });
    }
}

export default router;
