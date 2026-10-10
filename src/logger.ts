import { config } from "./config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold: number =
  LEVELS[config.logLevel as Level] ?? LEVELS.info;

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope}:`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(prefix, ...args);
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit("debug", scope, args),
    info: (...args: unknown[]) => emit("info", scope, args),
    warn: (...args: unknown[]) => emit("warn", scope, args),
    error: (...args: unknown[]) => emit("error", scope, args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
