// Endpoint OpenAI-compatible: /v1/models, /v1/chat/completions
// Streaming sungguhan token-by-token — kompatibel dengan OpenAI SDK,
// 9router (Round Robin / passthrough), dan ekstensi VS Code seperti
// Cline, Roo Code, Continue, Kilo Code.

import express from 'express';
import { config } from '../config.js';
import { getAccountForRequest, relogin } from '../accounts/manager.js';
import { runChat, isReasonerModel, isTokenExpiredError } from '../chat/service.js';
import { buildCombinedPrompt } from '../util/promptBuilder.js';
import { setSseHeaders, buildChatChunk, writeSseChunk, writeSseDone } from '../util/sse.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('V1');
const router = express.Router();

router.get('/models', (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
        object: 'list',
        data: [
            { id: 'deepseek-chat', object: 'model', created, owned_by: 'deepseek' },
            { id: 'deepseek-reasoner', object: 'model', created, owned_by: 'deepseek' }
        ]
    });
});

router.post('/chat/completions', async (req, res) => {
    const account = await getAccountForRequest(req);
    if (!account || !account.token) {
        return res.status(401).json({
            error: {
                message:
                    'Akun DeepSeek tidak tersedia. Kirim header Authorization: Bearer email:password ' +
                    'atau isi accounts.txt untuk Round Robin internal.',
                type: 'authentication_error'
            }
        });
    }

    const { messages = [], model = config.defaultModel, stream = false } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'Field messages wajib berupa array dan tidak boleh kosong.',
                type: 'invalid_request_error'
            }
        });
    }

    const prompt = buildCombinedPrompt(messages);
    const completionId = `chatcmpl-${Date.now()}`;
    const reasoner = isReasonerModel(model);

    if (stream) {
        return handleStreamRequest({ req, res, account, prompt, model, completionId, reasoner });
    }
    return handleNonStreamRequest({ res, account, prompt, model, completionId, reasoner });
});

async function handleStreamRequest({ req, res, account, prompt, model, completionId, reasoner }) {
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

    const streamDelta = (type, content) => {
        if (aborted) return;
        if (type === 'response') {
            writeSseChunk(res, buildChatChunk({ id: completionId, model, delta: { content } }));
        } else if (type === 'reasoning' && reasoner) {
            // Field reasoning_content sesuai konvensi DeepSeek-R1 — Cline / Continue menampilkannya.
            writeSseChunk(
                res,
                buildChatChunk({
                    id: completionId,
                    model,
                    delta: { reasoning_content: content }
                })
            );
        }
    };

    try {
        await runChat({ account, prompt, model, onDelta: streamDelta });
    } catch (firstError) {
        if (isTokenExpiredError(firstError)) {
            log.warn(`Token expired untuk ${account.email}, retry...`);
            try {
                const refreshed = await relogin(account, 'RETRY');
                if (!refreshed) throw new Error('Login ulang gagal setelah token expired.');
                await runChat({ account: refreshed, prompt, model, onDelta: streamDelta });
            } catch (retryError) {
                log.error(`Retry gagal (${account.email}): ${retryError.message}`);
                if (!aborted) {
                    writeSseChunk(res, {
                        error: { message: retryError.message, type: 'upstream_error' }
                    });
                }
            }
        } else {
            log.error(`Chat gagal (${account.email}): ${firstError.message}`);
            if (!aborted) {
                writeSseChunk(res, {
                    error: { message: firstError.message, type: 'upstream_error' }
                });
            }
        }
    }

    if (aborted) return;
    writeSseChunk(
        res,
        buildChatChunk({ id: completionId, model, delta: {}, finishReason: 'stop' })
    );
    writeSseDone(res);
    log.info(`Stream selesai via ${account.email}`);
}

async function handleNonStreamRequest({ res, account, prompt, model, completionId, reasoner }) {
    try {
        let result;
        try {
            result = await runChat({ account, prompt, model });
        } catch (firstError) {
            if (!isTokenExpiredError(firstError)) throw firstError;
            log.warn(`Token expired untuk ${account.email}, retry...`);
            const refreshed = await relogin(account, 'RETRY');
            if (!refreshed) throw new Error('Login ulang gagal setelah token expired.');
            result = await runChat({ account: refreshed, prompt, model });
        }

        const message = { role: 'assistant', content: result.response || '' };
        if (reasoner && result.thinking) {
            message.reasoning_content = result.thinking;
        }

        res.json({
            id: completionId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'deepseek-chat',
            choices: [{ index: 0, message, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
        log.info(`Response terkirim via ${account.email}`);
    } catch (error) {
        log.error(`Chat gagal (${account.email}): ${error.message}`);
        res.status(500).json({
            error: { message: error.message, type: 'upstream_error' }
        });
    }
}

export default router;
