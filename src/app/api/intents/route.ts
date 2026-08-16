import {
  createIntentPostHandler,
  productionIntentRouteDependencies,
} from "@/lib/intent-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createIntentPostHandler(productionIntentRouteDependencies);
