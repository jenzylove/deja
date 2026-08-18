"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import {
  EXAMPLE_RESULT,
  FIELD_OPTIONS,
  buildClosePayload,
  buildExecutePayload,
  formatEvidenceRate,
  getIntentErrors,
  getOutcomeTone,
  getWorkspaceView,
  interpretCloseApiResponse,
  interpretInsightsApiResponse,
  interpretIntentApiResponse,
  interpretTradeApiResponse,
  renderR,
  toTradeIntentInput,
  warningsShownFromResult,
  type CloseTradeApiSuccess,
  type DnaRow,
  type ExecuteTradeApiSuccess,
  type InsightsState,
  type IntentDraft,
  type IntentErrors,
  type IntentSubmissionState,
  type WarningCode,
  type WarningLedgerRow,
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

function LoadingWorkspace() {
  const view = getWorkspaceView("loading");
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <span className="empty-index" aria-hidden="true">…</span>
      <div>
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
      </div>
    </div>
  );
}

function ValidationWorkspace({ message }: { message: string }) {
  const view = getWorkspaceView("validation_error");
  return (
    <div className="unavailable-state" role="alert">
      <h2>{view.title}</h2>
      <p>{message}</p>
      <div className="recovery-note">
        <strong>Recovery</strong>
        <span>{view.recovery}</span>
      </div>
    </div>
  );
}

