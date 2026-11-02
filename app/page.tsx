"use client";

import { formatDateTime } from "@/lib/date-time";
import { Fragment, useEffect, useRef, useState } from "react";
import Tracker from "./tracker";

type Company = {
  slug: string;
  name: string;
  amount: number | null;
  stage: string | null;
  date: number | null;
  website: string | null;
  industry: string;
  sector: string;
  location: string;
  description: string;
  investors: string[];
  source: string | null;
};
type SnapshotInfo = { fetchedAt: string; windowStart: string; windowEnd: string; coverage: "complete" };
type Sort = "date" | "amount" | "name";

// Accept only web links from upstream data before rendering clickable URLs.
function webLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Normalize optional upstream fields so missing or malformed values stay displayable.
function parseCompany(value: unknown): Company {
  if (!value || typeof value !== "object") throw new Error("Invalid company data.");
  const row = value as Record<string, unknown>;
  if (typeof row.slug !== "string" || typeof row.name !== "string") {
    throw new Error("Invalid company data.");
  }
  const amount = typeof row.amount_usd === "number" ||
    (typeof row.amount_usd === "string" && row.amount_usd.trim() !== "")
    ? Number(row.amount_usd) : NaN;
  const date = typeof row.announced_at === "string" ? Date.parse(row.announced_at) : NaN;
  return {
    slug: row.slug,
    name: row.name,
    amount: Number.isFinite(amount) && amount >= 0 ? amount : null,
    stage: typeof row.stage === "string" && row.stage !== "unknown" ? row.stage : null,
    date: Number.isFinite(date) ? date : null,
    website: webLink(row.website),
    industry: typeof row.industry === "string" ? row.industry : "",
    sector: typeof row.sector === "string" ? row.sector : "",
    location: [row.hq_city, row.hq_country].filter(value => typeof value === "string" && value.trim()).join(", "),
    description: typeof row.description === "string" ? row.description : "",
    investors: Array.isArray(row.investors) ? row.investors.filter((value): value is string => typeof value === "string") : [],
    source: webLink(row.raise_source_url),
  };
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});

const dateLabel = (value: number) => new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
}).format(value);
const label = (value: string) => value.replaceAll("-", " ").replaceAll("_", " ");

