"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ContactProgress, TrackerCompany, TrackerContact } from "@/lib/tracker";

type Contact = TrackerContact & ContactProgress;
type Company = Omit<TrackerCompany, "contacts"> & { contacts: Contact[] };
type Editor = { kind: "company"; company?: Company } | { kind: "contact"; company: Company; contact?: Contact };
type Sort = "due" | "overdue" | "recent";
const labels: Record<ContactProgress["status"], string> = {
  uncontacted: "Uncontacted", awaiting_follow_up_1: "Awaiting first follow-up",
  awaiting_follow_up_2: "Awaiting second follow-up", responded: "Responded",
  completed: "Completed", manual: "Closed manually", restarted: "Restarted",
};

// Surface API messages while retaining drafts after network or persistence failures.
async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? "Could not load or save tracker data.");
  return data;
}

// One editor handles company/contact details; saved API results remain the source of truth.
function DetailsForm({ editor, onSave, onCancel }: {
  editor: Editor;
  onSave: (url: string, method: string, values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const existing = editor.kind === "company" ? editor.company : editor.contact;
  const [name, setName] = useState(existing?.name ?? "");
  const [notes, setNotes] = useState(editor.kind === "company" ? editor.company?.notes ?? "" : "");
  const [email, setEmail] = useState(editor.kind === "contact" ? editor.contact?.email ?? "" : "");
  const [links, setLinks] = useState(editor.kind === "contact" ? editor.contact?.links.join("\n") ?? "" : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    const url = editor.kind === "company"
      ? `/api/tracker/companies${existing ? `/${existing.id}` : ""}`
      : existing ? `/api/tracker/contacts/${existing.id}` : `/api/tracker/companies/${editor.company.id}/contacts`;
    try {
      await onSave(url, existing ? "PATCH" : "POST", editor.kind === "company" ? { name, notes } : {
        name, email, links: links.split("\n").map(link => link.trim()).filter(Boolean),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save changes.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return <form className="tracker-editor" onSubmit={submit} aria-labelledby="editor-title">
    <h2 id="editor-title">{existing ? "Edit" : "Add"} {editor.kind}{editor.kind === "contact" ? ` · ${editor.company.name}` : ""}</h2>
    <fieldset disabled={saving}>
      <div className="control"><label htmlFor="tracker-name">Name</label>
        <input id="tracker-name" value={name} onChange={event => setName(event.target.value)} required autoFocus /></div>
      {editor.kind === "company" ? <div className="control"><label htmlFor="tracker-notes">Summary / notes (optional)</label>
        <textarea id="tracker-notes" rows={4} value={notes} onChange={event => setNotes(event.target.value)} /></div>
        : <>
          <div className="control"><label htmlFor="tracker-email">Email (optional)</label>
            <input id="tracker-email" type="email" value={email} onChange={event => setEmail(event.target.value)} /></div>
          <div className="control"><label htmlFor="tracker-links">Links (optional, one per line)</label>
            <textarea id="tracker-links" rows={3} value={links} onChange={event => setLinks(event.target.value)} /></div>
        </>}
      <div className="tracker-actions"><button type="submit" disabled={!name.trim()}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset>
    {saving && <p role="status">Saving changes…</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}

// Load saved companies, display derived outreach state, and merge only confirmed saves.
export default function Tracker() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [sort, setSort] = useState<Sort>("due");
  const [notice, setNotice] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await request("/api/tracker", { signal: controller.signal });
        if (!Array.isArray(data.companies)) throw new Error("Unexpected tracker response.");
        if (!controller.signal.aborted) setCompanies(data.companies);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load tracker.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  function closeEditor() {
    setEditor(null);
    addButton.current?.focus();
  }

  async function save(url: string, method: string, values: Record<string, unknown>) {
    const data = await request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    if (!data.company?.id) throw new Error("Unexpected save response. Reload before retrying.");
    setCompanies(current => current.some(company => company.id === data.companyId)
      ? current.map(company => company.id === data.companyId ? data.company : company)
      : [...current, data.company]);
    setNotice("Changes saved.");
    closeEditor();
  }

  const contactCount = companies.reduce((count, company) => count + company.contacts.length, 0);

  // Sort within each company, retaining contacts with no pending follow-up.
  function sortedContacts(company: Company) {
    const lastSent = (contact: Contact) => Math.max(0, ...contact.sequences.flatMap(sequence => sequence.messages.map(message => Date.parse(message.sentAt))));
    return [...company.contacts].sort((a, b) => {
      if (sort === "overdue" && a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      const left = sort === "recent" ? lastSent(a) : a.nextFollowUpAt ? Date.parse(a.nextFollowUpAt) : Infinity;
      const right = sort === "recent" ? lastSent(b) : b.nextFollowUpAt ? Date.parse(b.nextFollowUpAt) : Infinity;
      return (sort === "recent" ? right - left : left - right) || a.name.localeCompare(b.name);
    });
  }

  return <main className="desktop"><section className="window companies-window" aria-labelledby="tracker-title">
    <div className="title-bar"><div className="title-bar-text">Outreach Tracker</div></div>
    <div className="window-body">
      <header className="intro"><h1 id="tracker-title">Outreach Tracker</h1><p>Companies, contacts, and your outreach progress.</p></header>
      <div className="toolbar"><button ref={addButton} disabled={loading || !!error || !!editor} onClick={() => { setNotice(""); setEditor({ kind: "company" }); }}>Add company</button>
        <div className="control"><label htmlFor="tracker-sort">Sort contacts within companies by</label>
          <select id="tracker-sort" value={sort} onChange={event => setSort(event.target.value as Sort)}>
            <option value="due">Next follow-up date</option><option value="overdue">Overdue first</option><option value="recent">Most recent outreach</option>
          </select></div></div>
      <p role="status" className="tracker-notice">{notice}</p>
      {loading ? <p role="status">Loading tracker…</p> : error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : <>
        {editor?.kind === "company" && !editor.company && <DetailsForm editor={editor} onSave={save} onCancel={closeEditor} />}
        {companies.length === 0 ? <p className="message">No companies yet. Add a company to start tracking contacts.</p> : <>
          <h2>Companies</h2>
          <ul className="tracker-companies">{companies.map(company => <li key={company.id}>
            <details open>
              <summary><strong>{company.name}</strong><span> · {company.contacts.length} contacts</span></summary>
              {company.notes && <p className="tracker-notes">{company.notes}</p>}
              <div className="tracker-actions"><button disabled={!!editor} onClick={() => { setNotice(""); setEditor({ kind: "company", company }); }} aria-label={`Edit company ${company.name}`}>Edit company</button>
                <button disabled={!!editor} onClick={() => { setNotice(""); setEditor({ kind: "contact", company }); }} aria-label={`Add contact to ${company.name}`}>Add contact</button></div>
              {editor?.company?.id === company.id && <DetailsForm editor={editor} onSave={save} onCancel={closeEditor} />}
              {company.contacts.length === 0 ? <p>No contacts yet. Add a contact to {company.name}.</p> : <div className="table-scroll" role="region" aria-label={`Contacts at ${company.name}`} tabIndex={0}>
                <table><caption className="sr-only">Contacts at {company.name}, including uncontacted contacts. Dates use local time.</caption>
                  <thead><tr><th scope="col">Contact</th><th scope="col">Progress</th><th scope="col">Next follow-up (local)</th><th scope="col">Details</th></tr></thead>
                  <tbody>{sortedContacts(company).map(contact => <tr key={contact.id}>
                    <th scope="row">{contact.name}{contact.email && <div className="tracker-secondary">{contact.email}</div>}
                      {contact.links.map((link, index) => <div className="tracker-secondary" key={index}>{/^https?:\/\//i.test(link)
                        ? <a href={link} target="_blank" rel="noopener noreferrer">{link}</a> : link}</div>)}</th>
                    <td>{labels[contact.status]}</td><td>{contact.nextFollowUpAt ? <><time dateTime={contact.nextFollowUpAt}>{new Date(contact.nextFollowUpAt).toLocaleString()}</time>{contact.isOverdue && <strong className="tracker-overdue"> · Overdue</strong>}</> : "—"}</td>
                    <td><button disabled={!!editor} onClick={() => { setNotice(""); setEditor({ kind: "contact", company, contact }); }} aria-label={`Edit contact ${contact.name} at ${company.name}`}>Edit contact</button></td>
                  </tr>)}</tbody></table>
              </div>}
            </details>
          </li>)}</ul>
        </>}
      </>}
    </div><footer className="status-bar"><p className="status-bar-field">{loading ? "Loading…" : `${companies.length} companies · ${contactCount} contacts`}</p></footer>
  </section></main>;
}
