"use client";

import { formatDateTime } from "@/lib/date-time";
import { useEffect, useRef, useState } from "react";
import InlineField, { InlineBusyContext, InlineEditingContext } from "./tracker-inline-field";
import ContactOutreach from "./tracker-outreach";
import type { ContactProgress, TrackerCompany, TrackerContact } from "@/lib/tracker";

type Contact = TrackerContact & ContactProgress;
type Company = Omit<TrackerCompany, "contacts"> & { contacts: Contact[] };
type CompanySummary = Omit<Company, "contacts"> & { contacts: Pick<Contact, "id" | "name" | "status" | "isOverdue">[] };
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

// Load saved companies, display derived outreach state, and merge only confirmed saves.
export default function Tracker({ active }: { active: boolean }) {
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companyDetails, setCompanyDetails] = useState<Company | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [inlineCount, setInlineCount] = useState(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [createError, setCreateError] = useState("");
  const creatingCompanyRef = useRef(false);
  const [creatingContact, setCreatingContact] = useState(false);
  const [contactError, setContactError] = useState("");
  const creatingContactRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [outreachBusy, setOutreachBusy] = useState(false);
  const [query, setQuery] = useState("");
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
        const data = await request("/api/tracker/companies", { signal: controller.signal });
        if (!Array.isArray(data.companies)) throw new Error("Unexpected tracker response.");
        if (disposed || controller.signal.aborted || version !== revision.current) return;
        setCompanies(data.companies);
        loaded.current = true;
        if (selectedId) {
          setDetailLoading(true);
          const details = await request(`/api/tracker/companies/${selectedId}`, { signal: controller.signal });
          if (disposed || controller.signal.aborted || version !== revision.current) return;
          if (details.company?.id !== selectedId) throw new Error("Unexpected company response.");
          setCompanyDetails(details.company);
        }
        setError("");
        setRefreshError("");
      } catch (cause) {
        if (!disposed && !controller.signal.aborted && version === revision.current) {
          const message = cause instanceof Error ? cause.message : "Could not load tracker.";
          if (loaded.current) setRefreshError(message);
          else setError(message);
        }
      } finally {
        if (!disposed && !controller.signal.aborted) {
          setLoading(false);
          setDetailLoading(false);
        }
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
  }, [active, attempt, selectedId]);

  async function persist(url: string, method: string, values: Record<string, unknown>) {
    // Invalidate overlapping reads both before and after persistence.
    writes.current += 1;
    revision.current += 1;
    refreshController.current?.abort();
    try {
      const data = await request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      if (!data.company?.id) throw new Error("Unexpected save response. Reload before retrying.");
      const summary: CompanySummary = { id: data.company.id, name: data.company.name, notes: data.company.notes,
        contacts: data.company.contacts.map((person: Contact) => ({ id: person.id, name: person.name, status: person.status, isOverdue: person.isOverdue })) };
      setCompanies(current => current.some(company => company.id === data.companyId)
        ? current.map(company => company.id === data.companyId ? summary : company)
        : [...current, summary]);
      setCompanyDetails(data.company);
      if (method === "POST" && url === "/api/tracker/companies") setSelectedId(data.company.id);
      setNotice("Changes saved.");
      if (method === "POST" && url === `/api/tracker/companies/${data.company.id}/contacts`) {
        setContactId(data.company.contacts.at(-1)?.id ?? null);
      }
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
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create company.");
    } finally {
      creatingCompanyRef.current = false;
      setCreatingCompany(false);
    }
  }

  // Select the appended contact only after persistence confirms its stable ID.
  async function addContact() {
    if (!selectedId || creatingContactRef.current) return;
    creatingContactRef.current = true;
    setCreatingContact(true);
    setContactError("");
    setNotice("");
    try {
      await save(`/api/tracker/companies/${selectedId}/contacts`, "POST", { name: "Untitled contact", email: "", links: [] });
    } catch (cause) {
      setContactError(cause instanceof Error ? cause.message : "Could not create contact.");
    } finally {
      creatingContactRef.current = false;
      setCreatingContact(false);
    }
  }

  const detailsLocked = creatingCompany || creatingContact || outreachBusy;
  const navigationLocked = detailsLocked || inlineCount > 0;

  const contactCount = companies.reduce((count, company) => count + company.contacts.length, 0);

  // Sort within each company, retaining contacts with no pending follow-up.
  function sortedContacts(company: Company) {
    return [...company.contacts].sort((a, b) => {
      const left = a.nextFollowUpAt ? Date.parse(a.nextFollowUpAt) : Infinity;
      const right = b.nextFollowUpAt ? Date.parse(b.nextFollowUpAt) : Infinity;
      return left - right || a.name.localeCompare(b.name);
    });
  }

  const selected = companyDetails?.id === selectedId ? companyDetails : undefined;
  const contacts = selected ? sortedContacts(selected) : [];
  const contact = contacts.find(person => person.id === contactId);
  const outreachCount = contacts.reduce((count, person) => count + person.sequences.length, 0);
  const links = [...new Set(contacts.flatMap(person => person.links))];
  const visible = companies.filter(company => `${company.name} ${company.notes} ${company.contacts.map(person => person.name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <InlineEditingContext.Provider value={setInlineCount}><InlineBusyContext.Provider value={inlineCount > 0}><main className="tracker-desktop">
    <section className="window tracker-panel applications-panel" aria-labelledby="tracker-title">
      <div className="title-bar workspace-title" id="tracker-title"><div className="title-bar-text">📁 Applications</div></div>
      <div className="workspace-strip"><strong>All ({companies.length})</strong>
        <button ref={addButton} disabled={loading || !!error || navigationLocked} onClick={addCompany}>{creatingCompany ? "Creating…" : "+ New"}</button></div>
      {createError && <p role="alert" className="workspace-alert">{createError}</p>}
      <div className="application-search"><label className="sr-only" htmlFor="tracker-search">Search applications</label>
        <input id="tracker-search" type="search" disabled={inlineCount > 0} placeholder="Search targets or contacts…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="application-list">
        {loading ? <p role="status">Loading tracker…</p> : error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : <>
          {visible.map(company => <button key={company.id} className={`application-row ${selectedId === company.id ? "is-selected" : ""}`}
            disabled={navigationLocked} aria-pressed={selectedId === company.id} onClick={() => { setSelectedId(company.id); setContactId(null); setContactError(""); setNotice(""); }}>
            <strong>{selectedId === company.id && <span className="selection-marker">▸ </span>}{company.name}</strong>
            <span className={company.contacts.some(person => person.status === "responded") ? "workspace-badge" : "application-meta"}>
              {company.contacts.some(person => person.status === "responded") ? "Responded" : company.contacts.some(person => person.isOverdue) ? "Follow-up due" : `${company.contacts.length} contacts`}</span>
          </button>)}
          {!visible.length && <p className="workspace-empty">{companies.length ? "No matching applications." : "Add a company to start tracking outreach."}</p>}
        </>}
      </div>
      <footer className="workspace-footer">{companies.length} companies · {contactCount} contacts</footer>
    </section>

    <div className="tracker-middle">
    <section className="window tracker-panel company-panel" aria-label="Company workspace">
      <div className="title-bar workspace-title"><div className="title-bar-text">💼 {selected ? `${selected.name} — Company Workspace` : "Company Workspace"}</div></div>
      {refreshError && <div role="alert" className="workspace-alert"><p>Could not refresh: {refreshError} Showing previously loaded data.</p><button onClick={() => setAttempt(value => value + 1)}>Retry refresh</button></div>}
      <div role="status" className={notice ? "workspace-notice" : "sr-only"}>{notice}</div>
      {selected ? <>
        <header className="company-heading"><div className="company-heading-row"><h1><InlineField key={selected.id} label="company name" value={selected.name} required disabled={detailsLocked} onSave={name => save(`/api/tracker/companies/${selected.id}`, "PATCH", { name })} /></h1></div>
          <div className="company-links"><strong>LINKS:</strong>{links.filter(link => /^https?:\/\//i.test(link)).map(link => <a key={link} href={link} target="_blank" rel="noopener noreferrer">{link.replace(/^https?:\/\//i, "").replace(/\/$/, "")} ↗</a>)}
            {!links.length && <span>Add links through a contact.</span>}</div>
        </header>
        <section className="company-intel" aria-labelledby="intel-title"><div className="workspace-strip"><strong id="intel-title">📝 NOTES &amp; INTEL</strong><span>Company research &amp; preparation</span></div>
          <div className="intel-body"><InlineField key={selected.id} label="company notes" value={selected.notes} multiline disabled={detailsLocked} placeholder="Add company research, notes, and interview preparation…" onSave={notes => save(`/api/tracker/companies/${selected.id}`, "PATCH", { notes })} /></div></section>
      </> : <p className="workspace-empty">{detailLoading ? "Loading company…" : "Select or create a company to open its workspace."}</p>}
    </section>

    <section className="window tracker-panel contacts-panel" aria-labelledby="contacts-window-title">
      <div className="title-bar workspace-title" id="contacts-window-title"><div className="title-bar-text">👥 Contacts</div></div>
      {selected ? <><div className="workspace-strip"><div><strong id="contacts-title">CONTACTS</strong> <span className="logged-count">{contacts.length} contacts</span></div>
          <button disabled={navigationLocked} onClick={addContact}>{creatingContact ? "Creating…" : "+ Add contact"}</button></div>
          {contactError && <p role="alert" className="workspace-alert">{contactError}</p>}
          <div className="history-body">
            {contacts.map(person => <button key={person.id} disabled={navigationLocked} className={`touchpoint-row ${contact?.id === person.id ? "is-selected" : ""}`} aria-pressed={contact?.id === person.id}
              onClick={() => { setContactId(person.id); setNotice(""); }}>
              <span className="selection-marker">{contact?.id === person.id ? "▸" : "▹"}</span>
              <span className="touchpoint-copy"><strong>{person.name}</strong><span className="touchpoint-preview">{person.email || "No email added"}</span></span>
              <span className="touchpoint-meta"><span>{labels[person.status]}</span>
                {person.nextFollowUpAt && <time dateTime={person.nextFollowUpAt}>Next: {formatDateTime(person.nextFollowUpAt)}{person.isOverdue ? " · Overdue" : ""}</time>}
              </span>
            </button>)}
            {!contacts.length && <p className="workspace-empty">No contacts yet. Add a contact to start tracking outreach.</p>}
          </div>
      </> : <p className="workspace-empty">Select a company to view its contacts.</p>}
    </section>
    </div>

    <aside className="window tracker-panel inspector-panel" id="outreach-inspector" aria-label="Contact details and outreach">
      <div className="title-bar workspace-title"><div className="title-bar-text">🔍 {contact ? "Contact Details & Outreach" : "Company Overview"}</div></div>
      {selected && <div className="inspector-body">
        {contact ? <>
          <section className="inspector-card" key={contact.id}>
            <h2>CONTACT DETAILS</h2>
            <article className="inspector-contact">
              <InlineField label="contact name" value={contact.name} required disabled={detailsLocked} onSave={name => save(`/api/tracker/contacts/${contact.id}`, "PATCH", { name })} />
              <InlineField label="contact email" value={contact.email} type="email" disabled={detailsLocked} placeholder="Add email…" onSave={email => save(`/api/tracker/contacts/${contact.id}`, "PATCH", { email })} />
              <InlineField label="contact links" value={contact.links.join("\n")} multiline disabled={detailsLocked} placeholder="Add links, one per line…" onSave={value => save(`/api/tracker/contacts/${contact.id}`, "PATCH", { links: value.split("\n").map(link => link.trim()).filter(Boolean) })} />
              <div className="contact-link-list">{contact.links.filter(link => /^https?:\/\//i.test(link)).map((link, index) => <a key={index} href={link} target="_blank" rel="noopener noreferrer">Open link {index + 1} ↗</a>)}</div>
              <p>{labels[contact.status]}</p>
              {contact.nextFollowUpAt && <p className={contact.isOverdue ? "tracker-overdue" : "workspace-muted"}>Next follow-up: {formatDateTime(contact.nextFollowUpAt)}{contact.isOverdue ? " · Overdue" : ""}</p>}
            </article>
          </section>
          <section className="inspector-card">
            <ContactOutreach key={contact.id} contact={contact} disabled={creatingCompany || creatingContact} onSave={save}
              onBusyChange={setOutreachBusy} />
          </section>
        </> : <section className="inspector-card"><h2>{selected.name} · OVERVIEW</h2>
          <p>{contacts.length} contacts · {outreachCount} outreach attempts</p>
          <p>{contacts.filter(person => person.status === "responded").length} responded · {contacts.filter(person => person.isOverdue).length} overdue</p>
          <p>Select a contact to view its details and outreach history.</p>
        </section>}
      </div>}
    </aside>
  </main></InlineBusyContext.Provider></InlineEditingContext.Provider>;
}
