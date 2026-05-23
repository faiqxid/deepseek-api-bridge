// Helper SSE untuk OpenAI-compatible streaming.
// Cline / Roo / Continue mengandalkan event terkirim per token, bukan satu chunk besar.

export function setSseHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable buffering di nginx / reverse proxy
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function buildChatChunk({ id, model, delta, finishReason = null }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'deepseek-chat',
        choices: [
            {
                index: 0,
                delta,
                finish_reason: finishReason
            }
        ]
    };
}

export function writeSseChunk(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
}

export function writeSseDone(res) {
    res.write('data: [DONE]\n\n');
    res.end();
}
