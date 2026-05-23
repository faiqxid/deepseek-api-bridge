// Wrapper DeepSeek mobile API: login, session, upload, dan chat dengan streaming token-by-token.
//
// Perbedaan penting vs implementasi lama:
// - chat() sekarang menerima callback onDelta(type, content) sehingga server bisa men-stream
//   token mentah ke klien (Cline / Roo / OpenAI SDK) saat tiba — bukan menunggu stream selesai.
// - Tipe delta: 'response' (jawaban final) dan 'reasoning' (blok thinking).

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { CONFIG, utils } from './constants.js';
import { getPowToken } from './pow.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('DEEPSEEK');

export const deepseek = {
    login: async (email, password) => {
        try {
            const deviceId = utils.generateDeviceId();
            const response = await axios.post(
                `${CONFIG.BASE_URL}/users/login`,
                { email, password, device_id: deviceId, os: 'android' },
                { headers: CONFIG.HEADERS }
            );

            if (response.data.code !== 0) throw new Error(response.data.msg);

            return {
                token: response.data.data.biz_data.user.token,
                user: response.data.data.biz_data.user
            };
        } catch (error) {
            log.error(`Login error untuk ${email}: ${error.message}`);
            return null;
        }
    },

    createSession: async (token) => {
        const response = await axios.post(
            `${CONFIG.BASE_URL}/chat_session/create`,
            {},
            { headers: { ...CONFIG.HEADERS, Authorization: `Bearer ${token}` } }
        );
        if (response.data.code !== 0) {
            throw new Error(response.data.msg || 'Gagal membuat sesi');
        }
        return response.data.data.biz_data.chat_session.id;
    },

    deleteSession: async (token, sessionId) => {
        try {
            const response = await axios.post(
                `${CONFIG.BASE_URL}/chat_session/delete`,
                { chat_session_id: sessionId },
                { headers: { ...CONFIG.HEADERS, Authorization: `Bearer ${token}` } }
            );
            return response.data.code === 0;
        } catch (error) {
            log.warn(`Delete session gagal: ${error.message}`);
            return false;
        }
    },

    upload: async (token, filePath) => {
        if (!fs.existsSync(filePath)) throw new Error('File tidak ditemukan');
        const stats = fs.statSync(filePath);
        const stream = fs.createReadStream(filePath);
        const powToken = await getPowToken(token, '/api/v0/file/upload_file');
        if (!powToken) throw new Error('Gagal solve PoW untuk upload');

        const form = new FormData();
        form.append('file', stream);

        const headers = {
            ...CONFIG.HEADERS,
            ...form.getHeaders(),
            Authorization: `Bearer ${token}`,
            'x-ds-pow-response': powToken,
            'x-file-size': stats.size.toString(),
            'x-thinking-enabled': '0'
        };

        const response = await axios.post(`${CONFIG.BASE_URL}/file/upload_file`, form, { headers });
        if (response.data.code !== 0) throw new Error('Upload init gagal');

        const fileId = response.data.data.biz_data.id;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            await utils.sleep(2000);
            const checkRes = await axios.get(
                `${CONFIG.BASE_URL}/file/fetch_files?file_ids=${fileId}`,
                { headers: { ...CONFIG.HEADERS, Authorization: `Bearer ${token}` } }
            );
            if (checkRes.data.code === 0) {
                const fileData = checkRes.data.data.biz_data.files[0];
                if (fileData.status === 'SUCCESS') return fileId;
                if (fileData.status === 'FAILED') return null;
            }
            attempts++;
        }
        return null;
    },

    /**
     * Chat dengan DeepSeek.
     *
     * @param {string} token
     * @param {string} sessionId
     * @param {string} prompt
     * @param {object} options
     * @param {boolean} [options.thinkingEnabled=false]
     * @param {boolean} [options.searchEnabled=false]
     * @param {string[]} [options.fileIds]
     * @param {(type: 'response'|'reasoning'|'search', content: any) => void} [options.onDelta]
     *        Dipanggil saat token baru tiba. Type 'response' = jawaban, 'reasoning' = thinking,
     *        'search' = array hasil pencarian.
     * @returns {Promise<{response: string, thinking: string, search_results: any[], session_title: string}>}
     */
    chat: async (token, sessionId, prompt, options = {}) => {
        const powToken = await getPowToken(token, '/api/v0/chat/completion');
        if (!powToken) throw new Error('Gagal solve PoW');

        const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;

        const payload = {
            chat_session_id: sessionId,
            parent_message_id: options.parentMessageId || null,
            prompt,
            ref_file_ids: options.fileIds || [],
            thinking_enabled: options.thinkingEnabled || false,
            search_enabled: options.searchEnabled || false,
            audio_id: null
        };

        const response = await axios.post(`${CONFIG.BASE_URL}/chat/completion`, payload, {
            headers: {
                ...CONFIG.HEADERS,
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'x-ds-pow-response': powToken
            },
            responseType: 'stream'
        });

        let fullText = '';
        let thoughtText = '';
        let searchResults = [];
        let sessionTitle = '';
        let currentFragment = null;
        let buffer = '';

        const findFragmentType = (obj) => {
            if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') return obj.type;
            if (Array.isArray(obj.v)) {
                for (const item of obj.v) {
                    const found = findFragmentType(item);
                    if (found) return found;
                }
            }
            return null;
        };

        const extractText = (obj) => {
            if (obj.content && typeof obj.content === 'string') return obj.content;
            if (Array.isArray(obj.v)) return obj.v.map(extractText).join('');
            return '';
        };

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const events = utils.parseSSE(line + '\n\n');
                    for (const event of events) {
                        if (!event.data || event.data === ':' || event.event === 'keep-alive') continue;

                        if (event.event === 'title') {
                            try {
                                sessionTitle = JSON.parse(event.data).content;
                            } catch {
                                /* ignore */
                            }
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(event.data);

                            const newType = findFragmentType(parsed);
                            if (newType && currentFragment !== newType) {
                                currentFragment = newType;
                            }

                            // Hasil pencarian web
                            let resultsFound = null;
                            if (parsed.p && parsed.p.endsWith('results') && Array.isArray(parsed.v)) {
                                resultsFound = parsed.v;
                            } else if (parsed.v && Array.isArray(parsed.v)) {
                                const searchInV = (arr) => {
                                    for (const item of arr) {
                                        if (item.results && Array.isArray(item.results)) return item.results;
                                        if (item.v && Array.isArray(item.v)) {
                                            const found = searchInV(item.v);
                                            if (found) return found;
                                        }
                                    }
                                    return null;
                                };
                                resultsFound = searchInV(parsed.v);
                            }
                            if (resultsFound) {
                                searchResults = [...searchResults, ...resultsFound];
                                if (onDelta) onDelta('search', resultsFound);
                            }

                            // Token isi
                            let contentToAdd = extractText(parsed);
                            if (!contentToAdd && typeof parsed.v === 'string') {
                                if (!parsed.p || parsed.p.endsWith('content')) {
                                    contentToAdd = parsed.v;
                                }
                            }

                            if (contentToAdd) {
                                if (!currentFragment) currentFragment = 'RESPONSE';
                                if (currentFragment === 'THINK') {
                                    thoughtText += contentToAdd;
                                    if (onDelta) onDelta('reasoning', contentToAdd);
                                } else if (currentFragment === 'RESPONSE') {
                                    fullText += contentToAdd;
                                    if (onDelta) onDelta('response', contentToAdd);
                                }
                            }
                        } catch {
                            /* abaikan baris yang bukan JSON */
                        }
                    }
                }
            });

            response.data.on('end', () => {
                resolve({
                    status: 'success',
                    session_title: sessionTitle,
                    thinking: thoughtText.trim(),
                    search_results: searchResults,
                    response: fullText.trim()
                });
            });

            response.data.on('error', (err) => reject(err));
        });
    }
};
