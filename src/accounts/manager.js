// Manajemen akun DeepSeek:
// - load/save accounts.txt
// - cache token + login lock per akun (anti race-condition saat banyak request paralel)
// - Round Robin internal
// - cache untuk akun yang dikirim via API key 9router (email:password)

import fs from 'fs';
import { config } from '../config.js';
import { deepseek } from '../lib/deepseek/index.js';
import { createLogger } from '../util/logger.js';
import { accountStorageMode, adminWriteEnabled } from '../util/environment.js';

const log = createLogger('ACCOUNTS');

// Akun internal dari accounts.txt (kosong di mode header_only / Vercel)
let accounts = [];
let currentAccountIndex = 0;

// Cache untuk akun via API key 9router. Key: email:password
const providerCache = new Map();

// Per-akun lock supaya login ulang tidak duplikat saat 5 request datang bersamaan.
// Map<email_lower, Promise<account|null>>
const loginLocks = new Map();

function newAccount(email, password) {
    return { email, password, token: null, lastLogin: 0 };
}

export function loadAccounts() {
    // Mode Vercel / serverless: hanya support credential dari header request.
    if (accountStorageMode === 'header_only') {
        log.info('Mode header_only — akun hanya dari header request (9router). skip load accounts.txt');
        accounts = [];
        return;
    }

    // Mode VPS / local: load dari accounts.txt seperti biasa.
    try {
        if (!fs.existsSync(config.accountsFile)) {
            fs.writeFileSync(config.accountsFile, '', 'utf8');
        }
        const data = fs.readFileSync(config.accountsFile, 'utf8');
        accounts = data
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => {
                const [email, ...rest] = line.split(':');
                const password = rest.join(':');
                return newAccount(email, password);
            })
            .filter((a) => a.email && a.password);

        log.info(`Memuat ${accounts.length} akun dari ${config.accountsFile}`);
        if (accounts.length === 0) {
            log.warn('accounts.txt kosong — proxy hanya akan melayani request yang membawa API key 9router');
        }
    } catch (error) {
        log.error(`Gagal membaca accounts.txt: ${error.message}`);
    }
}

export function saveAccounts() {
    const lines = accounts.map((a) => `${a.email}:${a.password}`);
    fs.writeFileSync(config.accountsFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

export function listAccounts() {
    return accounts.map((a, idx) => ({
        index: idx,
        email: a.email,
        status: a.token ? 'logged_in' : 'waiting',
        last_login: a.lastLogin || 0
    }));
}

export function accountStats() {
    return {
        total: accounts.length,
        current_index: currentAccountIndex
    };
}

export function addAccount(email, password) {
    const exists = accounts.some((a) => a.email.toLowerCase() === String(email).toLowerCase());
    if (exists) return { ok: false, code: 409, message: 'Akun dengan email ini sudah ada.' };

    accounts.push(newAccount(String(email).trim(), String(password)));
    saveAccounts();
    return { ok: true, total: accounts.length };
}

export function removeAccount(email) {
    const target = String(email || '').trim().toLowerCase();
    const before = accounts.length;
    accounts = accounts.filter((a) => a.email.toLowerCase() !== target);
    if (accounts.length === before) return { ok: false, code: 404, message: 'Akun tidak ditemukan.' };

    if (accounts.length === 0) currentAccountIndex = 0;
    else currentAccountIndex = currentAccountIndex % accounts.length;

    saveAccounts();
    return { ok: true, total: accounts.length };
}

// Login dengan dedup lock — request paralel untuk akun yang sama hanya memicu 1 login.
async function ensureLoggedIn(account, label = 'ACCOUNT') {
    const now = Date.now();
    if (account.token && now - account.lastLogin <= config.tokenTtlMs) return account;

    const lockKey = account.email.toLowerCase();
    if (loginLocks.has(lockKey)) {
        return loginLocks.get(lockKey);
    }

    const promise = (async () => {
        try {
            log.info(`[${label}] Login: ${account.email}`);
            const auth = await deepseek.login(account.email, account.password);
            if (!auth) return null;
            account.token = auth.token;
            account.lastLogin = Date.now();
            log.info(`[${label}] Login sukses: ${account.email}`);
            return account;
        } finally {
            loginLocks.delete(lockKey);
        }
    })();

    loginLocks.set(lockKey, promise);
    return promise;
}

export function invalidateToken(account) {
    if (!account) return;
    account.token = null;
    account.lastLogin = 0;
}

async function getNextAccount(attempt = 0) {
    if (accounts.length === 0) return null;
    if (attempt >= accounts.length) return null;

    const account = accounts[currentAccountIndex];
    currentAccountIndex = (currentAccountIndex + 1) % accounts.length;

    const loggedIn = await ensureLoggedIn(account, 'RR');
    if (!loggedIn) {
        log.warn(`[RR] Gagal login akun: ${account.email}, coba akun berikutnya`);
        return getNextAccount(attempt + 1);
    }
    return loggedIn;
}

function parseCredentialFromHeaders(headers = {}) {
    const authHeader = headers.authorization || '';
    const xApiKey = headers['x-api-key'] || '';

    let raw = '';
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
        raw = authHeader.slice(7).trim();
    } else if (typeof xApiKey === 'string') {
        raw = xApiKey.trim();
    }

    if (!raw || !raw.includes(':')) return null;

    const idx = raw.indexOf(':');
    const email = raw.slice(0, idx).trim();
    const password = raw.slice(idx + 1).trim();
    if (!email || !password) return null;

    return { email, password, rawKey: `${email}:${password}` };
}

/**
 * Pilih akun berdasarkan request:
 * 1. Jika header membawa API key 9router (email:password) -> pakai akun itu (cached).
 * 2. Jika tidak -> Round Robin internal dari accounts.txt.
 */
export async function getAccountForRequest(req) {
    const parsed = parseCredentialFromHeaders(req.headers || {});

    if (parsed) {
        let cached = providerCache.get(parsed.rawKey);
        if (!cached) {
            cached = newAccount(parsed.email, parsed.password);
            providerCache.set(parsed.rawKey, cached);
        }
        const loggedIn = await ensureLoggedIn(cached, 'APIKEY');
        return loggedIn || null;
    }

    return getNextAccount();
}

// Untuk retry setelah token expired — login ulang akun yang sama.
export async function relogin(account, label = 'RETRY') {
    invalidateToken(account);
    return ensureLoggedIn(account, label);
}
