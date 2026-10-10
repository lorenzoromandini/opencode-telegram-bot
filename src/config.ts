import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const allowedUserIds = parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS);
const allowUnsafe = envBool("ALLOW_UNSAFE", false);

if (!botToken) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN mancante. Crea un bot con @BotFather e metti il token nel file .env",
  );
}

export const config = {
  projectRoot,
  botToken,
  allowedUserIds: new Set(allowedUserIds),
  allowUnsafe,
  /** true quando nessun ID è autorizzato e l'accesso libero è disattivato. */
  lockdown: allowedUserIds.length === 0 && !allowUnsafe,
  serverUrl: process.env.OPENCODE_SERVER_URL?.trim() || undefined,
  defaultWorkdir:
    process.env.OPENCODE_DEFAULT_WORKDIR?.trim() || process.cwd(),
  streamEditIntervalMs: Math.max(
    500,
    Number(process.env.STREAM_EDIT_INTERVAL_MS ?? "1500") || 1500,
  ),
  logLevel: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  stateFile: path.join(projectRoot, "data", "state.json"),
} as const;

export type Config = typeof config;
