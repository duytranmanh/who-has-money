"use client";

import { formatDateTime } from "@/lib/date-time";
import InlineField, { InlineBusyContext } from "./tracker-inline-field";
import { useContext, useRef, useState } from "react";
import type { TrackerContact } from "@/lib/tracker";

type Save = (url: string, method: string, values: Record<string, unknown>) => Promise<void>;
const kinds = { initial: "Initial outreach", follow_up_1: "First follow-up", follow_up_2: "Second follow-up" };
const reasons = { responded: "Responded", completed: "Completed · two follow-ups sent", manual: "Closed manually", restarted: "Closed by a new outreach attempt" };

// datetime-local displays wall time; API writes always include an explicit UTC timezone.
function localTimestamp(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

// Message cards stay mounted through saves; failed actions retain the cards and show inline errors.
export default function ContactOutreach({ contact, disabled, onSave, onBusyChange }: {
  contact: TrackerContact; disabled: boolean; onSave: Save; onBusyChange: (busy: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const inlineBusy = useContext(InlineBusyContext);
  const locked = disabled || saving || inlineBusy;

  // Serialize button actions and keep navigation locked until persistence confirms the change.
  async function act(url: string, method: string, values: Record<string, unknown>) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    onBusyChange(true);
    setError("");
    try {
      await onSave(url, method, values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save outreach.");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return <section className="contact-outreach" aria-label="Outreach and history">
    <div className="tracker-actions">
      <button disabled={locked} onClick={() => act(`/api/tracker/contacts/${contact.id}/sequences`, "POST", { text: "", sentAt: new Date().toISOString() })}>+ New outreach</button>
    </div>
    <p>Edit messages and dates inline. Nothing is sent automatically.</p>
    {saving && <p role="status">Saving outreach…</p>}
    {error && <p role="alert">{error}</p>}
    {contact.sequences.length === 0 && <p>No outreach yet.</p>}
    {[...contact.sequences].reverse().map(sequence => {
      const canClose = sequence.closedAt === null;
      return <section className="outreach-sequence" key={sequence.id} aria-label={`Outreach attempt ${contact.sequences.indexOf(sequence) + 1}`}>
        <h3>Attempt {contact.sequences.indexOf(sequence) + 1} · {sequence.closeReason ? reasons[sequence.closeReason] : "Open"}</h3>
        {(sequence.closeReason === "responded" || sequence.closeReason === "manual") && <InlineField
          label={sequence.closeReason === "responded" ? "response received at (local time)" : "closed at (local time)"}
          value={localTimestamp(sequence.closedAt!)} type="datetime-local" required disabled={locked}
          onSave={value => onSave(`/api/tracker/sequences/${sequence.id}`, "PATCH", { action: "edit_closure", at: value === localTimestamp(sequence.closedAt!) ? sequence.closedAt : new Date(value).toISOString() })} />}
        {sequence.closedAt && sequence.closeReason !== "responded" && sequence.closeReason !== "manual" && <p>Closed: <time dateTime={sequence.closedAt}>{formatDateTime(sequence.closedAt)}</time></p>}
        <ol className="outreach-cards">{sequence.messages.map((message, index) => <li className="outreach-message" key={message.id}>
          <strong>{kinds[message.kind]}</strong>
          <InlineField label="message text" value={message.text} multiline disabled={locked} placeholder="Add message text…"
            onSave={text => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { text })} />
          <InlineField label="message sent at (local time)" value={localTimestamp(message.sentAt)} type="datetime-local" required disabled={locked}
            onSave={value => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { sentAt: value === localTimestamp(message.sentAt) ? message.sentAt : new Date(value).toISOString() })} />
          <InlineField label="message notes" value={message.notes} multiline disabled={locked} placeholder="Add notes…"
            onSave={notes => onSave(`/api/tracker/messages/${message.id}`, "PATCH", { notes })} />
          <div className="tracker-actions">
            <button disabled={locked || index !== sequence.messages.length - 1} title={index !== sequence.messages.length - 1 ? "Delete later messages first" : undefined}
              onClick={() => act(`/api/tracker/messages/${message.id}`, "DELETE", {})}>Delete message</button>
          </div>
        </li>)}</ol>
        {canClose && <div className="tracker-actions">
          <button disabled={locked} onClick={() => act(`/api/tracker/sequences/${sequence.id}/follow-ups`, "POST", { text: "", sentAt: new Date().toISOString() })}>+ Follow-up</button>
          <button disabled={locked} onClick={() => act(`/api/tracker/sequences/${sequence.id}`, "PATCH", { action: "record_response", at: new Date().toISOString() })}>Mark responded</button>
          <button disabled={locked} onClick={() => act(`/api/tracker/sequences/${sequence.id}`, "PATCH", { action: "close", at: new Date().toISOString() })}>Close attempt</button>
        </div>}
      </section>;
    })}
  </section>;
}
