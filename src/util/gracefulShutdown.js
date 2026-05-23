// Graceful shutdown handler untuk Express server.
// Memastikan semua request yang sedang berjalan selesai sebelum server mati.
//
// Cara kerja:
// 1. Track jumlah request aktif (incoming → increment, response → decrement)
// 2. Saat terima SIGTERM/SIGINT, stop terima request baru
// 3. Tunggu semua request aktif selesai (max 30 detik)
// 4. Kemudian baru exit

import { createLogger } from '../util/logger.js';

const log = createLogger('SHUTDOWN');

// Counter untuk request yang sedang diproses
let activeRequests = 0;
// Flag untuk menandai server sedang shutdown
let isShuttingDown = false;
// Callback yang akan dipanggil saat semua request selesai
let shutdownCallback = null;

/**
 * Middleware untuk tracking request aktif.
 * Pasang di awal middleware chain.
 */
export function requestTracker(req, res, next) {
    if (isShuttingDown) {
        // Tolak request baru saat sedang shutdown
        return res.status(503).json({
            error: {
                message: 'Server sedang dalam proses shutdown. Coba lagi dalam beberapa detik.',
                type: 'service_unavailable'
            }
        });
    }

    activeRequests++;
    log.debug(`Request aktif: ${activeRequests}`);

    // Decrement saat response selesai
    res.on('finish', () => {
        activeRequests--;
        log.debug(`Request aktif: ${activeRequests}`);

        // Jika sedang shutdown dan tidak ada request lagi, panggil callback
        if (isShuttingDown && activeRequests === 0 && shutdownCallback) {
            shutdownCallback();
            shutdownCallback = null;
        }
    });

    // Juga decrement jika request di-abort (client disconnect)
    res.on('close', () => {
        if (!res.writableEnded) {
            activeRequests--;
            log.debug(`Request di-abort, aktif: ${activeRequests}`);
        }
    });

    next();
}

/**
 * Setup graceful shutdown handlers.
 * Panggil setelah server.listen().
 *
 * @param {http.Server} server - HTTP server instance
 * @param {number} timeout - Maximum waktu tunggu (detik), default 30
 */
export function setupGracefulShutdown(server, timeout = 30) {
    let isShuttingDownStarted = false;

    const shutdown = (signal) => {
        if (isShuttingDownStarted) return; // Prevent double shutdown
        isShuttingDownStarted = true;
        isShuttingDown = true;

        log.info(`Menerima ${signal}, memulai graceful shutdown...`);
        log.info(`Request aktif: ${activeRequests}`);

        if (activeRequests === 0) {
            log.info('Tidak ada request aktif, langsung shutdown.');
            server.close(() => {
                log.info('Server berhasil shutdown.');
                process.exit(0);
            });
            return;
        }

        log.info(`Menunggu ${activeRequests} request selesai (timeout: ${timeout}s)...`);

        // Set timeout untuk force shutdown
        const forceShutdownTimeout = setTimeout(() => {
            log.warn(`Timeout ${timeout}s tercapai, force shutdown.`);
            server.close(() => {
                process.exit(1);
            });
        }, timeout * 1000);

        // Callback yang dipanggil saat semua request selesai
        shutdownCallback = () => {
            clearTimeout(forceShutdownTimeout);
            log.info('Semua request selesai, menutup server...');
            server.close(() => {
                log.info('Server berhasil shutdown.');
                process.exit(0);
            });
        };
    };

    // Register signal handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
        log.error(`Uncaught Exception: ${err.message}`);
        log.error(err.stack);
        shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        log.error(`Unhandled Rejection di: ${promise}`);
        log.error(`Reason: ${reason}`);
    });

    log.info('Graceful shutdown handler aktif.');
}

/**
 * Export state untuk debugging
 */
export function getActiveRequestCount() {
    return activeRequests;
}

export function isInShutdownMode() {
    return isShuttingDown;
}
