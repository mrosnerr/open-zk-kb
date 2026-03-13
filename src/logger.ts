// logger.ts - Simple file logging for open-zk-kb

import * as fs from 'fs';
import * as path from 'path';
import { expandPath } from './utils/path.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface AppConfig {
  logLevel?: LogLevel;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let logsDir: string | null = null;

export function getLogsDir(): string {
  if (logsDir) return logsDir;

  const xdgStateHome = process.env.XDG_STATE_HOME || expandPath('~/.local/state');
  logsDir = path.join(xdgStateHome, 'open-zk-kb', 'logs');

  if (!fs.existsSync(logsDir)) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
      logsDir = '/tmp';
    }
  }

  return logsDir;
}

export function logToFile(level: LogLevel, message: string, data?: unknown, config?: AppConfig): void {
  const configLevel = config?.logLevel || 'INFO';

  if (LOG_LEVELS[level] < LOG_LEVELS[configLevel]) {
    return;
  }

  const logsDir = getLogsDir();
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(logsDir, `open-zk-kb-${today}.log`);

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  };

  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
  }
}

export function cleanupOldLogs(logsDir: string, retentionDays: number = 7): void {
  try {
    const files = fs.readdirSync(logsDir);
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    for (const file of files) {
      if (file.startsWith('open-zk-kb-') && file.endsWith('.log')) {
        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);
        if (stats.mtime.getTime() < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch {
  }
}

export function sanitizeArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['token', 'key', 'secret', 'password', 'apiKey', 'auth'];
  const sanitized: Record<string, unknown> = { ...args };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

export function sanitizeContent(content: string): { sanitized: string; redactedCount: number; isTooSensitive: boolean } {
  const sensitivePatterns = [
    /(apiKey|api_key|apikey)[\s:="']+([a-zA-Z0-9-_]+)/gi,
    /(sk-[a-zA-Z0-9]{20,})/g,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  ];

  let sanitized = content;
  let redactedCount = 0;
  let isTooSensitive = false;

  for (const pattern of sensitivePatterns) {
    const matches = sanitized.match(pattern);
    if (matches && matches.length > 5) {
      isTooSensitive = true;
      break;
    }
    sanitized = sanitized.replace(pattern, '[REDACTED]');
    if (matches) redactedCount += matches.length;
  }

  return { sanitized, redactedCount, isTooSensitive };
}

export function isSensitiveFile(filePath: string): boolean {
  const sensitiveExtensions = ['.env', '.pem', '.key', '.crt', '.p12', '.keystore'];
  const sensitiveNames = ['password', 'secret', 'credential', 'token', 'auth'];

  const ext = path.extname(filePath).toLowerCase();
  if (sensitiveExtensions.includes(ext)) return true;

  const baseName = path.basename(filePath).toLowerCase();
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;
  return sensitiveNames.some(name => baseName.includes(name));
}
