"use client";

import { useEffect, useRef, useState } from "react";
import InlineField, { InlineBusyContext, InlineEditingContext } from "./tracker-inline-field";
import ContactOutreach, { type OutreachAction } from "./tracker-outreach";
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
export default function Tracker({ active }: { active: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [inlineCount, setInlineCount] = useState(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [createError, setCreateError] = useState("");
  const creatingCompanyRef = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [outreachAction, setOutreachAction] = useState<OutreachAction | null>(null);
  const [composing, setComposing] = useState(false);
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("due");
  const [notice, setNotice] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const loaded = useRef(false);
  const writes = useRef(0);
  const revision = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    async function load() {
      if (disposed || document.visibilityState !== "visible" || writes.current > 0) return;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      const version = revision.current;
      try {
        const data = await request("/api/tracker", { signal: controller.signal });
        if (!Array.isArray(data.companies)) throw new Error("Unexpected tracker response.");
        if (disposed || controller.signal.aborted || version !== revision.current) return;
        setCompanies(data.companies);
        loaded.current = true;
        setError("");
        setRefreshError("");
      } catch (cause) {
        if (!disposed && !controller.signal.aborted && version === revision.current) {
          const message = cause instanceof Error ? cause.message : "Could not load tracker.";
          if (loaded.current) setRefreshError(message);
          else setError(message);
        }
      } finally {
        if (!disposed && !controller.signal.aborted) setLoading(false);
      }
    }
    // Background refreshes retain mounted forms, even when a refresh fails.
    void load();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      disposed = true;
      refreshController.current?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(interval);
    };
  }, [active, attempt]);

  function closeEditor() {
    setEditor(null);
    addButton.current?.focus();
  }

  async function persist(url: string, method: string, values: Record<string, unknown>) {
    // Invalidate overlapping reads both before and after persistence.
    writes.current += 1;
    revision.current += 1;
    refreshController.current?.abort();
    try {
      const data = await request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      if (!data.company?.id) throw new Error("Unexpected save response. Reload before retrying.");
      setCompanies(current => current.some(company => company.id === data.companyId)
        ? current.map(company => company.id === data.companyId ? data.company : company)
        : [...current, data.company]);
      if (method === "POST" && url === "/api/tracker/companies") setSelectedId(data.company.id);
      setNotice("Changes saved.");
      if (editor) closeEditor();
    } finally {
      writes.current -= 1;
      revision.current += 1;
    }
  }

  // Apply full-company responses in write order so rapid field saves cannot roll back the UI.
  function save(url: string, method: string, values: Record<string, unknown>) {
    const operation = writeQueue.current.then(() => persist(url, method, values));
    writeQueue.current = operation.catch(() => {});
    return operation;
  }

  // Create a saved placeholder so the normal workspace owns all subsequent edits.
  async function addCompany() {
    if (creatingCompanyRef.current) return;
    creatingCompanyRef.current = true;
    setCreatingCompany(true);
    setCreateError("");
    setNotice("");
    try {
      await save("/api/tracker/companies", "POST", { name: "Untitled company", notes: "" });
      setQuery("");
      setContactId(null);
      setSequenceId(null);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create company.");
    } finally {
      creatingCompanyRef.current = false;
      setCreatingCompany(false);
    }
  }

  const navigationLocked = creatingCompany || !!editor || composing || !!outreachAction || inlineCount > 0;

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

  const selected = companies.find(company => company.id === selectedId);
  const contacts = selected ? sortedContacts(selected) : [];
  const contact = contacts.find(person => person.id === contactId);
  const touchpoints = contacts.flatMap(person => person.sequences.map((sequence, index) => ({ person, sequence, index })));
  const selectedTouchpoint = touchpoints.find(item => item.sequence.id === sequenceId && item.person.id === contact?.id);
  const links = [...new Set(contacts.flatMap(person => person.links))];
  const visible = companies.filter(company => `${company.name} ${company.notes} ${company.contacts.map(person => person.name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <InlineEditingContext.Provider value={setInlineCount}><InlineBusyContext.Provider value={inlineCount > 0}><main className="tracker-desktop">
    <section className="tracker-panel applications-panel" aria-labelledby="tracker-title">
      <div className="workspace-title" id="tracker-title">📁 Applications</div>
      <div className="workspace-strip"><strong>All ({companies.length})</strong>
        <button ref={addButton} disabled={loading || !!error || navigationLocked} onClick={addCompany}>{creatingCompany ? "Creating…" : "+ New"}</button></div>
      {createError && <p role="alert" className="workspace-alert">{createError}</p>}
      <div className="application-search"><label className="sr-only" htmlFor="tracker-search">Search applications</label>
        <input id="tracker-search" type="search" disabled={inlineCount > 0} placeholder="Search targets or contacts…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="application-list">
        {loading ? <p role="status">Loading tracker…</p> : error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : <>
          {visible.map(company => <button key={company.id} className={`application-row ${selected?.id === company.id ? "is-selected" : ""}`}
            disabled={navigationLocked} aria-pressed={selected?.id === company.id} onClick={() => { setSelectedId(company.id); setContactId(null); setSequenceId(null); setNotice(""); }}>
            <strong>{selected?.id === company.id && <span className="selection-marker">▸ </span>}{company.name}</strong>
            <span className={company.contacts.some(person => person.status === "responded") ? "workspace-badge" : "application-meta"}>
              {company.contacts.some(person => person.status === "responded") ? "Responded" : company.contacts.some(person => person.isOverdue) ? "Follow-up due" : `${company.contacts.length} contacts`}</span>
          </button>)}
          {!visible.length && <p className="workspace-empty">{companies.length ? "No matching applications." : "Add a company to start tracking outreach."}</p>}
        </>}
      </div>
      <footer className="workspace-footer">{companies.length} companies · {contactCount} contacts</footer>
    </section>

    <section className="tracker-panel company-panel" aria-label="Company workspace">
      <div className="workspace-title">💼 {editor?.kind === "company" ? "New Company" : selected ? `${selected.name} — Company Workspace` : "Company Workspace"}</div>
      {editor?.kind === "company" && <DetailsForm key={`company-${editor.company?.id ?? "new"}`} editor={editor} onSave={save} onCancel={closeEditor} />}
      {refreshError && <div role="alert" className="workspace-alert"><p>Could not refresh: {refreshError} Showing previously loaded data.</p><button onClick={() => setAttempt(value => value + 1)}>Retry refresh</button></div>}
      <div role="status" className={notice ? "workspace-notice" : "sr-only"}>{notice}</div>
      {selected && editor?.kind !== "company" ? <>
        <header className="company-heading"><div className="company-heading-row"><h1><InlineField key={selected.id} label="company name" value={selected.name} required disabled={creatingCompany || !!editor || composing || !!outreachAction} onSave={name => save(`/api/tracker/companies/${selected.id}`, "PATCH", { name })} /></h1></div>
          <div className="company-links"><strong>LINKS:</strong>{links.filter(link => /^https?:\/\//i.test(link)).map(link => <a key={link} href={link} target="_blank" rel="noopener noreferrer">{link.replace(/^https?:\/\//i, "").replace(/\/$/, "")} ↗</a>)}
            {!links.length && <span>Add links through a contact.</span>}</div>
        </header>
        <section className="company-intel" aria-labelledby="intel-title"><div className="workspace-strip"><strong id="intel-title">📝 NOTES &amp; INTEL</strong><span>Company research &amp; preparation</span></div>
          <div className="intel-body"><InlineField key={selected.id} label="company notes" value={selected.notes} multiline disabled={creatingCompany || !!editor || composing || !!outreachAction} placeholder="Add company research, notes, and interview preparation…" onSave={notes => save(`/api/tracker/companies/${selected.id}`, "PATCH", { notes })} /></div></section>
        <section className="touchpoint-history" aria-labelledby="history-title"><div className="workspace-strip"><div><strong id="history-title">OUTREACH HISTORY &amp; TOUCHPOINTS</strong> <span className="logged-count">{touchpoints.length} logged</span></div>
          <button disabled={!contacts.length || navigationLocked} onClick={() => { setContactId(null); setComposing(true); setNotice(""); }}>+ Log outreach</button></div>
          <div className="history-body"><div className="history-sort"><label htmlFor="tracker-sort">Sort contacts</label><select id="tracker-sort" disabled={inlineCount > 0} value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="due">Next follow-up</option><option value="overdue">Overdue first</option><option value="recent">Recent outreach</option></select></div>
            {touchpoints.map(({ person, sequence, index }) => <button key={sequence.id} disabled={navigationLocked} className={`touchpoint-row ${selectedTouchpoint?.sequence.id === sequence.id ? "is-selected" : ""}`} aria-pressed={selectedTouchpoint?.sequence.id === sequence.id}
              onClick={() => { setContactId(person.id); setSequenceId(sequence.id); }}>
              <span className="selection-marker">{selectedTouchpoint?.sequence.id === sequence.id ? "▸" : "▹"}</span>
              <span className="touchpoint-copy"><strong>Attempt {index + 1} · {person.name}</strong><span className="touchpoint-preview">{sequence.messages[0]?.text}</span></span>
              <span className="touchpoint-meta"><span className={sequence.closeReason === "responded" ? "workspace-badge" : ""}>{sequence.closeReason ? labels[sequence.closeReason] : "Awaiting follow-up"}</span><time>{sequence.messages[0] && new Date(sequence.messages[0].sentAt).toLocaleString()}</time></span>
            </button>)}
            {!touchpoints.length && <p className="workspace-empty">No outreach recorded. Add a contact, then record your first message.</p>}
          </div>
        </section>
      </> : !editor && <p className="workspace-empty">Select or create a company to open its workspace.</p>}
    </section>

    <aside className="tracker-panel inspector-panel" id="outreach-inspector" aria-label="Outreach inspector">
      <div className="workspace-title">🔍 {composing ? "New Outreach" : selectedTouchpoint ? "Outreach Detail" : "Company Overview"}</div>
      {selected && editor?.kind !== "company" && <div className="inspector-body">
        {editor?.kind === "contact" ? <DetailsForm key={`contact-${editor.company.id}`} editor={editor} onSave={save} onCancel={closeEditor} />
          : composing ? <section className="inspector-card"><h2>NEW OUTREACH</h2>
            {contact ? <ContactOutreach key={`new-${contact.id}`} contact={contact} disabled={false} onSave={save}
              action={outreachAction} onActionChange={action => { setOutreachAction(action); if (!action) setComposing(false); }} />
              : <><p>Choose a contact for this outreach.</p><div className="tracker-actions">
                {contacts.map(person => <button key={person.id} onClick={() => { setContactId(person.id); setOutreachAction({ kind: "start" }); }}>{person.name}</button>)}
                <button onClick={() => setComposing(false)}>Cancel</button>
              </div></>}
          </section>
          : selectedTouchpoint && contact ? <section className="inspector-card">
            <div className="tracker-actions"><button disabled={navigationLocked} onClick={() => { setSequenceId(null); setContactId(null); }}>Back to overview</button></div>
            <h2>Attempt {selectedTouchpoint.index + 1} · {contact.name}</h2>
            {contact.nextFollowUpAt && <p className={contact.isOverdue ? "tracker-overdue" : "workspace-muted"}>Next follow-up: {new Date(contact.nextFollowUpAt).toLocaleString()}{contact.isOverdue ? " · Overdue" : ""}</p>}
            <ContactOutreach key={selectedTouchpoint.sequence.id} contact={contact} sequenceId={selectedTouchpoint.sequence.id} disabled={false} onSave={save}
              action={outreachAction} onActionChange={setOutreachAction} />
          </section>
          : <section className="inspector-card"><h2>{selected.name} · OVERVIEW</h2>
            <p>{contacts.length} contacts · {touchpoints.length} outreach attempts</p>
            <p>{contacts.filter(person => person.status === "responded").length} responded · {contacts.filter(person => person.isOverdue).length} overdue</p>
            <p>Select an outreach attempt to view its details.</p>
          </section>}
        {!editor && !composing && !selectedTouchpoint && <>
        <section className="inspector-card"><div className="contacts-heading"><h2>ASSOCIATED CONTACTS</h2><button disabled={!selected || navigationLocked} onClick={() => selected && setEditor({ kind: "contact", company: selected })}>+ Add</button></div>
          {contacts.map(person => <article className="inspector-contact" key={person.id}>
            <InlineField label={`contact name for ${person.name}`} value={person.name} required disabled={creatingCompany || !!editor || composing || !!outreachAction} onSave={name => save(`/api/tracker/contacts/${person.id}`, "PATCH", { name })} />
            <InlineField label={`email for ${person.name}`} value={person.email} type="email" disabled={creatingCompany || !!editor || composing || !!outreachAction} placeholder="Add email…" onSave={email => save(`/api/tracker/contacts/${person.id}`, "PATCH", { email })} />
            <InlineField label={`links for ${person.name}`} value={person.links.join("\n")} multiline disabled={creatingCompany || !!editor || composing || !!outreachAction} placeholder="Add links, one per line…" onSave={value => save(`/api/tracker/contacts/${person.id}`, "PATCH", { links: value.split("\n").map(link => link.trim()).filter(Boolean) })} />
            <div className="contact-link-list">{person.links.filter(link => /^https?:\/\//i.test(link)).map((link, index) => <a key={index} href={link} target="_blank" rel="noopener noreferrer">Open link {index + 1} ↗</a>)}</div>
            <div className="contact-footer"><span>{labels[person.status]}</span><button disabled={navigationLocked} aria-pressed={contact?.id === person.id} onClick={() => { setContactId(person.id); setSequenceId(null); setComposing(true); setOutreachAction({ kind: "start" }); }}>Log outreach</button></div>
          </article>)}
          {!contacts.length && <p className="workspace-muted">No contacts yet.</p>}
        </section>
        </>}
      </div>}
    </aside>
  </main></InlineBusyContext.Provider></InlineEditingContext.Provider>;
}
