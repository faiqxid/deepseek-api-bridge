// Logger ringan — output rapi, mudah dibaca di terminal Cline / VSCode.
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function fmt(level, tag, msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
}

function emit(level, tag, msg) {
    if (LEVELS[level] < threshold) return;
    const line = fmt(level, tag, msg);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

export function createLogger(tag = 'APP') {
    return {
        debug: (msg) => emit('debug', tag, msg),
        info: (msg) => emit('info', tag, msg),
        warn: (msg) => emit('warn', tag, msg),
        error: (msg) => emit('error', tag, msg)
    };
}
