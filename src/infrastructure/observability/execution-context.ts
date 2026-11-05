import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface ExecutionContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithContext<T>(
  context: ExecutionContext,
  action: () => T,
): T {
  return storage.run({ ...context }, action);
}

export function currentContext(): Readonly<
  ExecutionContext
> | undefined {
  const context = storage.getStore();

  return context === undefined
    ? undefined
    : { ...context };
}

export function enrichContext(
  fields: Partial<Omit<ExecutionContext, "correlationId">>,
): void {
  const context = storage.getStore();

  if (context !== undefined) {
    Object.assign(context, fields);
  }
}

export function correlationIdFrom(value: unknown): string {
  if (
    typeof value === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
  ) {
    return value;
  }

  return randomUUID();
}

function writeLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields,
): void {
  const line = JSON.stringify({
    ...fields,
    ...storage.getStore(),
    timestamp: new Date().toISOString(),
    level,
    event,
    service: process.env.SERVICE_NAME ?? "jungle-wagering",
  });

  switch (level) {
    case "error":
      console.error(line);
      break;

    case "warn":
      console.warn(line);
      break;

    default:
      console.log(line);
  }
}

export const logger = {
  info(event: string, fields: LogFields = {}): void {
    writeLog("info", event, fields);
  },

  warn(event: string, fields: LogFields = {}): void {
    writeLog("warn", event, fields);
  },

  error(event: string, fields: LogFields = {}): void {
    writeLog("error", event, fields);
  },
};
