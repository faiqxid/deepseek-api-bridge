// Deteksi runtime environment untuk menentukan mode operasi.
//
// - Vercel (serverless): filesystem read-only, in-memory state hilang per cold start.
//   Mode ini HANYA mendukung 9router-style request (credential di header per request).
// - VPS / Local: filesystem persistent, mendukung accounts.txt + admin API + 9router header.
//
// Auto-deteksi via env var standar Vercel.

export const isVercel = Boolean(
    process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.NOW_REGION
);

export const isServerless = isVercel ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER_RUNTIME; // Azure

/**
 * Mode penyimpanan akun:
 * - 'header_only': akun hanya dari header request (9router)
 * - 'file': akun dari accounts.txt + header request (VPS/local)
 */
export const accountStorageMode = isServerless ? 'header_only' : 'file';

/**
 * Apakah endpoint admin (POST/DELETE accounts) tersedia di runtime ini.
 * Di Vercel selalu false karena tidak bisa write file.
 */
export const adminWriteEnabled = !isServerless;

export function describeRuntime() {
    if (isVercel) return `Vercel (${process.env.VERCEL_ENV || 'unknown'})`;
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'AWS Lambda';
    if (process.env.FUNCTIONS_WORKER_RUNTIME) return 'Azure Functions';
    return 'VPS / Local';
}
