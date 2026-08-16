import {
  createTradeExecuteHandler,
  createTradeListHandler,
} from "@/lib/trade-route";
import { tradeRouteDependencies } from "@/lib/paper-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createTradeExecuteHandler(tradeRouteDependencies());
export const GET = createTradeListHandler(tradeRouteDependencies());