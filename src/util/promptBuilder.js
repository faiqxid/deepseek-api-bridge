// Konversi messages OpenAI -> single prompt untuk DeepSeek mobile API.
//
// Tujuan utama: mempertahankan instruksi system prompt seutuh mungkin.
// Cline / Roo / Continue mengirim system prompt panjang berisi instruksi
// format XML tool call yang ketat — kita TIDAK boleh menambahkan preamble
// atau label berbahasa Indonesia di depannya, karena itu bisa membuat model
// mengabaikan format yang diminta dan jatuh ke format JSON umum.
//
// Strategi:
// 1. System message dipasang persis di paling atas, tanpa label.
// 2. Conversation di-render dengan tag minimal yang lazim di training data
//    chat (User: / Assistant:) supaya batas pesan tetap jelas.
// 3. Tool result diberi tanda eksplisit agar tidak tertukar dengan jawaban
//    asisten.

function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                if (part.type === 'text' && typeof part.text === 'string') return part.text;
                if (typeof part.text === 'string') return part.text;
                // image_url / file: tampilkan ringkas saja agar konteks tahu ada lampiran.
                if (part.type === 'image_url' && part.image_url?.url) {
                    return `[image: ${part.image_url.url.slice(0, 80)}...]`;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content == null) return '';
    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
}

export function buildCombinedPrompt(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return '';

    const systemParts = [];
    const turns = [];

    for (const msg of messages) {
        const text = flattenContent(msg?.content);
        if (!text) continue;

        if (msg.role === 'system' || msg.role === 'developer') {
            // System message PERSIS apa adanya — tanpa label, tanpa pembungkus.
            systemParts.push(text.trim());
        } else if (msg.role === 'user') {
            turns.push(`User: ${text}`);
        } else if (msg.role === 'assistant') {
            // Tool calls dari assistant message OpenAI-format harus ditampilkan
            // agar konteks lengkap saat resume percakapan.
            let asst = text;
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const calls = msg.tool_calls
                    .map((tc) => {
                        const name = tc?.function?.name || tc?.name || 'tool';
                        const args = tc?.function?.arguments || tc?.arguments || '';
                        return `[tool_call ${name}: ${args}]`;
                    })
                    .join('\n');
                asst = asst ? `${asst}\n${calls}` : calls;
            }
            turns.push(`Assistant: ${asst}`);
        } else if (msg.role === 'tool' || msg.role === 'function') {
            const name = msg.name || msg.tool_call_id || 'tool';
            turns.push(`Tool result (${name}):\n${text}`);
        } else {
            // Fallback role: tampilkan apa adanya.
            turns.push(`${msg.role}: ${text}`);
        }
    }

    let prompt = '';
    if (systemParts.length > 0) {
        prompt += systemParts.join('\n\n') + '\n\n';
    }
    if (turns.length > 0) {
        prompt += turns.join('\n\n');
    }

    return prompt.trim();
}
