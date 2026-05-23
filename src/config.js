// Konfigurasi terpusat — dibaca dari .env, aman dipakai di seluruh modul.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root project = dua level di atas src/config.js
export const ROOT_DIR = path.resolve(__dirname, '..');

export const config = {
    port: parseInt(process.env.PORT, 10) || 3000,
    adminApiKey: process.env.ADMIN_API_KEY || '',

    // File akun untuk mode Round Robin internal
    accountsFile: path.resolve(ROOT_DIR, process.env.ACCOUNTS_FILE || 'accounts.txt'),

    // Token DeepSeek di-cache; refresh otomatis setelah TTL ini.
    tokenTtlMs: parseInt(process.env.TOKEN_TTL_MS, 10) || 60 * 60 * 1000,

    // Default model bila request tidak menyebut model.
    defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat',

    // Logging
    logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase()
};

export function assertAdminConfigured() {
    if (!config.adminApiKey) {
        throw new Error('ADMIN_API_KEY belum dikonfigurasi di .env');
    }
}
