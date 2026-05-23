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
// 4. Force Tool Calling Suffix: Menambahkan instruksi ketat di akhir pesan user
//    terakhir untuk mencegah model mengabaikan tool dan hanya menulis markdown biasa (terutama di akun baru).

import { extractToolCallsFromAssistantMessage, buildToolDefinitionsPrompt } from './toolCallParser.js';

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

export function buildCombinedPrompt(messages = [], tools = null) {
    if (!Array.isArray(messages) || messages.length === 0) return '';

    const systemParts = [];
    const turns = [];

    const hasTools = tools && tools.length > 0;

    // Jika ada tools, tambahkan instruksi tentang tools di system message
    if (hasTools) {
        systemParts.push(buildToolDefinitionsPrompt(tools));
    }

    // Cari index pesan user terakhir untuk disisipkan penegasan tool call
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUserIndex = i;
            break;
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        let text = flattenContent(msg?.content);
        
        if (msg.role === 'system' || msg.role === 'developer') {
            // System message PERSIS apa adanya — tanpa label, tanpa pembungkus.
            if (text) systemParts.push(text.trim());
        } else if (msg.role === 'user') {
            if (text) {
                // Jika ini adalah pesan user terakhir dan kita punya tools,
                // tambahkan suffix penegasan super ketat agar model WAJIB memakai tool call
                // dan tidak menuliskan kode mentah di markdown biasa.
                if (hasTools && i === lastUserIndex) {
                    text += "\n\n[SYSTEM NOTE: You MUST use the `<tool_calls>` XML format to execute functions if you need to read, write, or modify files or run terminal commands. DO NOT output the file content or code block directly in markdown. You must call the appropriate tool (e.g. `write_file` or `patch`) to apply the changes to the disk! Check available tools above.]";
                }
                turns.push(`User: ${text}`);
            }
        } else if (msg.role === 'assistant') {
            // Tool calls dari assistant message OpenAI-format harus ditampilkan
            // agar konteks lengkap saat resume percakapan.
            let asst = text || '';
            
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const xmlToolCalls = extractToolCallsFromAssistantMessage(msg);
                asst = asst ? `${asst}\n${xmlToolCalls}` : xmlToolCalls;
            }
            
            if (asst) turns.push(`Assistant: ${asst}`);
        } else if (msg.role === 'tool' || msg.role === 'function') {
            // Tool result harus dikembalikan dalam format yang dikenali oleh model
            // Jika model menghasilkan XML untuk tools, dia expect balasan untuk tools
            const name = msg.name || 'tool';
            const callId = msg.tool_call_id || '';
            const idAttr = callId ? ` tool_call_id="${callId}"` : '';
            
            // Format yang umum dikenali model untuk tool result
            const resultXml = `<tool_result name="${name}"${idAttr}>\n${text || 'Success'}\n</tool_result>`;
            turns.push(`Tool result (${name}):\n${resultXml}`);
        } else {
            // Fallback role: tampilkan apa adanya.
            if (text) turns.push(`${msg.role}: ${text}`);
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
