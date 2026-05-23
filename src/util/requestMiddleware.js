import { createLogger } from '../util/logger.js';

const log = createLogger('REQ');

/**
 * Middleware untuk mencatat semua request yang masuk ke proxy.
 * Ini membantu melacak apa yang 9router kirim, terutama header
 * Authorization / x-api-key, body, dan query string.
 */
export function requestLogger(req, res, next) {
  const { method, originalUrl, headers, query } = req;
  const body = req.body;
  log.info(`${method} ${originalUrl}`);

  // Tentukan modul/handler yang akan dipakai
  let handler = 'unknown';
  if (originalUrl.startsWith('/v1/')) handler = 'api/v1.js';
  else if (originalUrl.startsWith('/admin/')) handler = 'api/admin.js';
  else if (originalUrl.startsWith('/health')) handler = 'api/health.js';
  else if (originalUrl.startsWith('/debug/')) handler = 'api/debug.js';
  else if (originalUrl === '/') handler = 'root redirect';
  log.info(`  Handler    : ${handler}`);

  log.debug('Headers:', JSON.stringify(headers, null, 2));
  if (Object.keys(query).length) log.debug('Query:', JSON.stringify(query));
  // Log model yang diminta (jika ada) — info level supaya selalu kelihatan.
  if (body && typeof body.model === 'string') {
    log.info(`  Model      : ${body.model}`);
  }
  if (body && Object.keys(body).length) log.debug('Body:', JSON.stringify(body, null, 2));
  next();
}

/**
 * Normalisasi request yang datang dari 9router.
 * Beberapa provider (termasuk 9router) mengirim credential di header
 * `x-api-key` alih‑alih `Authorization`. Kita memastikan keduanya ada
 * dalam bentuk `Bearer <API_KEY>` sehingga kode akun dapat tetap
 * memakai `parseCredentialFromHeaders` yang ada.
 */
export function normalizeRequest(req, res, next) {
  // Jika ada header x-api-key, ubah ke Authorization
  const apiKey = req.headers['x-api-key'];
  if (apiKey && !req.headers['authorization']) {
    // 9router mengirim "email:password"
    req.headers['authorization'] = `Bearer ${apiKey}`;
  }
  // 9router kadang mengirim body dalam format {messages: [{role, content}]}
  // Pastikan content tetap string (bukan object) – kalau objek, stringify.
  if (req.body && Array.isArray(req.body.messages)) {
    req.body.messages = req.body.messages.map(m => {
      if (typeof m.content === 'object') {
        return { ...m, content: JSON.stringify(m.content) };
      }
      return m;
    });
  }
  next();
}
