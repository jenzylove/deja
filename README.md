# Deja

> *You've been here before.*

A decision-memory layer for traders. Deja sits between trade intent and execution: before a
trade goes through, you state why you're taking it, and the agent retrieves your own history —
past theses, outcomes, behavioral patterns and explicit rules — to tell you what happened the
previous times you traded for reasons like this.

It does not predict the market. It remembers you.

**Three things make it different:**

1. **Memory that gates action.** Most agentic-memory systems use memory as read-only context.
   Here a retrieved rule can prevent a trade from executing at all.
2. **The agent audits itself.** Every warning is typed and logged with whether you obeyed it and
   what happened — so Deja can prove whether it has actually helped you, or admit that it hasn't.
3. **It's honest about how little it knows.** No statistic is shown without `n`. Below eight
   comparable trades it refuses to give you a percentage and shows you the raw episodes instead.

Built for the CockroachDB × AWS Hackathon — Build with Agentic Memory.

- [PRD](docs/PRD.md)
- [Roadmap](docs/ROADMAP.md)

---

Paper trading only. No custody, no order routing. Nothing here is financial advice.
