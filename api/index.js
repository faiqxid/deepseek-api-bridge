// Vercel serverless entry point.
// Auto-detect mode dan jalankan Express app.
//
// Deploy ke Vercel:
// 1. Push ke repo GitHub
// 2. Import project di vercel.com
// 3. Environment variables (opsional):
//    - PORT (default 3000)
//    - ADMIN_API_KEY (untuk local mode)
//    - LOG_LEVEL (default info)
// 4. Deploy

import { createServer } from 'http';
import app from '../src/index.js';

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Vercel auto-inject serverless handler via export default.
// Kita export handler yang sama untuk semua route.
export default app;

// Untuk local development (npm start), jalankan Express biasa.
if (typeof process !== 'undefined' && process.env && !process.env.VERCEL) {
    const server = createServer(app);
    server.listen(PORT, () => {
        console.log(`DeepSeek Proxy listening on port ${PORT}`);
    });
}
