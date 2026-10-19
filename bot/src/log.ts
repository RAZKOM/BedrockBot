export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Timestamped logger writing to stderr, so stdout stays free for task output. */
export function createLogger(level: LogLevel = 'info', scope = 'bot'): Logger {
  const at = (l: Exclude<LogLevel, 'silent'>) => (msg: string, ...rest: unknown[]): void => {
    if (ORDER[l] < ORDER[level]) return;
    console.error(`${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} [${scope}] ${msg}`, ...rest);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
