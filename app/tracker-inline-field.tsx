"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { formatDateTime } from "@/lib/date-time";
import { createInlineAutosave } from "@/lib/inline-autosave";
import type { InlineSaveState } from "@/lib/inline-autosave";

export const InlineBusyContext = createContext(false);
export const InlineEditingContext = createContext<Dispatch<SetStateAction<number>> | null>(null);

type Props = {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  multiline?: boolean;
  required?: boolean;
  type?: "text" | "email" | "datetime-local";
  placeholder?: string;
  disabled?: boolean;
};

// Keep drafts independent of refreshed data until the user saves or cancels.
export default function InlineField({ label, value, onSave, multiline = false, required = false, type = "text", placeholder = "Click to add…", disabled = false }: Props) {
  const [state, setState] = useState<InlineSaveState>({ editing: false, draft: value, saving: false, status: "", error: "" });
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const session = useRef<ReturnType<typeof createInlineAutosave> | null>(null);
  const composing = useRef(false);
  const register = useContext(InlineEditingContext);

  // Prevent pane changes from unmounting a draft, including one awaiting a retry.
  useEffect(() => {
    if (!state.editing || !register) return;
    register(count => count + 1);
    return () => register(count => count - 1);
  }, [state.editing, register]);

  useEffect(() => () => session.current?.dispose(), []);

  function commit() {
    if (!composing.current && input.current?.reportValidity()) void session.current?.flush(true);
  }

  function change(value: string) {
    session.current?.change(value);
  }

  return <div className={`inline-field ${multiline ? "inline-multiline" : ""}`} onBlur={event => {
    if (state.editing && !event.currentTarget.contains(event.relatedTarget)) commit();
  }}>
    {state.editing ? <>
      {multiline ? <textarea ref={element => {
        input.current = element;
        if (element) { element.style.height = "auto"; element.style.height = `${element.scrollHeight}px`; }
      }} aria-label={label} value={state.draft} required={required} autoFocus rows={3}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => { composing.current = false; change(event.currentTarget.value); }}
        onChange={event => change(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); session.current?.cancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
        }} /> : <input ref={element => { input.current = element; }} aria-label={label} type={type} step={type === "datetime-local" ? "60" : undefined}
        value={state.draft} required={required} autoFocus onChange={event => change(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); session.current?.cancel(); }
          if (event.key === "Enter") { event.preventDefault(); commit(); }
        }} />}
    </> : <button type="button" className={`inline-display ${!value ? "inline-placeholder" : ""}`} aria-label={`Edit ${label}`} disabled={disabled} onClick={() => {
      session.current?.dispose();
      session.current = createInlineAutosave(value, onSave, setState, {
        autosave: multiline,
        valid: () => !composing.current && !!input.current?.checkValidity() && (!required || !!input.current.value.trim()),
      });
      setState({ editing: true, draft: value, saving: false, error: "", status: "Saved" });
    }}>{value ? type === "datetime-local" ? formatDateTime(value) : value : placeholder}</button>}
    {state.status && <span className="inline-status" role="status">{state.status}</span>}
    {state.error && <span className="inline-error" role="alert">{state.error}</span>}
  </div>;
}
