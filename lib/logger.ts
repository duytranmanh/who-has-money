/**
 * @fileoverview Writes structured server diagnostics as one JSON object per line.
 * Research callers select safe metadata; this module never serializes requests or errors implicitly.
 * Uses stderr so scripts/research-company.ts can keep result JSON alone on stdout.
 */

import "node:process";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type LogFields = Record<string, JsonValue | undefined> & {
  timestamp?: never; level?: never; event?: never;
};

function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  // Reserved fields come last so even untyped callers cannot override the log envelope.
  console.error(JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, event }));
}

export const logger = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
