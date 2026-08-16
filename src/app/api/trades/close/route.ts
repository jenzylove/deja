import { createTradeCloseHandler } from "@/lib/trade-route";
import { tradeRouteDependencies } from "@/lib/paper-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createTradeCloseHandler(tradeRouteDependencies());