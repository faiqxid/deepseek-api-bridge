// Proof-of-Work solver untuk endpoint DeepSeek tertentu.
// Menjalankan worker JS dari static.deepseek.com di sandbox vm Node.

import https from 'https';
import vm from 'vm';
import axios from 'axios';
import { CONFIG, WORKER_URL, WASM_URL } from './constants.js';

let workerCache = null;
let wasmCache = null;

function download(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                const data = [];
                res.on('data', (chunk) => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
                res.on('error', reject);
            })
            .on('error', reject);
    });
}

async function loadAssets() {
    if (!workerCache) workerCache = (await download(WORKER_URL)).toString();
    if (!wasmCache) wasmCache = await download(WASM_URL);
    return { workerScript: workerCache, wasmBuffer: wasmCache };
}

function generateFinalToken(originalPayload, answer) {
    const jsonBody = {
        algorithm: originalPayload.algorithm,
        challenge: originalPayload.challenge,
        salt: originalPayload.salt,
        answer,
        signature: originalPayload.signature,
        target_path: originalPayload.target_path
    };
    return Buffer.from(JSON.stringify(jsonBody)).toString('base64');
}

async function solvePow(payload) {
    const cleanPayload = {
        algorithm: payload.algorithm,
        challenge: payload.challenge,
        salt: payload.salt,
        difficulty: payload.difficulty,
        signature: payload.signature,
        expireAt: payload.expire_at || payload.expireAt
    };

    const { workerScript, wasmBuffer } = await loadAssets();

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('PoW timeout')), 60000);

        class MockResponse {
            constructor(buffer) {
                this.buffer = buffer;
                this.ok = true;
                this.status = 200;
                this.headers = { get: () => 'application/wasm' };
            }
            async arrayBuffer() {
                return this.buffer;
            }
        }

        const sandbox = {
            console: { log: () => {} },
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            TextEncoder,
            TextDecoder,
            URL,
            Response: MockResponse,
            location: {
                href: WORKER_URL,
                origin: 'https://static.deepseek.com',
                pathname: '/chat/static/33614.25c7f8f220.js',
                toString: () => WORKER_URL
            },
            WebAssembly: {
                Module: WebAssembly.Module,
                Instance: WebAssembly.Instance,
                instantiate: WebAssembly.instantiate,
                validate: WebAssembly.validate,
                Memory: WebAssembly.Memory,
                Table: WebAssembly.Table,
                Global: WebAssembly.Global,
                CompileError: WebAssembly.CompileError,
                LinkError: WebAssembly.LinkError,
                RuntimeError: WebAssembly.RuntimeError
            },
            fetch: async (input) => {
                if (input.toString().includes('wasm')) return new MockResponse(wasmBuffer);
                throw new Error('Blocked');
            },
            postMessage: (msg) => {
                if (msg && msg.type === 'pow-answer') {
                    clearTimeout(timeoutId);
                    resolve(generateFinalToken(payload, msg.answer.answer));
                } else if (msg && msg.type === 'pow-error') {
                    clearTimeout(timeoutId);
                    reject(new Error('POW worker error: ' + JSON.stringify(msg.error)));
                }
            }
        };

        sandbox.self = sandbox;
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;

        const context = vm.createContext(sandbox);

        try {
            vm.runInContext(workerScript, context);
            setTimeout(() => {
                if (sandbox.onmessage) {
                    sandbox.onmessage({ data: { type: 'pow-challenge', challenge: cleanPayload } });
                } else if (sandbox.self && sandbox.self.onmessage) {
                    sandbox.self.onmessage({ data: { type: 'pow-challenge', challenge: cleanPayload } });
                } else {
                    reject(new Error('Worker tidak memiliki handler onmessage'));
                }
            }, 1000);
        } catch (e) {
            clearTimeout(timeoutId);
            reject(e);
        }
    });
}

export async function getPowToken(token, targetPath) {
    try {
        const response = await axios.post(
            `${CONFIG.BASE_URL}/chat/create_pow_challenge`,
            { target_path: targetPath },
            { headers: { ...CONFIG.HEADERS, Authorization: `Bearer ${token}` } }
        );
        const challengeData = response.data.data.biz_data.challenge;
        return await solvePow(challengeData);
    } catch {
        return null;
    }
}
