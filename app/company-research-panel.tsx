"use client";

/**
 * @fileoverview Shows round-specific AI research inside the Discovery company dialog.
 * Reads saved assessments and starts explicit reruns through the company research API.
 * Keeps the last success visible during running or failed attempts; server modules own persistence.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { CompanyAssessment, ResearchCompany, ResearchResult } from "@/lib/company-research";
import type { ResearchRunSummary } from "@/lib/company-research-storage";
import { formatDateTime } from "@/lib/date-time";

type Run = ResearchRunSummary & { companyInput: ResearchCompany; result: ResearchResult | null; stale: boolean | null; staleReasons: string[] };
type ResearchView = {
  latestAttempt: Run | null;
  latestSuccessful: Run | null;
  currentInputsAvailable: { company: boolean; profile: boolean };
};
const fitLabels = {
  strong_fit: "Strong fit", possible_fit: "Possible fit", insufficient_evidence: "Insufficient evidence", reject: "Reject",
};
const actionLabels = { apply: "Apply", cold_outreach: "Cold outreach", further_research: "Research further", skip: "Skip" };
const staleLabels: Record<string, string> = {
  company_input_changed: "company information", profile_changed: "your profile", model_changed: "research model", prompt_changed: "research instructions",
};

// Saved URLs still cross a browser trust boundary, even though new research validates public URLs server-side.
function sourceLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

/** Displays the assessment with citations that open and focus their supporting evidence. */
export function ResearchAssessment({ assessment, sources, companyInput }: {
  assessment: CompanyAssessment; sources: ResearchResult["sources"]; companyInput?: ResearchCompany;
}) {
  // 1. Link assessment citations directly to page or funding-input evidence.
  // 2. Present the summary and expandable fit details.
  // 3. Show fetched source excerpts without model-generated fact or quote records.
  const evidence = useRef<HTMLDetailsElement>(null);
  const prefix = useId();
  const companySourceIds = new Set([...assessment.reasons_connected_to_profile, ...assessment.mismatches,
    assessment.hiring, assessment.role_suitability].flatMap(item => item.source_ids).filter(id => id.startsWith("company.")));
  function citations(ids: string[]) {
    return [...new Set(ids)].map(id => <a key={id} className="research-citation" href={`#${prefix}-${id}`} onClick={() => {
      if (evidence.current) evidence.current.open = true;
      document.getElementById(`${prefix}-${id}`)?.focus();
    }} aria-label={`Show evidence ${id}`}>[{id}]</a>);
  }
  function reasons(items: CompanyAssessment["mismatches"], empty: string) {
    return items.length ? <ul>{items.map((item, index) => <li key={index}>{item.reason} {citations(item.source_ids)}</li>)}</ul> : <p>{empty}</p>;
  }
  return <>
    <div className="research-assessment" data-fit={assessment.fit_judgment}>
      <div className="research-summary-heading"><h3>Company assessment</h3>
        <span className="research-fit">{fitLabels[assessment.fit_judgment]}</span>
        <span className="research-source-count">{sources.length} pages reviewed</span></div>
      <p>{assessment.fit_summary}</p>
      <div className="research-recommendation"><strong>Recommended next step</strong>
        <span><b>{actionLabels[assessment.recommended_next_step.action]}</b> · {assessment.recommended_next_step.reason}</span></div>
    </div>
    <details className="research-disclosure" open>
      <summary>Fit details &amp; analysis</summary>
      <div className="research-detail-body">
        <section className="research-matches"><h4>Profile matches</h4>
          {reasons(assessment.reasons_connected_to_profile, "No supported profile matches identified.")}</section>
        <div className="research-detail-grid">
          <section><h4>Role suitability</h4><span className="research-label">{{ possible_match: "Possible match", mismatch: "Mismatch", unknown: "Unknown" }[assessment.role_suitability.status]}</span>
            <p>{assessment.role_suitability.summary} {citations(assessment.role_suitability.source_ids)}</p></section>
          <section><h4>Hiring status</h4><span className="research-label">{{ verified_openings: "Openings found", no_openings_found: "No openings found", unknown: "Unknown" }[assessment.hiring.status]}</span>
            <p>{assessment.hiring.summary} {citations(assessment.hiring.source_ids)}</p></section>
          <section><h4>Mismatches</h4>{reasons(assessment.mismatches, "None identified in the available evidence.")}</section>
          <section className="research-unknowns"><h4>Unknowns</h4>{assessment.unknowns.length
            ? <ul>{assessment.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p>None reported.</p>}</section>
        </div>
      </div>
    </details>
    <details ref={evidence} className="research-disclosure">
      <summary>Evidence &amp; sources</summary>
      <div className="research-detail-body research-evidence">
        {sources.map(source => <article key={source.id} id={`${prefix}-${source.id}`} tabIndex={-1}>
          <strong>[{source.id}] {source.page.title || "Company page"}</strong>
          <blockquote>{source.page.text || "No readable text available."}</blockquote>
          {source.page.truncated && <p className="research-label">Excerpt shortened for research.</p>}
          <a href={sourceLink(source.page.url)} target="_blank" rel="noopener noreferrer">Open source ↗</a>
          <span className="research-source-date">Checked {formatDateTime(Date.parse(source.page.checked_at), "UTC")} UTC</span>
        </article>)}
        {!sources.length && <p>No webpage excerpts available.</p>}
        {companyInput && companySourceIds.size > 0 && <><h4>Saved funding information</h4>
          {Object.entries(companyInput).filter(([key, value]) => companySourceIds.has(`company.${key}`) && value !== null && value !== undefined).map(([key, value]) =>
            <article key={key} id={`${prefix}-company.${key}`} tabIndex={-1}><strong>[company.{key}]</strong>
              <p>{typeof value === "string" ? value : JSON.stringify(value)}</p></article>)}</>}
      </div>
    </details>
  </>;
}

/** Reads saved research on open, polling only active attempts; starting research always requires a click. */
export default function CompanyResearchPanel({ slug, announcedDate }: { slug: string; announcedDate: string | null }) {
  // 1. Load this round's saved assessment and watch any active attempt.
  // 2. Start explicit research without discarding the previous successful result.
  // 3. Present request status separately from the evidence-backed assessment.
  const [data, setData] = useState<ResearchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const heading = useId();
  const endpoint = `/api/companies/${encodeURIComponent(slug)}/research`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!announcedDate || submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch(`${endpoint}?announcedDate=${announcedDate}`, { signal: controller.signal, cache: "no-store" });
        const view = await response.json();
        if (!response.ok) throw new Error(view.error?.message ?? "Could not load saved research.");
        if (controller.signal.aborted) return;
        setData(view);
        setReadError("");
        if (view.latestAttempt?.status === "running") timer = setTimeout(() => void load(), 3000);
      } catch (error) {
        if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : "Could not load saved research.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, announcedDate, submitting, reload]);

  async function start() {
    if (inFlight.current || !announcedDate) return;
    inFlight.current = true;
    setSubmitting(true);
    setActionError("");
    try {
      // Closing the dialog stops reads, but lets this explicit request finish and save its result.
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ announcedDate }) });
      const view = await response.json();
      if (!response.ok && response.status !== 409 && !view.run) throw new Error(view.error?.message ?? "Could not start research.");
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : "Could not start research. Reload saved research before retrying.");
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setLoading(true);
        setSubmitting(false);
        setReload(value => value + 1);
      }
    }
  }

  const latest = data?.latestAttempt;
  const saved = data?.latestSuccessful;
  const result = saved?.result;
  const running = submitting || latest?.status === "running";
  const unavailable = data && (!data.currentInputsAvailable.company || !data.currentInputsAvailable.profile);
  const failed = !running && latest?.status === "failed";
  const status = running ? "Researching…" : loading ? "Loading…" : failed ? "Last attempt failed" : saved ? "Completed" : "Not researched";

  return <section className="company-research" aria-labelledby={heading}>
    <header className="research-toolbar"><div><h3 id={heading}>✦ AI Research</h3>
      <span className="research-status" role="status" aria-live="polite">{announcedDate ? status : "Unavailable"}</span></div>
      <button className="research-start" onClick={() => void start()} disabled={!announcedDate || loading || running || !!readError || !!unavailable}>
        {running ? "Researching…" : latest ? "Research again" : "Research company"}</button>
    </header>
    {!announcedDate ? <p className="research-notice">Research needs a funding announcement date.</p> : <>
      {readError && <div className="research-notice research-error" role="alert">{readError} <button onClick={() => { setLoading(true); setReload(value => value + 1); }}>Reload research</button></div>}
      {actionError && <p className="research-notice research-error" role="alert">{actionError}</p>}
      {unavailable && <p className="research-notice">{!data.currentInputsAvailable.profile
        ? "Create a valid data/profile.json to research against your experience and preferences."
        : "This funding round is absent from the current Discovery snapshot. Saved research remains available."}</p>}
      {running && <p className="research-notice" role="status">Reviewing company pages against your profile. This can take up to two minutes.
        {saved && " Showing the previous assessment below."}</p>}
      {failed && <p className="research-notice research-error" role="alert">{latest.error || "Research failed."}{saved && " Your previous assessment is shown below."}</p>}
      {saved?.stale && <p className="research-notice">Assessment may be outdated. Changed: {saved.staleReasons.map(reason => staleLabels[reason] ?? reason).join(", ")}. Research again to update it.</p>}
      {saved?.stale === null && <p className="research-notice">Saved assessment available; freshness cannot be checked against current inputs.</p>}
      {saved && <p className="research-timestamp">Assessed {formatDateTime(Date.parse(saved.finishedAt ?? saved.startedAt), "UTC")} UTC</p>}
      {result?.status === "completed" ? <ResearchAssessment key={saved!.id} assessment={result.assessment} sources={result.sources} companyInput={saved!.companyInput} />
        : !loading && !running && !readError && <p className="research-empty">Research this company for profile fit, hiring signals, and evidence behind your next step.</p>}
    </>}
  </section>;
}
