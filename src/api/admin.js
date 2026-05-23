// Endpoint admin untuk manajemen accounts.txt.
// Dipakai 9router atau script otomatisasi internal.

import express from 'express';
import { config, assertAdminConfigured } from '../config.js';
import { adminWriteEnabled } from '../util/environment.js';
import {
    listAccounts,
    accountStats,
    addAccount,
    removeAccount
} from '../accounts/manager.js';

const router = express.Router();

function requireAdmin(req, res, next) {
    // Di Vercel / serverless, admin write tidak tersedia.
    if (!adminWriteEnabled) {
        return res.status(503).json({
            error: {
                message: 'Endpoint admin tidak tersedia di serverless (Vercel). Gunakan env var atau 9router untuk manajemen akun.',
                type: 'service_unavailable'
            }
        });
    }

    try {
        assertAdminConfigured();
    } catch (err) {
        return res.status(500).json({ error: { message: err.message } });
    }

    const incomingKey = req.headers['x-api-key'];
    if (!incomingKey || incomingKey !== config.adminApiKey) {
        return res.status(401).json({ error: { message: 'Unauthorized: API key tidak valid' } });
    }
    next();
}

router.get('/accounts', requireAdmin, (_req, res) => {
    res.json({ ...accountStats(), data: listAccounts() });
});

router.post('/accounts', requireAdmin, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: { message: 'email dan password wajib diisi.' } });
    }
    const result = addAccount(email, password);
    if (!result.ok) return res.status(result.code).json({ error: { message: result.message } });
    res.status(201).json({ message: 'Akun berhasil ditambahkan.', total: result.total });
});

router.delete('/accounts/:email', requireAdmin, (req, res) => {
    const target = decodeURIComponent(req.params.email || '');
    const result = removeAccount(target);
    if (!result.ok) return res.status(result.code).json({ error: { message: result.message } });
    res.json({ message: 'Akun berhasil dihapus.', total: result.total });
});

export default router;