// Native dialog provides focus containment, Escape dismissal, and focus return to the opener.
function CompanyDetails({ company, onClose }: { company: Company; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="window company-dialog" aria-labelledby="details-title"
    onClose={event => {
      // Effect replay can reopen the dialog before its queued close event arrives.
      if (!event.currentTarget.open) onClose();
    }} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="title-bar">
      <div className="title-bar-text">Company Details — {company.name}</div>
      <div className="title-bar-controls"><button aria-label="Close company details" onClick={() => dialog.current?.close()} /></div>
    </div>
    <div className="company-dialog-body">
      <header className="details-header">
        <div><h2 id="details-title">{company.name}</h2><span className="stage-badge" data-stage={company.stage}>{company.stage ? label(company.stage) : "Undisclosed stage"}</span>
          <p>{label(company.industry) || "Unknown industry"} · {company.location || "Unknown location"}</p>
          <p>Announced {company.date === null ? "—" : dateLabel(company.date)}</p></div>
        <div className="round-size"><span>Round size</span><strong>{company.amount === null ? "Undisclosed" : money.format(company.amount)}</strong></div>
      </header>
      <section className="details-card"><h3>About the company</h3><p>{company.description || "No description available."}</p>
        {company.sector && <p><strong>Sector:</strong> {company.sector}</p>}</section>
      <section className="details-card"><h3>Investors & backers</h3>
        {company.investors.length ? <ul className="investor-list">{company.investors.map((investor, index) => <li key={index}>{investor}</li>)}</ul> : <p>No investors disclosed.</p>}</section>
      <footer className="details-actions">
        {company.website && <a href={company.website} target="_blank" rel="noopener noreferrer">Company website ↗</a>}
        {company.source && <a href={company.source} target="_blank" rel="noopener noreferrer">Funding source ↗</a>}
        <button onClick={() => dialog.current?.close()}>Close</button>
      </footer>
    </div>
  </dialog>;
}

// Browse the latest complete saved funding window; refreshes are explicitly user initiated.
function Discovery() {
  // 1. Read and normalize the saved snapshot through the server.
  // 2. Filter and sort locally, keeping unavailable values last.
  // 3. Render the table and accessible request status.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [notice, setNotice] = useState("");
  const [snapshot, setSnapshot] = useState<SnapshotInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const [industry, setIndustry] = useState("");
  const [stage, setStage] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("date");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/companies", { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Could not load companies.");
        }
        if (!Array.isArray(data?.companies)) throw new Error("Unexpected company response.");
        const rows = data.companies.map(parseCompany);
        if (controller.signal.aborted) return;
        setCompanies(rows);
        setSnapshot(data.snapshot ?? null);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load companies.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  // Keep displayed data while collection runs; reload only the selected complete snapshot afterward.
  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setNotice("");
    try {
      const response = await fetch("/api/companies/refresh", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? data.message ?? "Could not refresh funding data.");
      const cooldown = data.nextAllowedAttemptAt ? ` Next allowed attempt: ${formatDateTime(Date.parse(data.nextAllowedAttemptAt), "UTC")} UTC.` : "";
      setNotice((data.message ?? "Refresh finished.") + cooldown);
      setAttempt(value => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not refresh funding data.");
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }

  const visible = companies
    .filter(company => (!industry || company.industry === industry) && (!stage || (company.stage ?? "unknown") === stage))
    .filter(company => [company.name, company.industry, company.sector, ...company.investors]
      .join(" ").toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      const left = a[sort];
      const right = b[sort];
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return right - left || a.name.localeCompare(b.name);
    });

  const latestDate = visible.find(company => company.date !== null)?.date;
  const latestDay = latestDate == null ? null : new Date(latestDate).toISOString().slice(0, 10);
  const groups = new Map<string, Company[]>();
  for (const company of visible) {
    const day = company.date === null ? null : new Date(company.date).toISOString().slice(0, 10);
    const key = sort === "date" ? (day !== null && day === latestDay ? "latest" : "previous") : "all";
    groups.set(key, [...(groups.get(key) ?? []), company]);
  }
  const industries = [...new Set(companies.map(company => company.industry).filter(Boolean))].sort();
  const stages = [...new Set(companies.map(company => company.stage ?? "unknown"))].sort();

  return (
    <main className="desktop">
      <section className="window companies-window" aria-labelledby="app-title">
        <div className="title-bar"><h1 id="app-title" className="title-bar-text">Who Has Money?</h1></div>
        <div className="window-body">
          <div className="toolbar">
            <div className="control search-control">
              <label className="sr-only" htmlFor="company-search">Search loaded companies</label>
              <input id="company-search" type="search" placeholder="Name, sector, backer…" value={query}
                onChange={(event) => setQuery(event.target.value)} disabled={loading || !!error} />
            </div>
            <div className="control"><label className="sr-only" htmlFor="industry-filter">Industry</label>
              <select id="industry-filter" value={industry} onChange={event => setIndustry(event.target.value)}>
                <option value="">All industries</option>{industries.map(value => <option key={value} value={value}>{label(value)}</option>)}
              </select></div>
            <div className="control"><label className="sr-only" htmlFor="stage-filter">Stage</label>
              <select id="stage-filter" value={stage} onChange={event => setStage(event.target.value)}>
                <option value="">All stages</option>{stages.map(value => <option key={value} value={value}>{label(value)}</option>)}
              </select></div>
            <div className="control">
              <label className="sr-only" htmlFor="company-sort">Sort by</label>
              <select id="company-sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="date">Sort: Newest funding</option>
                <option value="amount">Sort: Largest amount</option>
                <option value="name">Sort: Company name</option>
              </select>
            </div>
            <button onClick={refresh} disabled={loading || refreshing}>{refreshing ? "Refreshing…" : "⟳ Refresh data"}</button>
          </div>
          <div className="discovery-meta">
            <span>{loading ? "Loading…" : error ? "Could not load companies" : `${visible.length} of ${companies.length} companies`}</span>
            {snapshot && <details className="snapshot-details">
              <summary>Updated {formatDateTime(Date.parse(snapshot.fetchedAt), "UTC")} UTC</summary>
              <div>Coverage: {snapshot.coverage}<br />
                Funding window: {snapshot.windowStart.slice(0, 10)} to {snapshot.windowEnd.slice(0, 10)} (end exclusive, UTC)
                {snapshot.fetchedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10) && <><br />Older saved data</>}
              </div>
            </details>}
            <span className="discovery-notice" role="status" aria-live="polite">{refreshing ? "Collecting funding data…" : notice}</span>
          </div>
          {loading ? <p className="message" role="status">Loading companies…</p>
            : error ? <div className="message" role="alert"><p>{error}</p>
              <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
            : <>
              <div className="table-scroll" role="region" aria-label="Companies table" tabIndex={0}>
                <table>
                  <caption className="sr-only">Recently funded companies, amounts in US dollars. Missing values shown as a dash.</caption>
                  <thead><tr><th scope="col">Company</th><th scope="col">Category / sector</th>
                    <th scope="col">Stage</th><th scope="col">HQ / location</th><th scope="col">Announced</th></tr></thead>
                  <tbody>{[...groups].map(([key, rows]) => <Fragment key={key}>
                    {key !== "all" && <tr className="date-group"><th colSpan={5} scope="rowgroup">
                      <button aria-expanded={!collapsed.has(key)} onClick={() => setCollapsed(current => {
                        const next = new Set(current);
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      })}><span aria-hidden="true">{collapsed.has(key) ? "▶" : "▼"}</span> {key === "latest" ? `Latest rounds — ${dateLabel(rows[0].date!)}` : "Previous rounds"}
                        <span className="group-count"> · {rows.length} {rows.length === 1 ? "company" : "companies"} announced</span></button>
                    </th></tr>}
                    {(key === "all" || !collapsed.has(key)) && rows.map(company => <tr key={company.slug} className="company-row" onClick={() => setSelected(company)}>
                      <th scope="row"><button className="company-name" aria-label={`View details for ${company.name}`} onClick={event => { event.stopPropagation(); setSelected(company); }}>
                        <span className="company-initial" aria-hidden="true">{company.name.slice(0, 1)}</span>{company.name}</button></th>
                      <td className="industry-label">{label(company.industry) || company.sector || "—"}</td>
                      <td><span className="stage-badge" data-stage={company.stage}>{company.stage ? label(company.stage) : "—"}</span></td>
                      <td>{company.location || "—"}</td>
                      <td>{company.date === null ? "—" : dateLabel(company.date)}</td>
                    </tr>)}
                  </Fragment>)}</tbody>
                </table>
              </div>
              {visible.length === 0 && <div className="message" role="status">
                <p>{companies.length ? "No companies match your filters." : (snapshot ? "No matching companies in this funding window." : "No saved data. Click Refresh funding data to collect companies.")}</p>
                {(query || industry || stage) && <button onClick={() => { setQuery(""); setIndustry(""); setStage(""); }}>Clear filters</button>}
              </div>}
            </>}
        </div>
        <footer className="status-bar" aria-live="polite" aria-atomic="true">
          <p className="status-bar-field">Source: RecentFunding · US and unknown locations · 14-day Free-plan delay</p>
        </footer>
      </section>
      {selected && <CompanyDetails company={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

// Keep visited panels mounted so switching tabs preserves searches and unsaved drafts.
export default function Home() {
  const [tab, setTab] = useState<"discovery" | "tracker">("discovery");
  const [trackerVisited, setTrackerVisited] = useState(false);
  return <div className="app-shell">
    <nav className="app-navigation" aria-label="Application sections">
      <button aria-pressed={tab === "discovery"} onClick={() => setTab("discovery")}>Discovery</button>
      <button aria-pressed={tab === "tracker"} onClick={() => { setTrackerVisited(true); setTab("tracker"); }}>✦ Tracker Workspace <span className="navigation-live">LIVE</span></button>
    </nav>
    <div className="discovery-panel" hidden={tab !== "discovery"}><Discovery /></div>
    {trackerVisited && <div hidden={tab !== "tracker"}><Tracker active={tab === "tracker"} /></div>}
  </div>;
}
