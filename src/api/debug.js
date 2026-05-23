// Endpoint debug untuk melihat request asli dari 9router.
// Hanya aktif jika env DEBUG=1.

import express from 'express';
import { createLogger } from '../util/logger.js';

const log = createLogger('DEBUG');
const router = express.Router();

router.post('/request', (req, res) => {
    const { headers, body, query, ip, method, url } = req;
    const safeHeaders = { ...headers };
    if (safeHeaders.authorization) {
        safeHeaders.authorization = safeHeaders.authorization.replace(/[^:]+:[^:]+/, '***:***');
    }
    if (safeHeaders['x-api-key']) {
        safeHeaders['x-api-key'] = '***:***';
    }

    log.info(`[${ip}] ${method} ${url}`);
    log.info('Headers:', JSON.stringify(safeHeaders, null, 2));
    log.info('Body:', JSON.stringify(body, null, 2));
    log.info('Query:', JSON.stringify(query, null, 2));

    res.json({
        received: true,
        timestamp: new Date().toISOString(),
        headers: safeHeaders,
        body_keys: Object.keys(body || {}),
        message: 'Request logged. Check server console.'
    });
});

export default router;
