// Service untuk menjalankan satu siklus chat:
// - Buat session di DeepSeek
// - Kirim prompt
// - Stream token ke caller via callback
// - Hapus session setelahnya
//
// Mendukung tool calling untuk Hermes Agent dan klien lain yang
// mengandalkan format OpenAI tool_calls.

import { deepseek } from '../lib/deepseek/index.js';
import { createLogger } from '../util/logger.js';
import {
    parseToolCallsFromText,
    hasToolCalls,
    stripToolCalls
} from '../util/toolCallParser.js';

const log = createLogger('CHAT');

export function isReasonerModel(model) {
    return typeof model === 'string' && model.toLowerCase().includes('reasoner');
}

export function isTokenExpiredError(error) {
    const msg = (error?.message || '').toLowerCase();
    const status = error?.response?.status;
    return (
        status === 401 ||
        status === 403 ||
        msg.includes('unauthorized') ||
        msg.includes('token') ||
        msg.includes('expired') ||
        msg.includes('invalid') ||
        msg.includes('auth')
    );
}

/**
 * Jalankan chat sekali jalan.
 *
 * @param {object} args
 * @param {{token: string, email: string}} args.account
 * @param {string} args.prompt
 * @param {string} args.model
 * @param {boolean} [args.hasTools] Apakah request mengandung tools (mempengaruhi parsing output)
 * @param {(type: 'response'|'reasoning'|'search'|'tool_calls', content: any) => void} [args.onDelta]
 * @returns {Promise<{response: string, thinking: string, search_results: any[], tool_calls: Array|null}>}
 */
export async function runChat({ account, prompt, model, hasTools = false, onDelta }) {
    const sessionId = await deepseek.createSession(account.token);
    if (!sessionId) throw new Error('Gagal membuat sesi di DeepSeek.');

    // Buffer untuk deteksi tool calls saat streaming
    let textBuffer = '';
    let toolCallsDetected = false;
    let toolCallsEmitted = false;

    // Wrapper onDelta untuk mendeteksi tool calls dalam stream
    const wrappedOnDelta = onDelta
        ? (type, content) => {
            if (type === 'response' && hasTools) {
                textBuffer += content;
                
                // Deteksi awal tool call
                if (!toolCallsDetected && hasToolCalls(textBuffer)) {
                    toolCallsDetected = true;
                }

                // Jika belum mendeteksi tool call, kirim content normal
                if (!toolCallsDetected) {
                    onDelta('response', content);
                } else {
                    // Setelah tool call terdeteksi, jangan kirim content text
                    // Tunggu sampai stream selesai untuk parse tool calls
                    
                    // Cek apakah tool calls sudah lengkap
                    const parsed = parseToolCallsFromText(textBuffer);
                    if (parsed && !toolCallsEmitted) {
                        toolCallsEmitted = true;
                        onDelta('tool_calls', parsed);
                    }
                }
            } else {
                onDelta(type, content);
            }
        }
        : null;

    const result = await deepseek.chat(account.token, sessionId, prompt, {
        thinkingEnabled: isReasonerModel(model),
        searchEnabled: false,
        onDelta: wrappedOnDelta
    });

    // Hapus session di background — tidak menahan response.
    deepseek.deleteSession(account.token, sessionId).catch((err) => {
        log.warn(`deleteSession gagal: ${err.message}`);
    });

    // Parse tool calls dari response final jika ada tools
    let toolCalls = null;
    let cleanResponse = result.response || '';
    
    if (hasTools && cleanResponse) {
        toolCalls = parseToolCallsFromText(cleanResponse);
        if (toolCalls && toolCalls.length > 0) {
            cleanResponse = stripToolCalls(cleanResponse);
            log.info(`Detected ${toolCalls.length} tool call(s)`);
        }
    }

    return {
        ...result,
        response: cleanResponse,
        tool_calls: toolCalls
    };
}
