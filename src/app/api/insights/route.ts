import { createInsightsHandler } from "@/lib/insights-route";
import { paperApp } from "@/lib/paper-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createInsightsHandler({
  resolveActor: paperApp.resolveActor,
  store: paperApp.store,
});