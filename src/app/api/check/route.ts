import { createCheckHandler } from "@/lib/check-route";
import { paperApp } from "@/lib/paper-app";
import type { CockroachPaperStore } from "@/lib/paper-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-trade Déjà vu check. In the live deployment the shared store is the
// Cockroach-backed adapter (has imported history).
export const POST = createCheckHandler({
  resolveActor: paperApp.resolveActor,
  store: paperApp.store as unknown as CockroachPaperStore,
});