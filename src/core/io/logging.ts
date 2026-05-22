export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.error(`[info] ${message}`),
  warn: (message) => console.error(`[warn] ${message}`),
  error: (message) => console.error(`[error] ${message}`),
};
