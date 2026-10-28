"use client";

import InlineField, { InlineBusyContext } from "./tracker-inline-field";
import { useContext, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { TrackerContact, TrackerMessage, TrackerSequence } from "@/lib/tracker";

export type OutreachAction = { kind: "start" } | { kind: "follow" | "response" | "close"; sequence: TrackerSequence }
  | { kind: "edit"; message: TrackerMessage } | { kind: "delete"; message: TrackerMessage };
type Save = (url: string, method: string, values: Record<string, unknown>) => Promise<void>;
const kinds = { initial: "Initial outreach", follow_up_1: "First follow-up", follow_up_2: "Second follow-up" };
const reasons = { responded: "Responded", completed: "Completed · two follow-ups sent", manual: "Closed manually", restarted: "Closed by a new outreach attempt" };

// datetime-local displays wall time; API writes always include an explicit UTC timezone.
function localTimestamp(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

// Keep an action's draft mounted after errors; only confirmed persistence closes the form.
function ActionForm({ action, contact, onSave, onCancel }: { action: OutreachAction; contact: TrackerContact; onSave: Save; onCancel: () => void }) {
  const id = useId();
  const original = action.kind === "edit" ? action.message : undefined;
  const [initialAt] = useState(() => original ? localTimestamp(original.sentAt) : action.kind === "start" ? "" : localTimestamp(new Date().toISOString()));
  const [at, setAt] = useState(initialAt);
  const [text, setText] = useState(original?.text ?? "");
  const [notes, setNotes] = useState(original?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const isMessage = ["start", "follow", "edit"].includes(action.kind);
  const title = { start: "Record initial outreach", follow: "Record sent follow-up", edit: "Correct message", delete: "Delete mistaken message", response: "Record response", close: "Close sequence" }[action.kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      if (action.kind === "delete") {
        await onSave(`/api/tracker/messages/${action.message.id}`, "DELETE", {});
      } else {
        // Preserve the original instant when an unchanged edit falls in a repeated DST hour.
        const sentAt = original && at === initialAt ? original.sentAt : new Date(at).toISOString();
        const values = isMessage ? { text, sentAt, notes } : { action: action.kind === "response" ? "record_response" : "close", at: sentAt };
        const url = action.kind === "start" ? `/api/tracker/contacts/${contact.id}/sequences`
          : action.kind === "edit" ? `/api/tracker/messages/${action.message.id}`
          : action.kind === "follow" ? `/api/tracker/sequences/${action.sequence.id}/follow-ups`
          : `/api/tracker/sequences/${action.sequence.id}`;
        await onSave(url, action.kind === "edit" || !isMessage ? "PATCH" : "POST", values);
      }
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save outreach.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <form className="tracker-editor outreach-editor" onSubmit={submit} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{title}</h3>
    <fieldset disabled={saving}>
      {action.kind === "delete" ? <p>This removes the message from bookkeeping only. Deleting the only initial message removes its sequence.</p> : <>
        {action.kind === "start" && contact.sequences.some(sequence => sequence.closedAt === null) && <p>Starting another attempt closes the open sequence and preserves its history.</p>}
        {isMessage && <div className="control"><label htmlFor={`${id}-text`}>Message text</label>
          <textarea id={`${id}-text`} required rows={4} value={text} onChange={event => setText(event.target.value)} /></div>}
        <div className="control"><label htmlFor={`${id}-at`}>{isMessage ? "Sent at" : action.kind === "response" ? "Response received at" : "Closed at"} (local time)</label>
          <input id={`${id}-at`} type="datetime-local" step="0.001" required value={at} onChange={event => setAt(event.target.value)} /></div>
        {isMessage && <div className="control"><label htmlFor={`${id}-notes`}>Notes (optional)</label>
          <textarea id={`${id}-notes`} rows={2} value={notes} onChange={event => setNotes(event.target.value)} /></div>}
      </>}
      <div className="tracker-actions"><button type="submit" disabled={isMessage && !text.trim()}>{saving ? "Saving…" : action.kind === "delete" ? "Delete message" : "Save record"}</button>
        <button type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset>
    {saving && <p role="status">Saving record…</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}

// Keep contact actions available while showing the attempt selected in the workspace.
export default function ContactOutreach({ contact, disabled, onSave, sequenceId, action, onActionChange }: { sequenceId?: string; contact: TrackerContact; disabled: boolean; onSave: Save; action: OutreachAction | null; onActionChange: (action: OutreachAction | null) => void }) {
  const details = useRef<HTMLDetailsElement | null>(null);
  const open = contact.sequences.find(sequence => sequence.closedAt === null);
  const inlineBusy = useContext(InlineBusyContext);
  const locked = disabled || action !== null || inlineBusy;

  function begin(next: OutreachAction) {
    onActionChange(next);
  }

  function finish() {
    onActionChange(null);
    // Wait for action buttons to be enabled again after the form unmounts.
    requestAnimationFrame(() => details.current?.querySelector("button")?.focus());
  }

  if (action) return <ActionForm action={action} contact={contact} onSave={onSave} onCancel={finish} />;

  return <details ref={details} className="contact-outreach" open>
    <summary>Outreach and history · {contact.sequences.length} attempts</summary>
    <p>Record messages already sent. Dates guide follow-ups; nothing is sent automatically.</p>
    <div className="tracker-actions">
      <button id="record-outreach" disabled={locked} onClick={() => begin({ kind: "start" })}>{contact.sequences.length ? "Start another outreach" : "Record initial outreach"}</button>
      {open && <>
        <button disabled={locked} onClick={() => begin({ kind: "follow", sequence: open })}>Record follow-up {open.messages.length} of 2</button>
        <button disabled={locked} onClick={() => begin({ kind: "response", sequence: open })}>Record response</button>
        <button disabled={locked} onClick={() => begin({ kind: "close", sequence: open })}>Close sequence</button>
      </>}
    </div>
    {contact.sequences.length === 0 ? <p>No outreach recorded.</p> : [...contact.sequences].reverse().filter(sequence => !sequenceId || sequence.id === sequenceId).map(sequence => <section className="outreach-sequence" key={sequence.id} aria-label={`Outreach attempt ${contact.sequences.indexOf(sequence) + 1}`}>
      <h3>Attempt {contact.sequences.indexOf(sequence) + 1} · {sequence.closeReason ? reasons[sequence.closeReason] : "Open"}</h3>
      {sequence.closedAt && <p>Closed: <time dateTime={sequence.closedAt}>{new Date(sequence.closedAt).toLocaleString()}</time></p>}
      {sequence.respondedAt && <p>Response received: <time dateTime={sequence.respondedAt}>{new Date(sequence.respondedAt).toLocaleString()}</time></p>}
      <ol>{sequence.messages.map((message, index) => <li key={message.id}>
        <strong>{kinds[message.kind]}</strong>
        <InlineField label="message sent at (local time)" value={localTimestamp(message.sentAt)} type="datetime-local" required disabled={locked}
          onSave={value => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { sentAt: value === localTimestamp(message.sentAt) ? message.sentAt : new Date(value).toISOString() })} />
        <InlineField label="message text" value={message.text} multiline required disabled={locked}
          onSave={text => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { text })} />
        <InlineField label="message notes" value={message.notes} multiline disabled={locked} placeholder="Add message notes…"
          onSave={notes => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { notes })} />
        <div className="tracker-actions">
          <button disabled={locked || index !== sequence.messages.length - 1} title={index !== sequence.messages.length - 1 ? "Delete later messages first" : undefined} onClick={() => begin({ kind: "delete", message })}>Delete message</button>
        </div>
      </li>)}</ol>
    </section>)}
  </details>;
}
