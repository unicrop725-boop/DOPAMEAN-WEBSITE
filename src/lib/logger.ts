import pino, { type Logger } from 'pino';

/** Keys whose values must never reach logs (brief §9). Matched at any depth up to 3. */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'token',
  'secret',
  'authorization',
  'cookie',
  'email',
  'phone',
  'cardNumber',
  'razorpay_signature',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.cookie',
  '*.email',
  '*.phone',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.*.password',
  '*.*.token',
  '*.*.email',
  '*.*.phone',
];

export const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: process.env.SERVICE_NAME ?? 'web' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Child logger carrying the request id on every line. */
export function requestLogger(requestId: string, extra: Record<string, unknown> = {}): Logger {
  return baseLogger.child({ requestId, ...extra });
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
