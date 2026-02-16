const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function getLevel(): Level {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (env in LEVELS) return env as Level;
  return "info";
}

const currentLevel = getLevel();

function enabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatCtx(ctx?: Record<string, unknown>): string {
  if (!ctx) return "";
  return Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function write(level: Level, prefix: string, msg: string, ctx?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const extra = formatCtx(ctx);
  const line = `${ts} ${tag} [${prefix}] ${msg}${extra ? " " + extra : ""}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

function createLogger(prefix: string): Logger {
  return {
    debug: (msg, ctx) => write("debug", prefix, msg, ctx),
    info: (msg, ctx) => write("info", prefix, msg, ctx),
    warn: (msg, ctx) => write("warn", prefix, msg, ctx),
    error: (msg, ctx) => write("error", prefix, msg, ctx),
    child: (sub) => createLogger(`${prefix}:${sub}`),
  };
}

export const log = createLogger("api");
