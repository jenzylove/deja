"use client";

import { FormEvent, useState } from "react";

import {
  EXAMPLE_RESULT,
  FIELD_OPTIONS,
  getIntentErrors,
  getOutcomeTone,
  getWorkspaceView,
  type IntentDraft,
  type IntentErrors,
  type WorkspaceState,
} from "@/lib/intent-ui";

const INITIAL_DRAFT: IntentDraft = {
  asset: "BTC",
  assetClass: "crypto",
  direction: "long",
  thesisRaw: "",
  size: "0.05",
  entry: "64000",
  stopLoss: "",
  takeProfit: "",
  riskPct: "1",
  confidence: "medium",
  session: "ny",
  regime: "trending",
  sizeIncreaseAfterLoss: false,
};

const LABELS: Record<string, string> = {
  asia: "Asia",
  london: "London",
  ny: "New York",
  off: "Off session",
  trending: "Trending",
  ranging: "Ranging",
  volatile: "Volatile",
  unknown: "Unknown",
  low: "Low",
  medium: "Medium",
  high: "High",
  long: "Long",
  short: "Short",
};

function titleCase(value: string) {
  return LABELS[value] ?? value;
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  helper,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  helper?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {titleCase(option)}
          </option>
        ))}
      </select>
      {helper ? <p className="field-help">{helper}</p> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  error,
  helper,
  optional = false,
}: {
  id: keyof IntentDraft;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  optional?: boolean;
}) {
  const describedBy = error ? `${id}-error` : helper ? `${id}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}{optional ? " (optional)" : ""}</label>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
      />
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : helper ? <p className="field-help" id={`${id}-help`}>{helper}</p> : null}
    </div>
  );
}

function DecisionMark({ decision }: { decision: "BLOCK" | "WARN" | "PASS" }) {
  return <span className={`decision decision-${decision.toLowerCase()}`}>{decision}</span>;
}

function EmptyWorkspace() {
  const view = getWorkspaceView("empty");
  return (
    <div className="empty-state" aria-live="polite">
      <span className="empty-index" aria-hidden="true">01</span>
      <div>
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
      </div>
    </div>
  );
}

function UnavailableWorkspace({ onExample }: { onExample: () => void }) {
  const view = getWorkspaceView("unavailable");
  return (
    <div className="unavailable-state" role="alert">
      <div className="result-heading">
        <DecisionMark decision="BLOCK" />
        <span className="source-label">LOCAL INTERFACE STATE</span>
      </div>
      <h2>{view.title}</h2>
      <p>{view.detail}</p>
      <div className="recovery-note">
        <strong>Recovery</strong>
        <span>{view.recovery}</span>
      </div>
      <button className="secondary-button" type="button" onClick={onExample}>
        View example result
      </button>
    </div>
  );
}

function DegradedWorkspace({ onReturn }: { onReturn: () => void }) {
  const view = getWorkspaceView("degraded");
  return (
    <div className="degraded-state" role="status">
      <div className="result-heading">
        <DecisionMark decision="BLOCK" />
        <span className="fixture-label">EXAMPLE FIXTURE STATE</span>
      </div>
      <h2>{view.title}</h2>
      <p>{view.detail}</p>
      <div className="recovery-note">
        <strong>Fail-closed behavior</strong>
        <span>{view.recovery}</span>
      </div>
      <div className="rule-row">
        <DecisionMark decision="PASS" />
        <div>
          <strong>Deterministic risk rule still evaluated</strong>
          <p>Fixture evidence only. risk_pct lte 2, actual 1.</p>
        </div>
      </div>
      <button className="text-button" type="button" onClick={onReturn}>
        Return to example result
      </button>
    </div>
  );
}

function ExampleWorkspace({ onDegraded }: { onDegraded: () => void }) {
  const result = EXAMPLE_RESULT;
  return (
    <div className="example-result">
      <div className="fixture-banner" role="note">
        <strong>{result.source}</strong>
        <span>Static demonstration only. Not live account history.</span>
      </div>

      <section className="result-overview" aria-labelledby="example-title">
        <div className="result-heading">
          <DecisionMark decision={result.decision} />
          <span className="fixture-label">{result.source}</span>
        </div>
        <h2 id="example-title">Example decision result</h2>
        <p>{result.summary}</p>
      </section>

      <section className="cohort-block" aria-labelledby="cohort-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Evidence tier</p>
            <h3 id="cohort-title">Anecdote, n={result.cohort.n}</h3>
          </div>
          <span className="fixture-label">EXAMPLE FIXTURE DATA</span>
        </div>
        <p>{result.cohort.caveat}</p>
        <div className="filter-note">
          <strong>Filter widened</strong>
          <p>{result.filter.disclosure}</p>
          <span>{result.filter.candidates} example candidates reviewed</span>
        </div>
      </section>

      <section aria-labelledby="rules-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Deterministic checks</p>
            <h3 id="rules-title">Rule evidence</h3>
          </div>
          <span className="fixture-label">EXAMPLE FIXTURE DATA</span>
        </div>
        <div className="rule-list">
          {result.rules.map((rule) => (
            <article className="rule-row" key={rule.id}>
              <DecisionMark decision={rule.passed ? "PASS" : rule.enforcement === "block" ? "BLOCK" : "WARN"} />
              <div className="rule-copy">
                <strong>{rule.label}</strong>
                <p>{rule.passed ? "Rule satisfied." : "Advisory rule not satisfied."}</p>
              </div>
              <dl className="evidence-grid">
                <div><dt>Field</dt><dd>{rule.field}</dd></div>
                <div><dt>Expected</dt><dd>{rule.operator} {rule.expected}</dd></div>
                <div><dt>Actual</dt><dd>{rule.actual}</dd></div>
                <div><dt>Enforcement</dt><dd>{rule.enforcement}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="episodes-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Raw prior episodes</p>
            <h3 id="episodes-title">Anecdote-safe evidence</h3>
          </div>
          <span className="fixture-label">EXAMPLE FIXTURE DATA</span>
        </div>
        <p className="section-intro">These three example episodes are shown verbatim instead of turning a small cohort into a percentage.</p>
        <div className="episode-list">
          {result.episodes.map((episode) => (
            <article className="episode" key={episode.id}>
              <div className="episode-meta">
                <span>{episode.asset}</span>
                <strong className={`outcome-${getOutcomeTone(episode.outcome)}`}>{episode.outcome}</strong>
              </div>
              <blockquote>“{episode.thesis}”</blockquote>
              <p>{episode.context}</p>
              <span className="fixture-label">{episode.source}</span>
            </article>
          ))}
        </div>
        <p className="association-note">
          This evidence is associative, not causal. It includes only trades taken and cannot separate behavior from market regime.
        </p>
      </section>

      <button className="text-button" type="button" onClick={onDegraded}>
        View provider-unavailable example
      </button>
    </div>
  );
}

export default function Home() {
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  const [errors, setErrors] = useState<IntentErrors>({});
  const [workspace, setWorkspace] = useState<WorkspaceState>("empty");

  function update<K extends keyof IntentDraft>(field: K, value: IntentDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submitIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = getIntentErrors(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setWorkspace("empty");
      const first = Object.keys(nextErrors)[0];
      document.getElementById(first)?.focus();
      return;
    }

    setWorkspace("unavailable");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="wordmark">deja</span>
          <span className="product-label">Paper decision memory</span>
        </div>
        <div className="mode-note">
          <span>Paper only</span>
          <span>No orders routed</span>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="intent-panel" aria-labelledby="intent-heading">
          <div className="panel-heading">
            <p className="section-kicker">New intent</p>
            <h1 id="intent-heading">Pause before the trade.</h1>
            <p>State the setup. Deja checks personal rules and comparable decisions before any paper action.</p>
          </div>

          <form onSubmit={submitIntent} noValidate>
            <fieldset>
              <legend className="sr-only">Paper-trade intent details</legend>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="asset">Asset</label>
                  <input id="asset" name="asset" value={draft.asset} onChange={(event) => update("asset", event.target.value)} placeholder="BTC" autoCapitalize="characters" aria-invalid={Boolean(errors.asset)} aria-describedby={errors.asset ? "asset-error" : undefined} />
                  {errors.asset ? <p className="field-error" id="asset-error">{errors.asset}</p> : null}
                </div>

                <div className="field">
                  <label htmlFor="assetClass">Asset class</label>
                  <input id="assetClass" name="assetClass" value={draft.assetClass} onChange={(event) => update("assetClass", event.target.value)} placeholder="crypto" aria-invalid={Boolean(errors.assetClass)} aria-describedby={errors.assetClass ? "assetClass-error" : undefined} />
                  {errors.assetClass ? <p className="field-error" id="assetClass-error">{errors.assetClass}</p> : null}
                </div>

                <SelectField id="direction" label="Direction" value={draft.direction} options={FIELD_OPTIONS.direction} onChange={(value) => update("direction", value as IntentDraft["direction"])} />
                <NumberField id="size" label="Position size" value={draft.size} onChange={(value) => update("size", value)} error={errors.size} helper="Paper position units." />
                <NumberField id="entry" label="Entry" value={draft.entry} onChange={(value) => update("entry", value)} error={errors.entry} />
                <NumberField id="stopLoss" label="Stop loss" value={draft.stopLoss} onChange={(value) => update("stopLoss", value)} error={errors.stopLoss} optional />
                <NumberField id="takeProfit" label="Take profit" value={draft.takeProfit} onChange={(value) => update("takeProfit", value)} error={errors.takeProfit} optional />
                <NumberField id="riskPct" label="Risk %" value={draft.riskPct} onChange={(value) => update("riskPct", value)} error={errors.riskPct} helper="Percent of paper account at risk." />

                <SelectField id="confidence" label="Confidence" value={draft.confidence} options={FIELD_OPTIONS.confidence} onChange={(value) => update("confidence", value as IntentDraft["confidence"])} />
                <SelectField id="session" label="Session" value={draft.session} options={FIELD_OPTIONS.session} onChange={(value) => update("session", value as IntentDraft["session"])} />
                <SelectField id="regime" label="Regime" value={draft.regime} options={FIELD_OPTIONS.regime} onChange={(value) => update("regime", value as IntentDraft["regime"])} helper="Choose unknown when context is unclear." />

                <div className="field">
                  <label htmlFor="sizeIncreaseAfterLoss">Size increased after the last loss?</label>
                  <select id="sizeIncreaseAfterLoss" name="sizeIncreaseAfterLoss" value={draft.sizeIncreaseAfterLoss ? "yes" : "no"} onChange={(event) => update("sizeIncreaseAfterLoss", event.target.value === "yes")}>
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </div>

                <div className="field thesis-field">
                  <label htmlFor="thesisRaw">Thesis</label>
                  <textarea id="thesisRaw" name="thesisRaw" rows={5} value={draft.thesisRaw} onChange={(event) => update("thesisRaw", event.target.value)} placeholder="What changed, what confirms it, and what would make the idea wrong?" aria-invalid={Boolean(errors.thesisRaw)} aria-describedby={errors.thesisRaw ? "thesisRaw-error" : "thesisRaw-help"} />
                  {errors.thesisRaw ? <p className="field-error" id="thesisRaw-error">{errors.thesisRaw}</p> : <p className="field-help" id="thesisRaw-help">Required. Your words stay attached to the decision record.</p>}
                </div>
              </div>
            </fieldset>

            <div className="form-actions">
              <button className="primary-button" type="submit">
                Check paper intent
              </button>
              <p>No authenticated API is connected in this gate. Submission will fail closed.</p>
            </div>
          </form>
        </section>

        <aside className="result-panel" aria-label="Decision result workspace">
          <div className="result-panel-header">
            <span>Decision workspace</span>
            <span aria-live="polite">{workspace === "example" ? "Fixture preview" : workspace === "degraded" ? "Fixture degraded" : titleCase(workspace)}</span>
          </div>
          <div className="result-panel-body">
            {workspace === "empty" ? <EmptyWorkspace /> : null}
            {workspace === "unavailable" ? <UnavailableWorkspace onExample={() => setWorkspace("example")} /> : null}
            {workspace === "example" ? <ExampleWorkspace onDegraded={() => setWorkspace("degraded")} /> : null}
            {workspace === "degraded" ? <DegradedWorkspace onReturn={() => setWorkspace("example")} /> : null}
          </div>
        </aside>
      </div>

      <footer className="footer-note">
        <p>Decision support for paper trading. Deja does not predict markets or route real orders.</p>
        <p>Example history is always labelled and never presented as live evidence.</p>
      </footer>
    </main>
  );
}
