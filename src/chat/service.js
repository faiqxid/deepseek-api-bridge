// Service untuk menjalankan satu siklus chat:
// - Buat session di DeepSeek
// - Kirim prompt
// - Stream token ke caller via callback
// - Hapus session setelahnya

import { deepseek } from '../lib/deepseek/index.js';
import { createLogger } from '../util/logger.js';

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
 * @param {(type: 'response'|'reasoning'|'search', content: any) => void} [args.onDelta]
 * @returns {Promise<{response: string, thinking: string, search_results: any[]}>}
 */
export async function runChat({ account, prompt, model, onDelta }) {
    const sessionId = await deepseek.createSession(account.token);
    if (!sessionId) throw new Error('Gagal membuat sesi di DeepSeek.');

    const result = await deepseek.chat(account.token, sessionId, prompt, {
        thinkingEnabled: isReasonerModel(model),
        searchEnabled: false,
        onDelta
    });

    // Hapus session di background — tidak menahan response.
    deepseek.deleteSession(account.token, sessionId).catch((err) => {
        log.warn(`deleteSession gagal: ${err.message}`);
    });

    return result;
}
