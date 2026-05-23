// Konstanta endpoint & header untuk DeepSeek mobile API.
// Disimpan terpisah supaya gampang di-tweak tanpa menyentuh logic.

export const CONFIG = {
    BASE_URL: 'https://chat.deepseek.com/api/v0',
    HEADERS: {
        'User-Agent': 'DeepSeek/1.8.3 Android/35',
        'Accept': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '1.8.3',
        'x-client-locale': 'id',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-rangers-id': '7392079989945982465',
        'accept-charset': 'UTF-8'
    }
};

export const WORKER_URL = 'https://static.deepseek.com/chat/static/33614.25c7f8f220.js';
export const WASM_URL = 'https://static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

export const utils = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    generateDeviceId: () => {
        const baseId = 'BUelgEoBdkHyhwE8q/4YOodITQ1Ef99t7Y5KAR4CyHwdApr+lf4LJ+QAKXEUJ2lLtPQ+mmFtt6MpbWxpRmnWITA==';
        const chars = baseId.split('');
        const start = 50;
        const end = 70;
        const changes = Math.floor(Math.random() * 3) + 2;
        const possibleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

        for (let i = 0; i < changes; i++) {
            const randomIndex = Math.floor(Math.random() * (end - start)) + start;
            chars[randomIndex] = possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
        }
        return chars.join('');
    },

    parseSSE: (chunk) => {
        const lines = chunk.toString().split('\n');
        const events = [];
        let currentEvent = { event: 'message', data: '' };

        for (const line of lines) {
            if (line.startsWith('event:')) {
                if (currentEvent.data) events.push({ ...currentEvent });
                currentEvent = { event: line.substring(6).trim(), data: '' };
            } else if (line.startsWith('data:')) {
                currentEvent.data += line.substring(5).trim();
            } else if (line === '' && currentEvent.data) {
                events.push({ ...currentEvent });
                currentEvent = { event: 'message', data: '' };
            }
        }
        if (currentEvent.data) events.push(currentEvent);
        return events;
    }
};
