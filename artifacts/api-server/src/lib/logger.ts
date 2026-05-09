import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/** Raw pino instance — used by pino-http so it shares the same config. */
export const pinoInstance = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.body.phone",
    "req.body.password",
    "req.body.cnic",
    "req.body.nationalId",
    "req.body.email",
    "req.body.otp",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

export interface AppLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): AppLogger;
}

export const logger: AppLogger = pinoInstance as unknown as AppLogger;
