export type InlineSaveState = {
  editing: boolean;
  draft: string;
  saving: boolean;
  status: string;
  error: string;
};

// Own one field's draft and coalesce edits while its previous write is pending.
export function createInlineAutosave(
  initial: string,
  persist: (value: string) => Promise<void>,
  notify: (state: InlineSaveState) => void,
  options: { autosave: boolean; valid: () => boolean },
) {
  let saved = initial;
  let draft = initial;
  let saving = false;
  let editing = true;
  let error = "";
  let queued = false;
  let closing = false;
  let cancelling = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function emit() {
    if (!disposed) notify({ editing, draft, saving, error,
      status: error ? "Save failed" : saving ? "Saving…" : draft !== saved ? "Unsaved" : "Saved" });
  }

  async function flush(close = false) {
    clearTimer();
    closing ||= close;
    if (disposed || !editing) return;
    if (saving) { queued = true; return; }
    if (draft === saved) {
      if (closing) editing = false;
      emit();
      return;
    }
    if (!options.valid()) { closing = false; emit(); return; }

    const submitted = draft;
    saving = true;
    error = "";
    queued = false;
    emit();
    try {
      await persist(submitted);
      saved = submitted;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not save changes.";
      // A failed write requires a retry or another edit, never an endless retry loop.
      queued = false;
      closing = false;
      clearTimer();
    } finally {
      saving = false;
    }
    if (disposed) return;
    if (cancelling) {
      draft = saved;
      error = "";
      editing = false;
    } else if (!error && queued && draft !== saved) {
      await flush(closing);
      return;
    } else if (!error && closing && draft === saved) {
      editing = false;
    }
    emit();
  }

  return {
    change(value: string) {
      draft = value;
      error = "";
      closing = false;
      cancelling = false;
      queued = false;
      clearTimer();
      if (options.autosave && (draft !== saved || saving)) timer = setTimeout(() => { void flush(); }, 1000);
      emit();
    },
    flush,
    cancel() {
      clearTimer();
      queued = false;
      closing = false;
      // An already submitted write must settle before we know the last saved value.
      if (saving) cancelling = true;
      else { draft = saved; error = ""; editing = false; }
      emit();
    },
    dispose() { disposed = true; clearTimer(); },
  };
}