function LiveWorkspace({ result }: {
  result: Extract<IntentSubmissionState, { kind: "result" }>["result"];
}) {
  const cohort = result.retrieval?.cohort;
  return (
    <div className="example-result">
      <section className="result-overview" aria-labelledby="live-result-title">
        <div className="result-heading">
          <DecisionMark decision={result.decision} />
          <span className="source-label">
            {result.state === "complete" ? "SERVER RESULT" : "SERVER DEGRADED RESULT"}
          </span>
        </div>
        <h2 id="live-result-title">Decision result</h2>
        <p>
          {result.state === "complete"
            ? "The configured tenant’s rules and retrieved memory were evaluated by the server."
            : "The server returned a degraded decision with limited evidence."}
        </p>
        {result.errors.map((error) => (
          <p className="field-error" key={error.stage}>{error.message}</p>
        ))}
      </section>

      {result.canonicalThesis ? (
        <section aria-labelledby="canonical-title">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Canonical thesis</p>
              <h3 id="canonical-title">{titleCase(result.canonicalThesis.strategy)}</h3>
            </div>
            <span className="source-label">SERVER OUTPUT</span>
          </div>
          <p>{result.canonicalThesis.canonical}</p>
        </section>
      ) : null}

      {result.retrieval && cohort ? (
        <section className="cohort-block" aria-labelledby="live-cohort-title">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Evidence tier</p>
              <h3 id="live-cohort-title">{titleCase(cohort.tier)}, n={cohort.n}</h3>
            </div>
            <span className="source-label">TENANT MEMORY</span>
          </div>
          <p>{cohort.caveat}</p>
          {cohort.tier !== "anecdote" ? (
            <p>
              Win rate {(cohort.percentage * 100).toFixed(1)}% (n={cohort.n}), Wilson 95% interval {cohort.interval.low.toFixed(2)}–{cohort.interval.high.toFixed(2)}.
            </p>
          ) : null}
          <div className="filter-note">
            <strong>{result.retrieval.filter.widened ? "Filter widened" : "Retrieval filter"}</strong>
            <p>{result.retrieval.filter.used}</p>
            <span>{result.retrieval.filter.candidates} candidates reviewed</span>
          </div>
          <div className="episode-list">
            {result.retrieval.episodes.map((episode) => (
              <article className="episode" key={episode.intentId}>
                <div className="episode-meta">
                  <span>{episode.asset} {episode.direction}</span>
                  <strong className={`outcome-${getOutcomeTone(String(episode.rMultiple ?? 0))}`}>
                    {episode.rMultiple === null ? "Outcome unavailable" : `${episode.rMultiple}R`}
                  </strong>
                </div>
                <blockquote>“{episode.thesisRaw}”</blockquote>
                <span className="source-label">TENANT MEMORY · {episode.intentId}</span>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="live-rules-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Deterministic checks</p>
            <h3 id="live-rules-title">Rule evidence</h3>
          </div>
          <span className="source-label">SERVER EVALUATION</span>
        </div>
        {result.rules.evidence.length === 0 ? <p>No active rules were returned.</p> : null}
        <div className="rule-list">
          {result.rules.evidence.map((rule) => (
            <article className="rule-row" key={rule.ruleId}>
              <DecisionMark decision={rule.passed ? "PASS" : rule.enforcement === "block" ? "BLOCK" : "WARN"} />
              <div className="rule-copy">
                <strong>{rule.ruleId}</strong>
                <p>{rule.field}: {rule.actual === undefined ? "unavailable" : String(rule.actual)} {rule.operator} {rule.expected === undefined ? "unavailable" : String(rule.expected)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

type TradeFlowState =
  | { kind: "idle" }
  | { kind: "executing" }
  | { kind: "open"; execution: ExecuteTradeApiSuccess }
  | { kind: "blocked"; message: string }
  | { kind: "validation_error"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "closing"; execution: ExecuteTradeApiSuccess }
  | { kind: "closed"; closed: CloseTradeApiSuccess }
  | { kind: "close_error"; message: string; execution: ExecuteTradeApiSuccess };

function formatPrice(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(value);
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

function WarningChecklist({
  shown,
  defied,
  onToggle,
}: {
  shown: readonly WarningCode[];
  defied: readonly WarningCode[];
  onToggle: (code: WarningCode) => void;
}) {
  return (
    <fieldset className="warning-checklist">
      <legend>Advisory warnings shown — mark each one you are knowingly defying.</legend>
      {shown.map((code) => (
        <label className="warning-option" key={code}>
          <input
            type="checkbox"
            checked={defied.includes(code)}
            onChange={() => onToggle(code)}
          />
          <span>{code}</span>
        </label>
      ))}
    </fieldset>
  );
}

function OpenTradeView({ trade }: { trade: ExecuteTradeApiSuccess["trade"] }) {
  return (
    <dl className="evidence-grid">
      <div><dt>Trade</dt><dd>{trade.id}</dd></div>
      <div><dt>Asset</dt><dd>{trade.asset}</dd></div>
      <div><dt>Direction</dt><dd>{trade.direction}</dd></div>
      <div><dt>Size</dt><dd>{trade.size}</dd></div>
      <div><dt>Entry</dt><dd>{formatPrice(trade.entry)}</dd></div>
      <div><dt>Stop</dt><dd>{trade.stop === null ? "—" : formatPrice(trade.stop)}</dd></div>
      <div><dt>Opened</dt><dd>{new Date(trade.openedAt).toISOString()}</dd></div>
    </dl>
  );
}

function CloseTradeForm({
  exitFill,
  onExitFillChange,
  onClose,
  error,
  closing,
}: {
  exitFill: string;
  onExitFillChange: (value: string) => void;
  onClose: () => void;
  error: string | null;
  closing: boolean;
}) {
  return (
    <div className="close-trade">
      <h4>Close trade</h4>
      <p className="field-help">Enter the paper exit fill price. The server computes the outcome, R multiple, and refreshed memory.</p>
      <label className="field" htmlFor="exitFill">Exit fill</label>
      <input
        id="exitFill"
        name="exitFill"
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={exitFill}
        onChange={(event) => onExitFillChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "exit-error" : undefined}
      />
      {error ? <p className="field-error" id="exit-error" role="alert">{error}</p> : null}
      <button className="secondary-button" type="button" onClick={onClose} disabled={closing}>
        {closing ? "Closing…" : "Close paper trade"}
      </button>
    </div>
  );
}

function TradeFlowSection({
  result,
  flow,
  defied,
  onToggleWarning,
  onExecute,
  onClose,
  exitFill,
  onExitFillChange,
  closeError,
}: {
  result: Extract<IntentSubmissionState, { kind: "result" }>["result"];
  flow: TradeFlowState;
  defied: readonly WarningCode[];
  onToggleWarning: (code: WarningCode) => void;
  onExecute: () => void;
  onClose: () => void;
  exitFill: string;
  onExitFillChange: (value: string) => void;
  closeError: string | null;
}) {
  if (result.decision === "BLOCK") return null;

  const shown = warningsShownFromResult(result);

  return (
    <section className="trade-flow" aria-labelledby="trade-flow-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Paper trade lifecycle</p>
          <h3 id="trade-flow-title">Execute, monitor, and close</h3>
        </div>
        <span className="source-label">SERVER OUTPUT</span>
      </div>

      {flow.kind === "idle" || flow.kind === "executing" ? (
        <div role="status">
          <p className="field-help">
            {result.decision === "PASS"
              ? "This intent passed the tenant rules and is allowed for paper execution."
              : "This intent has advisory warnings. Execution is allowed but records which shown warnings you defy."}
          </p>
          {result.decision === "WARN" && shown.length > 0 ? (
            <WarningChecklist shown={shown} defied={defied} onToggle={onToggleWarning} />
          ) : null}
          {flow.kind === "executing" ? (
            <p className="field-help" aria-live="polite">Executing paper trade…</p>
          ) : (
            <button className="primary-button" type="button" onClick={onExecute}>
              Execute paper trade
            </button>
          )}
        </div>
      ) : null}

      {flow.kind === "blocked" || flow.kind === "validation_error" || flow.kind === "unavailable" ? (
        <div className="unavailable-state" role="alert">
          <p>{flow.message}</p>
          <p className="field-help">
            {flow.kind === "blocked"
              ? "Blocked intents cannot execute. No paper trade was opened."
              : flow.kind === "validation_error"
                ? "The trade request was rejected before execution."
                : "No paper trade was opened."}
          </p>
        </div>
      ) : null}

      {flow.kind === "open" || flow.kind === "closing" || flow.kind === "close_error" ? (
        <div>
          <OpenTradeView trade={flow.execution.trade} />
          {flow.kind === "closing" ? (
            <p className="field-help" aria-live="polite">Closing paper trade…</p>
          ) : (
            <>
              {flow.kind === "close_error" ? (
                <p className="field-error" role="alert">{flow.message}</p>
              ) : null}
              <CloseTradeForm
                exitFill={exitFill}
                onExitFillChange={onExitFillChange}
                onClose={onClose}
                error={closeError}
                closing={false}
              />
            </>
          )}
        </div>
      ) : null}

      {flow.kind === "closed" ? (
        <ClosedOutcomeView closed={flow.closed} />
      ) : null}
    </section>
  );
}

function ClosedOutcomeView({ closed }: { closed: CloseTradeApiSuccess }) {
  const { outcome, memory } = closed;
  return (
    <div className="closed-trade">
      <div className="result-heading">
        <strong className={`outcome-${getOutcomeTone(String(outcome.rMultiple))}`}>
          {outcome.win ? "WIN" : "LOSS"}
        </strong>
        <span className="source-label">SERVER OUTCOME</span>
      </div>
      <h4>Trade outcome</h4>
      <dl className="evidence-grid">
        <div><dt>P&L</dt><dd>{formatPrice(outcome.pnl)}</dd></div>
        <div><dt>R multiple</dt><dd>{outcome.rMultiple.toFixed(2)}R</dd></div>
        <div><dt>Exit fill</dt><dd>{formatPrice(outcome.exitFill)}</dd></div>
        <div><dt>Exit reason</dt><dd>{outcome.exitReason}</dd></div>
        <div><dt>Held</dt><dd>{formatDuration(outcome.durationS)}</dd></div>
        <div><dt>Trade</dt><dd>{outcome.tradeId}</dd></div>
      </dl>
      <div className="section-heading">
        <div>
          <p className="section-kicker">Refreshed memory evidence</p>
          <h4>{memory.evidence.tier}, n={memory.evidence.n}, avg {memory.evidence.averageR === null ? "—" : `${memory.evidence.averageR.toFixed(2)}R`}</h4>
        </div>
        <span className="source-label">TENANT MEMORY</span>
      </div>
      <p className="field-help">Lineage intent {memory.lineage}</p>
    </div>
  );
}

function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const reduceMotion = typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
  useEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setShown(true)),
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduceMotion]);
  const visible = shown || reduceMotion;
  return (
    <div ref={ref} className={`reveal ${visible ? "in" : ""} ${className}`}>
      {children}
    </div>
  );
}

interface CheckResult {
  decision: "deja_vu" | "clear";
  pattern: { title: string; n: number; losses: number; summary: string; actions: string[] } | null;
  similarTrades: { asset: string; direction: string; outcome: string; rMultiple: number; similarity: number }[];
}

function TerminalSection() {
  const [asset, setAsset] = useState("BTC");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState("64000");
  const [size, setSize] = useState("1");
  const [leverage, setLeverage] = useState("5");
  const [thesis, setThesis] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [decision, setDecision] = useState<null | "reduced" | "proceeded" | "cancelled">(null);

  async function review() {
    setBusy(true);
    setResult(null);
    setDecision(null);
    try {
      const response = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset, direction, entry: Number(entry), size: Number(size),
          leverage: Number(leverage), riskPct: 1, thesis,
        }),
      });
      const body = await response.json();
      setResult(body);
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function onReduce() {
    // Halve the order. This lowers exposure but the setup (asset+direction)
    // is still the same losing cohort, so we do not re-show the identical
    // popup; we show a clean reduced state with the honest note.
    const half = Math.max(0.1, Number(size) / 2);
    setSize(String(half));
    setResult(null);
    setDecision("reduced");
  }

  return (
    <Reveal className="app-reveal">
      <section className="terminal" aria-labelledby="terminal-heading">
        <div className="panel-heading">
          <p className="section-kicker">Live trading terminal</p>
          <h2 id="terminal-heading">About to make a move? Check it with Deja first.</h2>
          <p>Set the trade you are considering. Deja compares it against your imported history and tells you if you have been here before.</p>
        </div>
        <div className="terminal-grid">
          <div className="terminal-form">
            <div className="form-grid">
              <div className="field"><label htmlFor="t-asset">Pair</label><input id="t-asset" value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="BTC" /></div>
              <div className="field"><label htmlFor="t-dir">Direction</label>
                <select id="t-dir" value={direction} onChange={(e) => setDirection(e.target.value as "long" | "short")}>
                  <option value="long">Long</option><option value="short">Short</option>
                </select></div>
              <div className="field"><label htmlFor="t-size">Size</label><input id="t-size" type="number" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} /></div>
              <div className="field"><label htmlFor="t-entry">Entry</label><input id="t-entry" type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /><p className="field-help">Current market price where available.</p></div>
              <div className="field"><label htmlFor="t-leverage">Leverage</label><input id="t-leverage" type="number" inputMode="decimal" value={leverage} onChange={(e) => setLeverage(e.target.value)} /></div>
            </div>
            <div className="field thesis-field">
              <label htmlFor="t-thesis">Why are you taking this trade?</label>
              <textarea id="t-thesis" rows={3} value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="One sentence is enough." />
            </div>
            <div className="form-actions">
              <button className="primary-button" type="button" onClick={review} disabled={busy || !thesis.trim() || !Number(entry)}>
                {busy ? "Checking…" : "Review with Deja"}
              </button>
              <p className="field-help">Execution stays paper until a real broker is wired; Deja surfaces the pattern before any order.</p>
            </div>
          </div>

          <div className="terminal-result" aria-live="polite">
            {!result ? (
              <div className="empty-state">
                <div className="empty-index">?</div>
                <div><h3>No review yet</h3><p>Configure a trade and press Review with Deja to see whether your own history flags a pattern.</p></div>
              </div>
            ) : result.decision === "deja_vu" && result.pattern ? (
              <div className="deja-you">
                <span className="deja-badge">{result.pattern.title}</span>
                <h3>{result.pattern.summary}</h3>
                <p>{result.pattern.losses} of {result.pattern.n} similar {asset} {direction}s went against you.</p>
                <div className="deja-actions">
                  <button className="primary-button" type="button" onClick={onReduce}>Reduce position</button>
                  <button className="secondary-button" type="button" onClick={() => setDecision("proceeded")}>Proceed anyway</button>
                  <button className="text-button" type="button" onClick={() => { setResult(null); setDecision(null); setThesis(""); }}>Cancel trade</button>
                </div>
              </div>
            ) : (
              <div className="deja-clear">
                <span className="deja-badge clear">No concerning pattern detected</span>
                <h3>Nothing like this in your history.</h3>
                <p>{result.similarTrades.length} comparable trade{result.similarTrades.length === 1 ? "" : "s"} found, none of them a clear losing habit.</p>
                <div className="deja-actions">
                  <button className="primary-button" type="button" onClick={() => setDecision("proceeded")}>Proceed</button>
                </div>
              </div>
            )}
            {decision ? (
              <div className="deja-outcome" aria-live="polite">
                <strong className={decision === "cancelled" ? "muted" : undefined}>
                  {decision === "reduced" ? "Order reduced and re-checked" : decision === "proceeded" ? "Decision recorded" : "Trade cancelled"}
                </strong>
                <p>Your choice ({decision.replace("ed", "")}) has been stored. This demo is paper-only: Deja will not place a real order until an exchange is wired and approved, then it routes through the same check first.</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </Reveal>
  );
}

function InsightsSection() {
  const [insights, setInsights] = useState<InsightsState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/insights", { cache: "no-store" });
        const body: unknown = await response.json();
        if (!cancelled) setInsights(interpretInsightsApiResponse(response.status, body));
      } catch {
        if (!cancelled) setInsights({ kind: "unavailable", message: "Insights could not be reached." });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="insights-panel" aria-labelledby="insights-heading">
      <div className="panel-heading">
        <p className="section-kicker">Trading DNA</p>
        <h2 id="insights-heading">Evidence from your paper decisions</h2>
        <p>Derived only from your stored, closed outcomes and warning observations. No statistic without its cohort size.</p>
      </div>

      {insights.kind === "loading" ? (
        <p className="field-help" aria-live="polite">Loading insights…</p>
      ) : insights.kind === "unavailable" ? (
        <div className="empty-state" aria-live="polite">
          <strong className="empty-index" aria-hidden="true">—</strong>
          <div>
            <h3>Insights unavailable</h3>
            <p>{insights.message}</p>
          </div>
        </div>
      ) : (
        <div className="insights-content">
          <section aria-label="Strategy evidence">
            <h4>Strategy DNA</h4>
            {insights.insights.dna.length === 0 ? (
              <p className="field-help">No sustained strategy cohort yet. Close paper trades to build evidence.</p>
            ) : (
              <DnaTable rows={insights.insights.dna} />
            )}
          </section>
          <section aria-label="Warning compliance self audit">
            <h4>Warning compliance ledger</h4>
            {insights.insights.warnings.length === 0 ? (
              <p className="field-help">No warnings shown against closed trades yet.</p>
            ) : (
              <WarningsTable rows={insights.insights.warnings} />
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function DnaTable({ rows }: { rows: DnaRow[] }) {
  return (
    <div className="insight-table" role="table" aria-label="Strategy DNA">
      {rows.map((row) => (
        <div className="insight-row" role="row" key={row.strategy ?? "__none__"}>
          <div role="cell" className="insight-cell">
            <strong>{row.strategy === null ? "No strategy" : titleCase(row.strategy ?? "")}</strong>
            <span className="tier-badge">{row.tier}</span>
          </div>
          <div role="cell" className="insight-cell">
            <span className="field-help">n={row.n}</span>
          </div>
          <div role="cell" className="insight-cell">
            {formatEvidenceRate(row) ?? <span className="field-help">{row.caveat}</span>}
          </div>
          <div role="cell" className="insight-cell">
            avg {renderR(row.averageR)}
          </div>
        </div>
      ))}
    </div>
  );
}

function WarningsTable({ rows }: { rows: WarningLedgerRow[] }) {
  return (
    <div className="insight-table" role="table" aria-label="Warning compliance">
      {rows.map((row) => (
        <div className="insight-row" role="row" key={row.code}>
          <div role="cell" className="insight-cell">
            <strong>{row.code}</strong>
          </div>
          <div role="cell" className="insight-cell">
            <span className="field-help">shown {row.shown}</span>
          </div>
          <div role="cell" className="insight-cell">
            <span className="field-help">defied {row.defied}</span>
          </div>
          <div role="cell" className="insight-cell">
            <span className="field-help">{row.defiedWithWin} win / {row.defiedWithLoss} loss</span>
          </div>
        </div>
      ))}
    </div>
  );
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

function UnavailableWorkspace({ message, onExample }: { message: string; onExample: () => void }) {
  const view = getWorkspaceView("unavailable");
  return (
    <div className="unavailable-state" role="alert">
      <div className="result-heading">
        <DecisionMark decision="BLOCK" />
        <span className="source-label">SERVER UNAVAILABLE</span>
      </div>
      <h2>{view.title}</h2>
      <p>{message}</p>
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
  const [submission, setSubmission] = useState<IntentSubmissionState>({ kind: "empty" });
  const [tradeFlow, setTradeFlow] = useState<TradeFlowState>({ kind: "idle" });
  const [defiedWarnings, setDefiedWarnings] = useState<WarningCode[]>([]);
  const [exitFill, setExitFill] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);

  function update<K extends keyof IntentDraft>(field: K, value: IntentDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function submitIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = getIntentErrors(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setSubmission({ kind: "empty" });
      const first = Object.keys(nextErrors)[0];
      document.getElementById(first)?.focus();
      return;
    }

    setSubmission({ kind: "loading" });
    try {
      const response = await fetch("/api/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toTradeIntentInput(draft)),
      });
      const body: unknown = await response.json();
      setSubmission(interpretIntentApiResponse(response.status, body));
    } catch {
      setSubmission({
        kind: "unavailable",
        message: "The decision service could not be reached.",
      });
    }
  }

  function toggleWarning(code: WarningCode) {
    setDefiedWarnings((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  }

  async function executeTrade() {
    if (submission.kind !== "result") return;
    const shown = warningsShownFromResult(submission.result);
    setCloseError(null);
    setTradeFlow({ kind: "executing" });
    try {
      const response = await fetch("/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildExecutePayload(toTradeIntentInput(draft), shown, defiedWarnings)),
      });
      const body: unknown = await response.json();
      const outcome = interpretTradeApiResponse(response.status, body);
      if (outcome.kind === "executed") {
        setDefiedWarnings([]);
        setTradeFlow({ kind: "open", execution: outcome.executed });
      } else if (outcome.kind === "blocked") {
        setTradeFlow({ kind: "blocked", message: outcome.message });
      } else if (outcome.kind === "validation_error") {
        setTradeFlow({ kind: "validation_error", message: outcome.message });
      } else {
        setTradeFlow({ kind: "unavailable", message: outcome.message });
      }
    } catch {
      setTradeFlow({ kind: "unavailable", message: "The paper trade service could not be reached." });
    }
  }

  async function submitClose() {
    if (tradeFlow.kind !== "open" && tradeFlow.kind !== "close_error") return;
    const execution = tradeFlow.execution;
    let payload: { tradeId: string; exitFill: number };
    try {
      payload = buildClosePayload(execution.trade.id, exitFill);
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : "Enter a valid exit fill.");
      return;
    }
    setCloseError(null);
    setTradeFlow({ kind: "closing", execution });
    try {
      const response = await fetch("/api/trades/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      const outcome = interpretCloseApiResponse(response.status, body);
      if (outcome.kind === "closed") {
        setTradeFlow({ kind: "closed", closed: outcome.closed });
      } else {
        setTradeFlow({ kind: "close_error", execution, message: outcome.message });
      }
    } catch {
      setTradeFlow({ kind: "close_error", execution, message: "The close service could not be reached." });
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="wordmark">deja</span>
          <span className="product-label">Paper decision memory</span>
        </div>
        <div className="mode-note">
          <span>Paper simulator</span>
          <span>No real orders · no real capital</span>
        </div>
      </header>

      <Reveal className="app-reveal">
        <section className="hero" aria-labelledby="hero-title">
          <p className="hero-kicker">A trader’s decision memory</p>
          <h1 id="hero-title">Pause before the trade. Remember how it went.</h1>
          <p className="hero-lead">
            Deja is a paper-trading workspace. You state a setup you’re considering, it checks your
            personal rules and comparable history, gives you a clear BLOCK, WARN, or PASS, then
            remembers the simulated outcome so your next decision is grounded in what actually happened.
          </p>
          <div className="hero-steps" aria-label="How Deja works">
            <div className="step-card"><strong>You’re considering a trade</strong><span>Asset, direction, and one line on why you are taking it.</span></div>
            <div className="step-card"><strong>Deja checks it</strong><span>Your own rules and comparable outcomes, fast, no essay.</span></div>
            <div className="step-card"><strong>Simulate it</strong><span>Paper fill and close, logged to your Trading DNA.</span></div>
          </div>
          <p className="hero-note">Paper simulator. Real orders are never routed and no real capital is at risk.</p>
        </section>
      </Reveal>

      <div className="workspace-grid">
        <section className="intent-panel" aria-labelledby="intent-heading">
          <div className="panel-heading">
            <p className="section-kicker">New intent</p>
            <h1 id="intent-heading">What are you setting up?</h1>
            <p>Fill in the setup and thesis. Deja checks your rules and comparable decisions before any paper action.</p>
          </div>

          <form onSubmit={submitIntent} noValidate>
            <fieldset>
              <legend className="sr-only">Paper-trade intent details</legend>
              <div className="form-grid">
                <div className="field asset-field">
                  <label htmlFor="asset">Asset</label>
                  <input id="asset" name="asset" value={draft.asset} onChange={(event) => update("asset", event.target.value)} placeholder="BTC" autoCapitalize="characters" aria-invalid={Boolean(errors.asset)} aria-describedby={errors.asset ? "asset-error" : undefined} />
                  {errors.asset ? <p className="field-error" id="asset-error">{errors.asset}</p> : null}
                </div>

                <SelectField id="direction" label="Direction" value={draft.direction} options={FIELD_OPTIONS.direction} onChange={(value) => update("direction", value as IntentDraft["direction"])} />
                <NumberField id="entry" label="Entry" value={draft.entry} onChange={(value) => update("entry", value)} error={errors.entry} helper="Your intended price. More options are below." />
                <NumberField id="riskPct" label="Risk %" value={draft.riskPct} onChange={(value) => update("riskPct", value)} error={errors.riskPct} helper="Percent of paper account at risk." />

                <details className="advanced">
                  <summary>More trade options</summary>
                  <div className="form-grid advanced-grid">
                    <div className="field">
                      <label htmlFor="assetClass">Asset class</label>
                      <input id="assetClass" name="assetClass" value={draft.assetClass} onChange={(event) => update("assetClass", event.target.value)} placeholder="crypto" aria-invalid={Boolean(errors.assetClass)} aria-describedby={errors.assetClass ? "assetClass-error" : undefined} />
                      {errors.assetClass ? <p className="field-error" id="assetClass-error">{errors.assetClass}</p> : null}
                    </div>
                    <NumberField id="size" label="Position size" value={draft.size} onChange={(value) => update("size", value)} error={errors.size} helper="Paper position units." />
                    <NumberField id="stopLoss" label="Stop loss" value={draft.stopLoss} onChange={(value) => update("stopLoss", value)} error={errors.stopLoss} optional />
                    <NumberField id="takeProfit" label="Take profit" value={draft.takeProfit} onChange={(value) => update("takeProfit", value)} error={errors.takeProfit} optional />
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
                  </div>
                </details>

                <div className="field thesis-field">
                  <label htmlFor="thesisRaw">Why this trade</label>
                  <textarea id="thesisRaw" name="thesisRaw" rows={4} value={draft.thesisRaw} onChange={(event) => update("thesisRaw", event.target.value)} aria-label="Thesis" placeholder="Why are you taking this trade?" aria-invalid={Boolean(errors.thesisRaw)} aria-describedby={errors.thesisRaw ? "thesisRaw-error" : "thesisRaw-help"} />
                  {errors.thesisRaw ? <p className="field-error" id="thesisRaw-error">{errors.thesisRaw}</p> : <p className="field-help" id="thesisRaw-help">Required. One sentence is enough - Deja keeps it attached to the outcome.</p>}
                </div>
              </div>
            </fieldset>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={submission.kind === "loading"}>
                {submission.kind === "loading" ? "Checking intent…" : "Check paper intent"}
              </button>
              <p className="field-help auth-note">Signed in as a single server-bound account. Multi-user login is the next milestone; nothing in this form ever chooses who you are.</p>
            </div>
          </form>
        </section>

        <aside className="result-panel" aria-label="Decision result workspace">
          <div className="result-panel-header">
            <span>Decision workspace</span>
            <span aria-live="polite">
              {submission.kind === "example" ? "Fixture preview" : submission.kind === "degraded" ? "Fixture degraded" : titleCase(submission.kind)}
            </span>
          </div>
          <div className="result-panel-body">
            {submission.kind === "empty" ? <EmptyWorkspace /> : null}
            {submission.kind === "loading" ? <LoadingWorkspace /> : null}
            {submission.kind === "result" ? (
              <>
                <LiveWorkspace result={submission.result} />
                <TradeFlowSection
                  result={submission.result}
                  flow={tradeFlow}
                  defied={defiedWarnings}
                  onToggleWarning={toggleWarning}
                  onExecute={executeTrade}
                  onClose={submitClose}
                  exitFill={exitFill}
                  onExitFillChange={setExitFill}
                  closeError={closeError}
                />
              </>
            ) : null}
            {submission.kind === "validation_error" ? <ValidationWorkspace message={submission.message} /> : null}
            {submission.kind === "unavailable" ? (
              <UnavailableWorkspace
                message={submission.message}
                onExample={() => setSubmission({ kind: "example" })}
              />
            ) : null}
            {submission.kind === "example" ? (
              <ExampleWorkspace onDegraded={() => setSubmission({ kind: "degraded" })} />
            ) : null}
            {submission.kind === "degraded" ? (
              <DegradedWorkspace onReturn={() => setSubmission({ kind: "example" })} />
            ) : null}
          </div>
        </aside>
      </div>

      <TerminalSection />

      <Reveal className="app-reveal"><InsightsSection /></Reveal>

      <footer className="footer-note">
        <p>Decision support for paper trading. Deja does not predict markets or route real orders.</p>
        <p>Example history is always labelled and never presented as live evidence.</p>
      </footer>
    </main>
  );
}
