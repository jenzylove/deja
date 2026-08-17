# Deja — Exchange Integration & Live Trade Memory (PRD)

> Upgrades Deja from a manually populated trading journal into a live trading
> memory layer. The user should not need to manually document every trade.

## 1. Objective
Connect exchange -> import history -> build Trading DNA -> initiate new trade ->
Deja checks memory -> intervene if necessary -> execute trade -> automatically
save outcome as new memory. The key product moment happens **before** execution.

## 2. Core product principle
Deja answers: *"Have I done something like this before, and what happened?"*
Every new trade is compared against the trader's own historical behaviour before
execution. Historical trades give immediate context; new trades continually
expand that memory.

## 3. Onboarding
1. **Connect Exchange** — MVP: one exchange. Needs: import historical trades,
   retrieve order/position info, retrieve current prices, submit a trade, track
   the resulting position. Use **testnet / sandbox** for the hackathon demo. Do
   not build a complete exchange.
2. **Import Trading History** — automatically retrieve recent history, store
   normalized trade records in CockroachDB. Fields (as provided): asset/pair,
   long/short, entry, exit, size, leverage, stop, take, entry/exit timestamps,
   P&L, fees, order type, status. Users do NOT manually recreate trades.
3. **Build Trading DNA** — analyze history into an initial behavioural profile,
   evolving as trades complete. (e.g. "68% of BTC trades opened shortly after a
   loss were unprofitable", "win rate falls when leverage > 10x", "profitable
   ETH trades risk < 2%", "frequently increases size after consecutive losses".)

## 4. Live trading terminal
Lightweight interface (not a full exchange). Fields: pair, long/short,
market/limit, entry (where applicable), size, leverage (where applicable), stop,
take. Current asset price fetched automatically.

## 5. Trade thesis
One short required input before review: *"Why are you taking this trade?"*
Deliberately lightweight. Thesis becomes part of trade memory, enabling BOTH
quantitative and semantic (embedding) similarity. Generate an embedding for the
thesis and store it with the trade.

## 6. Pre-trade Deja check
The trade must NOT execute immediately on submit. Pipeline:

```
Proposed trade -> create trade representation -> search CockroachDB memory
-> vector-search similar theses -> retrieve behavioural patterns -> agent
evaluates -> generate intervention -> user decision -> exchange execution
```

## 7. Similarity retrieval
- **Structured**: same asset, same direction, similar leverage/sizing/stop/risk,
  timing, prior outcome, win/loss streak.
- **Semantic**: vector search against historical theses (different wording,
  same meaning). CockroachDB stays central.

## 8. Deja intervention
Do not warn on every trade. If nothing significant: "No concerning pattern
detected", trader continues. If a meaningful pattern exists, show a prominent
**Déjà vu detected** with specifics (e.g. "6 similar BTC trades, 4 unprofitable,
3 losses entered shortly after another losing BTC trade, size is 1.8x normal")
and clear actions: Proceed anyway / Reduce position / Cancel.

## 9. Execution
Only after the check is the trade submitted to the connected exchange.
Proceed = execute original; Reduce = update order and re-review; Cancel = discard.
Store the Deja recommendation and the user's final decision.

## 10. Automatic memory creation
Once a trade executes, automatically create its memory record: original
parameters, thesis, retrieved similar memories, Deja warning/recommendation, user
decision, exchange order ID, execution info. On close, update with exit, P&L,
duration, outcome, whether the warning was followed, behavioural info. Completed
trade becomes available to future retrieval. Core feedback loop:
`past trades -> current decision -> intervention -> execution -> outcome -> new memory -> future decisions`.

## 11. Trading DNA updates
Update DNA after completed trades only when enough evidence exists (no
conclusions from one trade). Patterns: revenge trading, oversizing after losses,
excessive leverage, repeated failed setups, poor performance on specific assets,
stop-loss behaviour, strong setups, successful risk ranges, time-based patterns,
thesis patterns correlated with wins/losses. DNA contains BOTH negative and
positive patterns ("8 trades resembling this setup, 6 profitable, avg R:R 2.3").

## 12. Existing manual flow
Keep it, repositioned as "Add Trade Manually" for unsupported exchanges,
unimportable history, paper trades, missing data. No longer the primary workflow.

## 13. Primary UX
Connect Exchange -> Import History -> Generate Trading DNA -> Open Deja Terminal
-> Configure Trade -> Write One-Sentence Thesis -> Review With Deja -> Historical
Memory Retrieval -> Déjà Vu Check -> Proceed / Modify / Cancel -> Execute ->
Automatically Record Outcome -> Update Trading DNA.

## 14. Demo scenario (primary hackathon demo)
Seed/import enough history for an obvious pattern: trader repeatedly loses BTC
longs taken immediately after being stopped out. Demo: connect account -> import
history -> DNA identifies pattern -> open terminal -> propose BTC long -> thesis
"BTC bounced from support. Looking for continuation." -> Review with Deja ->
retrieves similar history -> "Déjà vu detected: 6 similar BTC trades, 4 lost, 3
losses were re-entries shortly after a stopped trade" -> user picks Reduce ->
order updated -> confirm -> executes via exchange -> Deja auto-stores trade +
intervention as memory.

## 15. Product boundary
NOT: a full exchange, generic AI trading bot, signal generator, portfolio
dashboard, generic journal, or a system that autonomously decides what to buy.
Deja does not predict the market; its intelligence comes from understanding the
trader. Exchange handles execution; Deja handles memory, pattern recognition,
and intervention before execution.

> **Final product definition**: Deja is a trading memory agent that learns from
> your historical behaviour and brings those memories back at the exact moment
> you are about to make the same decision again.
