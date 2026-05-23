// DeepSeek Multi-Account API Proxy — Entry Point
//
// OpenAI-compatible proxy untuk DeepSeek dengan dukungan:
// - Round Robin multi-akun (accounts.txt)
// - 9router integration via API key (email:password)
// - Streaming token-by-token untuk Cline / Roo / Continue / OpenAI SDK
// - thinking/reasoning_content untuk model deepseek-reasoner
//
// Dapat dijalankan sebagai:
// - Standalone Express server (VPS / local): npm start
// - Serverless function (Vercel): import app dari api/index.js

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'url';

import { config, assertAdminConfigured } from './config.js';
import { loadAccounts } from './accounts/manager.js';
import { requestLogger, normalizeRequest } from './util/requestMiddleware.js';
import { requestTracker, setupGracefulShutdown } from './util/gracefulShutdown.js';
import { isVercel, describeRuntime } from './util/environment.js';
import v1Router from './api/v1.js';
import adminRouter from './api/admin.js';
import healthRouter from './api/health.js';
import debugRouter from './api/debug.js';
import { createLogger } from './util/logger.js';

const log = createLogger('SERVER');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(requestTracker);     // tracking request aktif (graceful shutdown)
app.use(requestLogger);      // log request masuk
app.use(normalizeRequest);   // normalisasi header & body dari 9router

// Opsional: assert ADMIN_API_KEY configured saat server start —
// 9router mungkin tidak butuh endpoint admin, tapi kita tetap ingatkan.
if (process.env.CHECK_ADMIN_ON_START !== 'false') {
    try {
        assertAdminConfigured();
    } catch (e) {
        log.warn(`ADMIN_API_KEY belum dikonfigurasi — endpoint /admin/* akan mengembalikan 500.`);
    }
}

// Routing
app.use('/v1', v1Router);
app.use('/admin', adminRouter);
app.use('/health', healthRouter);
app.use('/debug', debugRouter);

// root redirect ke /health — handy untuk sanity check.
app.get('/', (_req, res) => {
    res.redirect('/health');
});

// Load akun saat app di-import (penting untuk Vercel cold start).
loadAccounts();

// Log runtime info sekali saat startup.
log.info(`Runtime: ${describeRuntime()}`);

// Export app untuk Vercel serverless / testing.
export default app;

// Start standalone server hanya jika dijalankan langsung (bukan di-import).
// Di Vercel, file ini di-import oleh api/index.js, jadi server tidak di-start.
// Pakai pathToFileURL agar comparison tetap akurat di Windows
// (import.meta.url meng-URL-encode spasi, sedangkan process.argv[1] tidak).
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;

if (!isVercel && isMainModule) {
    const PORT = config.port;
    const server = app.listen(PORT, () => {
        log.info('========================================');
        log.info('  DeepSeek Multi-Account Proxy');
        log.info(`  Port: ${PORT}`);
        log.info(`  URL:  http://localhost:${PORT}/v1`);
        log.info('========================================');
    });

    // Registrasi graceful shutdown handler
    setupGracefulShutdown(server, 30);
}