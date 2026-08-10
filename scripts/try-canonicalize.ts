import "./load-env";
import { canonicalizeThesis } from "../src/lib/canonicalize";
import { embed } from "../src/lib/bedrock";

const cases = [
  "BTC broke resistance around 68,400 and came back for the retest. Volume increased on the breakout and the retest appears to be holding. Looking for continuation.",
  "price reclaimed the previous range high and is holding it as support now, want continuation higher",
  "sold into exhaustion after a parabolic move, volume dried up, expecting a pullback",
];

async function main() {
  const out = [];
  for (const t of cases) {
    const c = await canonicalizeThesis({
      thesisRaw: t, direction: t.startsWith("sold") ? "short" : "long", assetClass: "crypto",
      regime: "trending", session: "ny",
    });
    console.log(`\n"${t.slice(0, 60)}..."`);
    console.log(`  strategy=${c.strategy} thesis=${c.marketThesis} confirmed=${c.confirmationStated}`);
    console.log(`  signals: ${c.signals.join(" | ")}`);
    console.log(`  canonical: ${c.canonical}`);
    out.push(c.canonical);
  }
  const vs = await Promise.all(out.map(embed));
  const cos = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  console.log(`\n  paraphrase pair (0 vs 1): ${cos(vs[0], vs[1]).toFixed(3)}`);
  console.log(`  unrelated pair  (0 vs 2): ${cos(vs[0], vs[2]).toFixed(3)}`);
}
main();
