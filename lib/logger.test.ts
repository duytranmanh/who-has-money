/**
 * @fileoverview Verifies the server logger's JSON envelope and stderr-only output contract.
 * Research-specific metadata selection is covered by company-research.test.ts.
 */

import { afterEach, expect, it, vi } from "vitest";
import { logger, type LogFields } from "./logger";

afterEach(() => vi.restoreAllMocks());

it("writes each level as one JSON line while keeping stdout free for CLI results", () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(console, "info").mockImplementation(() => {});
  const fields = { runId: "run-1", durationMs: 10, tokens: { prompt: 20, completion: 10 }, optional: undefined };
  for (const level of ["info", "warn", "error"] as const) logger[level]("research.test", fields);
  const entries = stderr.mock.calls.map(([line]) => JSON.parse(line));
  expect(entries.map(entry => entry.level)).toEqual(["info", "warn", "error"]);
  expect(entries[0]).toMatchObject({ event: "research.test", runId: "run-1", durationMs: 10, tokens: { prompt: 20, completion: 10 } });
  expect(Number.isFinite(Date.parse(entries[0].timestamp))).toBe(true);
  expect(entries[0]).not.toHaveProperty("optional");
  expect(stdout).not.toHaveBeenCalled();
  expect(fields).not.toHaveProperty("timestamp");
});

it("prevents runtime metadata from overriding reserved fields", () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  logger.info("research.started", { level: "fake", event: "fake", timestamp: "fake" } as unknown as LogFields);
  expect(JSON.parse(stderr.mock.calls[0][0])).toMatchObject({ level: "info", event: "research.started" });
  expect(JSON.parse(stderr.mock.calls[0][0]).timestamp).not.toBe("fake");
});
