"use client";

import { formatDateTime } from "@/lib/date-time";
import { useEffect, useState } from "react";
import Tracker from "./tracker";

type Company = {
  slug: string;
  name: string;
  amount: number | null;
  stage: string | null;
  date: number | null;
  website: string | null;
};
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
  };
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});

// Browse the current API batch; search and sorting never imply full-dataset coverage.
function Discovery() {
  // 1. Load and normalize the batch through the server-side API proxy.
  // 2. Filter and sort locally, keeping unavailable values last.
  // 3. Render the table and accessible request status.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [notice, setNotice] = useState("");
  const [excluded, setExcluded] = useState(0);
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
        setExcluded(typeof data.filtering?.excluded === "number" ? data.filtering.excluded : 0);
        setNotice(typeof data.access?.notice === "string" ? data.access.notice : "");
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

  const visible = companies
    .filter((company) => company.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      const left = a[sort];
      const right = b[sort];
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return right - left || a.name.localeCompare(b.name);
    });

  return (
    <main className="desktop">
      <section className="window companies-window" aria-labelledby="app-title">
        <div className="title-bar"><div className="title-bar-text">Who Has Money?</div></div>
        <div className="window-body">
          <header className="intro">
            <h1 id="app-title">Who Has Money?</h1>
            <p>Recently funded companies. Find out who raised what.</p>
          </header>
          <div className="toolbar">
            <div className="control search-control">
              <label htmlFor="company-search">Search loaded companies</label>
              <input id="company-search" type="search" placeholder="Company name…" value={query}
                onChange={(event) => setQuery(event.target.value)} disabled={loading || !!error} />
            </div>
            <div className="control">
              <label htmlFor="company-sort">Sort by</label>
              <select id="company-sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="date">Newest funding</option>
                <option value="amount">Largest amount</option>
                <option value="name">Company name</option>
              </select>
            </div>
          </div>
          {notice && !error && <p className="access-notice">{notice}</p>}
          {loading ? <p className="message" role="status">Loading companies…</p>
            : error ? <div className="message" role="alert"><p>{error}</p>
              <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
            : <>
              <div className="table-scroll" role="region" aria-label="Companies table" tabIndex={0}>
                <table>
                  <caption className="sr-only">Recently funded companies, amounts in US dollars. Missing values shown as a dash.</caption>
                  <thead><tr><th scope="col">Company</th><th scope="col" className="amount">Amount (USD)</th>
                    <th scope="col">Round / stage</th><th scope="col">Announced</th><th scope="col">Website</th></tr></thead>
                  <tbody>{visible.map((company) => <tr key={company.slug}>
                    <th scope="row">{company.name}</th>
                    <td className="amount">{company.amount === null ? "—" : money.format(company.amount)}</td>
                    <td className="stage">{company.stage?.replaceAll("-", " ").replaceAll("_", " ") ?? "—"}</td>
                    <td>{company.date === null ? "—" : formatDateTime(company.date, "UTC")}</td>
                    <td>{company.website ? <a href={company.website} target="_blank" rel="noopener noreferrer"
                      aria-label={`Visit ${company.name} website (opens in a new tab)`}>Visit website</a> : "—"}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              {visible.length === 0 && <div className="message" role="status">
                <p>{companies.length ? "No companies match your search." : "No companies available yet."}</p>
                {query && <button onClick={() => setQuery("")}>Clear search</button>}
              </div>}
            </>}
        </div>
        <footer className="status-bar" aria-live="polite" aria-atomic="true">
          <p className="status-bar-field">{loading ? "Loading…" : error ? "Could not load companies" :
            `Showing ${visible.length} of ${companies.length} loaded companies`}</p>
          <p className="status-bar-field">Source: RecentFunding · US and unknown locations · {excluded} non-US excluded</p>
        </footer>
      </section>
    </main>
  );
}

// Keep visited panels mounted so switching tabs preserves searches and unsaved drafts.
export default function Home() {
  const [tab, setTab] = useState<"discovery" | "tracker">("discovery");
  const [trackerVisited, setTrackerVisited] = useState(false);
  return <>
    <nav className="app-navigation" aria-label="Application sections">
      <button aria-pressed={tab === "discovery"} onClick={() => setTab("discovery")}>Discovery</button>
      <button aria-pressed={tab === "tracker"} onClick={() => { setTrackerVisited(true); setTab("tracker"); }}>✦ Tracker Workspace <span className="navigation-live">LIVE</span></button>
    </nav>
    <div hidden={tab !== "discovery"}><Discovery /></div>
    {trackerVisited && <div hidden={tab !== "tracker"}><Tracker active={tab === "tracker"} /></div>}
  </>;
}
