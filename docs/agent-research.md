# How would an agentic recommendation work in this application?

Learning goal: build a small company research agent, understand its failures, and measure whether changes make it more useful.

This is a working notebook. Fill in decisions and observations as we experiment; the steps below are starting points.

## Big things I really need to have?

### 1. A clear task and definition of success

Starting task: given my profile and a company list, recommend up to three companies worth investigating, with reasons and unknowns. Questions to ponder:

- Target roles and relevant experience: I’m targeting SWE roles at early-stage startups. My experience spans backend systems, infrastructure, developer tooling, and customer-facing software. I’m interested in AI applications, product engineering, and systems engineering; a company can appeal through any of these.

- Hard requirements: Company must be US-based, outside the space industry, and have software engineering work.

- Preferences: Small teams where software is central to the product. Explicit entry-level openings are a plus, but not required. A company can be worth contacting even without advertised openings.

- What makes a recommendation useful: Explain what work fits my interests, which experience supports my potential contribution, and the next step. That could mean applying or cold outreach to a founder or engineering lead. Separate company fit from evidence they’re hiring. Screen out definite hard failures early.

- When to return fewer than three recommendations: When fewer than three companies meet the hard requirements and have enough supported fit to justify applying or reaching out. Don’t pad with weak matches. Small size alone doesn’t establish fit.

### 2. Information and tools

Start with `fixtures/companies.json`. Keep the app's runtime data source unchanged; do not call the live RecentFunding API.

Later, give the agent one tool that reads a saved company or careers page. Add live research only after that experiment works.

- What can the existing company fields tell us? Most of them have a website field, stage is something else i'm looking for
- What important facts are missing? What roles are open explicitly
- What should the first tool accept and return? 
- How will it distinguish a missing page from a page with no relevant opening? _TODO_

### 3. An agent loop with limits

The model receives the task, current findings, and available tools. It chooses whether to read another source or finish. Our code executes the tool, records the result, and returns it to the model.

- State to retain: profile, companies, findings, sources, unresolved questions, and remaining budget.
- Initial experiment limit: five tool calls per company, then return partial findings.
- Stop early when enough evidence exists to assess fit, or no useful source remains.
- Validate tool inputs and enforce limits in code.

Questions: what decisions should the model make? What should ordinary code handle? _TODO_

### 4. Evidence and uncertainty

Rough recommendation shape:

- Company and fit judgment: _TODO_
- Reasons connected to my profile: _TODO_
- Supporting facts and source references: _TODO_
- Mismatches and unknowns: _TODO_
- Evidence checked at: _TODO_

```json
{
  "company": "Example Company",
  "fit_judgment": "strong_fit",
  "reasons_connected_to_profile": [
    "Builds a software product around a workflow I’m interested in."
  ],
  "supporting_facts": [
    {
      "id": "fact_1",
      "claim": "The company builds software for customer support teams.",
      "source_url": "https://example.com/product"
    }
  ],
  "mismatches": [],
  "unknowns": [
    "Whether the company is hiring entry-level engineers."
  ],
  "recommended_next_step": {
    "action": "cold_outreach",
    "reason": "Company fit supports reaching out despite no suitable advertised opening.",
    "url": null
  },
  "evidence_checked_at": "2026-11-03T15:00:00Z"
}
```

Research notes should separate observed facts from judgments. A source reference must support the associated claim. Missing information stays unknown.

### 5. A way to evaluate and debug it

Keep the input, profile, prompt/model version, output, tool requests/results, errors, duration, and cost when available.

- How will I judge recommendation usefulness? _TODO_
- How will I check whether claims have support? _TODO_
- What would count as a missed match? _TODO_
- How much time and money would make a run worthwhile? _TODO_

## How would this map to actionable items?

### First sitting: define the task and review ten companies

- [ ] Write a short profile using the fields above.
- [ ] Pick ten companies from `fixtures/companies.json` and record their slugs below.
- [ ] Review them myself before looking at model recommendations.
- [ ] Label each as worth investigating, poor fit, or insufficient evidence, with one reason.

**Done when:** I have a profile and ten judgments grounded in the available information. Unknown hiring details are acceptable.

Selected companies and my judgments: _TODO_

### Experiment 1: one model call, no tools

- [ ] Give a model the profile, ten company records, and the starting task.
- [ ] Ask it to use only those records and mark unsupported details as unknown.
- [ ] Save the prompt and response, then review the recommendations.
- [ ] Record one useful result and one failure or limitation.

**Done when:** I have a baseline I can inspect and repeat. A manual chat run is enough to start.

What worked? _TODO_

What failed, or could not be determined? _TODO_

### Experiment 2: a tiny agent with one tool

- [ ] Start with three of the companies and a few manually saved source pages.
- [ ] Record each source's URL and capture date, then keep the pages fixed for comparison.
- [ ] Build one tool that reads a saved page by source ID.
- [ ] Let the model choose which source to read next and when to finish.
- [ ] Enforce the tool-call limit and record the calls and results.
- [ ] Try a missing source and a case with insufficient evidence.

**Done when:** the agent uses a tool result to make its next decision, respects its limit, and can return partial findings.

Which decisions did it make well? _TODO_

Where did it waste effort or misread evidence? _TODO_

### Experiment 3: compare, diagnose, improve

- [ ] Give a single-call baseline the same saved evidence available to the agent. This helps separate the value of information from the value of tool use.
- [ ] Compare recommendation usefulness, missed matches, unsupported claims, duration, and cost.
- [ ] Repeat each version three times to see how much results vary.
- [ ] Choose one observed failure and change one thing: task wording, tool design, context, or stopping rule.
- [ ] Rerun the same cases and check for regressions.
- [ ] Check a few additional companies that I did not use while tuning.

**Done when:** I can explain whether the change helped, with examples and measurements. An inconclusive result is a valid finding.

Result and next experiment: _TODO_

### Later experiments, if useful

- Replace saved-page research with live search and page reading; keep source dates and run limits.
- Compare a fixed research workflow with the agent using comparable evidence and budgets.
- Add recommendations to the app after the research loop is useful on its own.

## Experiment log — copy for each attempt

### Experiment: _name / date_

- Question or hypothesis: _TODO_
- Inputs, source snapshots, and prompt/model version: _TODO_
- Change from the previous attempt: _TODO_
- Expected improvement: _TODO_
- Results: useful recommendations __ / __; missed matches __; unsupported claims __; tool calls __; duration __; cost __.
- Failure example and likely cause: _TODO_
- What I learned / next step: _TODO_

## Ideas I want to understand better

- When does choosing tools dynamically improve the outcome? _TODO_
- How do tool design and context affect behavior? _TODO_
- How do I know an evaluation reflects my actual needs? _TODO_
- Which failures need better information, clearer instructions, or a code fix? _TODO_
- What evidence from this project could I explain in a job interview? _TODO_

## Optional reading

- [Building effective agents](https://www.anthropic.com/research/building-effective-agents): workflows, agent loops, and when added complexity helps.
- [Writing effective tools for agents](https://www.anthropic.com/research/writing-tools-for-agents): tool contracts and useful context.
- [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents): repeatable tasks, grading, and failure analysis.
