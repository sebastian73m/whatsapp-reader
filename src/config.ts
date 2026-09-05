import path from "node:path";
import process from "node:process";
import "dotenv/config";

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} debe ser un entero entre 1 y ${max}`);
  }
  return parsed;
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error(`WHATSAPP_READER_TIME_ZONE no es una zona IANA válida: ${value}`);
  }
}

const dataDir = path.resolve(process.env.WHATSAPP_READER_DATA_DIR ?? "./data");

export const config = {
  dataDir,
  dbPath: path.resolve(process.env.WHATSAPP_READER_DB_PATH ?? path.join(dataDir, "whatsapp.sqlite")),
  authDir: path.resolve(process.env.WHATSAPP_READER_AUTH_DIR ?? "./auth"),
  sendSocketPath: path.resolve(process.env.WHATSAPP_READER_SEND_SOCKET ?? path.join(dataDir, "send.sock")),
  sendTimeoutMs: positiveInt("WHATSAPP_READER_SEND_TIMEOUT_MS", 15_000, 60_000),
  timeZone: validateTimeZone(process.env.WHATSAPP_READER_TIME_ZONE ?? "UTC"),
  defaultLimit: positiveInt("WHATSAPP_READER_DEFAULT_LIMIT", 20, 100),
  logLevel: process.env.WHATSAPP_READER_LOG_LEVEL ?? "info",
  maxReconnectAttempts: positiveInt("WHATSAPP_READER_MAX_RECONNECT_ATTEMPTS", 8, 50),
  reconnectBaseMs: positiveInt("WHATSAPP_READER_RECONNECT_BASE_MS", 1_000, 60_000),
} as const;
