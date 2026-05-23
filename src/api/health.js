// Health-check sederhana — dipakai 9router untuk readiness probe.

import express from 'express';
import { listAccounts, accountStats } from '../accounts/manager.js';

const router = express.Router();

router.get('/', (_req, res) => {
    const stats = accountStats();
    res.json({
        status: 'active',
        accounts_count: stats.total,
        current_index: stats.current_index,
        uptime: process.uptime(),
        accounts_status: listAccounts().map((a) => ({ email: a.email, status: a.status }))
    });
});

export default router;
