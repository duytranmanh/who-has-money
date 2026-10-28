import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInlineAutosave } from "./inline-autosave";
import type { InlineSaveState } from "./inline-autosave";

function setup(autosave = true, persist = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)) {
  let state: InlineSaveState;
  const valid = vi.fn(() => true);
  const session = createInlineAutosave("original", persist, next => { state = next; }, { autosave, valid });
  return { session, persist, valid, state: () => state };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("inline autosave", () => {
  it("saves only the latest draft after one second of inactivity and keeps editing open", async () => {
    const { session, persist, state } = setup();
    session.change("first");
    await vi.advanceTimersByTimeAsync(700);
    session.change("latest");
    expect(state().status).toBe("Unsaved");
    await vi.advanceTimersByTimeAsync(999);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledExactlyOnceWith("latest");
    expect(state()).toMatchObject({ editing: true, draft: "latest", status: "Saved", saving: false });
  });

  it("flushes immediately and cancels the pending debounce on blur or explicit save", async () => {
    const { session, persist, state } = setup();
    session.change("changed");
    await session.flush(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledExactlyOnceWith("changed");
    expect(state().editing).toBe(false);
  });

  it("keeps single-line fields unsaved until explicitly flushed", async () => {
    const { session, persist } = setup(false);
    session.change("new name");
    await vi.advanceTimersByTimeAsync(5000);
    expect(persist).not.toHaveBeenCalled();
    await session.flush(true);
    expect(persist).toHaveBeenCalledExactlyOnceWith("new name");
  });

  it("coalesces newer edits behind an outstanding save without overwriting the draft", async () => {
    const first = deferred();
    const persist = vi.fn<(value: string) => Promise<void>>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { session, state } = setup(true, persist);
    session.change("first");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("second");
    session.change("latest");
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ saving: true, draft: "latest" });
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(persist.mock.calls.map(call => call[0])).toEqual(["first", "latest"]);
    expect(state()).toMatchObject({ draft: "latest", status: "Saved", editing: true });
  });

  it("persists a revert to the old value made during an outstanding write", async () => {
    const first = deferred();
    const persist = vi.fn<(value: string) => Promise<void>>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { session } = setup(true, persist);
    session.change("first");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("original");
    await vi.advanceTimersByTimeAsync(1000);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(persist.mock.calls.map(call => call[0])).toEqual(["first", "original"]);
  });

  it("retains the latest draft after failure and retries only when requested", async () => {
    const first = deferred();
    const persist = vi.fn<(value: string) => Promise<void>>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { session, state } = setup(true, persist);
    session.change("first");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("latest");
    await vi.advanceTimersByTimeAsync(1000);
    first.reject(new Error("Disk full"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ editing: true, draft: "latest", error: "Disk full", status: "Save failed" });
    await session.flush(true);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(state()).toMatchObject({ editing: false, error: "", status: "Saved" });
  });

  it("cancels only changes after the last confirmed save", async () => {
    const { session, state, persist } = setup();
    session.change("saved notes");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("discard this");
    session.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledExactlyOnceWith("saved notes");
    expect(state()).toMatchObject({ draft: "saved notes", editing: false });
  });

  it("waits for an in-flight write before cancelling newer unsaved changes", async () => {
    const first = deferred();
    const persist = vi.fn<(value: string) => Promise<void>>().mockReturnValue(first.promise);
    const { session, state } = setup(true, persist);
    session.change("submitted");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("discard");
    session.cancel();
    first.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledExactlyOnceWith("submitted");
    expect(state()).toMatchObject({ draft: "submitted", editing: false, status: "Saved" });
  });

  it("does not persist invalid values or unchanged values", async () => {
    const { session, persist, valid, state } = setup();
    valid.mockReturnValue(false);
    session.change("");
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().status).toBe("Unsaved");
    expect(persist).not.toHaveBeenCalled();
    valid.mockReturnValue(true);
    session.change("original");
    await session.flush(true);
    expect(persist).not.toHaveBeenCalled();
    expect(state().editing).toBe(false);
  });

  it("clears timers and ignores late responses after disposal", async () => {
    const { session, persist } = setup();
    session.change("discard on unmount");
    session.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).not.toHaveBeenCalled();
    const first = deferred();
    const notify = vi.fn();
    const active = createInlineAutosave("original", () => first.promise, notify, { autosave: true, valid: () => true });
    active.change("pending");
    await vi.advanceTimersByTimeAsync(1000);
    active.dispose();
    notify.mockClear();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
