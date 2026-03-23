type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";
let currentFormat: "json" | "text" = "json";

export function configureLogger(level: LogLevel, format: "json" | "text") {
  currentLevel = level;
  currentFormat = format;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const entry = { ts: new Date().toISOString(), level, msg: message, ...data };
  if (currentFormat === "json") {
    console.log(JSON.stringify(entry));
  } else {
    const extra = data ? " " + JSON.stringify(data) : "";
    console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}${extra}`);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
