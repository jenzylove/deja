/**
 * Titan v2 vs Cohere embed v4 on the actual retrieval task.
 *
 * Naive top-k over the seeded corpus scored 33% strategy purity with Titan —
 * barely above the ~20% you get by chance, because every probe returned the
 * majority class. Retrieval quality is the core claim of this project, so the
 * model choice gets measured rather than assumed.
 *
 * Cohere v4 embeds queries and documents asymmetrically (search_query vs
 * search_document), which is the thing Titan has no equivalent for and the most
 * likely explanation for the gap.
 *
 *   npx tsx scripts/compare-embeddings.ts
 */
import "./load-env";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrock, embed } from "../src/lib/bedrock";
import { db } from "../src/lib/db";

const EMAIL = "demo@deja.app";

async function cohere(texts: string[], inputType: "search_query" | "search_document") {
  const res = await bedrock().send(
    new InvokeModelCommand({
      modelId: "cohere.embed-v4:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        texts,
        input_type: inputType,
        embedding_types: ["float"],
        output_dimension: 1024,
      }),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  return (parsed.embeddings?.float ?? parsed.embeddings) as number[][];
}

const PROBES = [
  {
    expect: "breakout_retest",
    text: "level flip; ceiling gave way then price came back and the old ceiling acted as a floor, participation picked up; expecting the move to extend",
  },
  {
    expect: "reversal",
    text: "fade; move went vertical then buyers disappeared and it printed a long upper shadow; expecting the trend to turn",
  },
  {
    expect: "range",
    text: "boundary trade; price sitting at the floor of a sideways band and refusing to break it; expecting a snap back to the middle",
  },
  {
    expect: "trend_pullback",
    text: "buying a dip inside an uptrend; price eased back into a rising average and found bids; expecting the uptrend to resume",
  },
  {
    expect: "momentum",
    text: "chasing strength; large impulsive candle with heavy participation out of a tight coil; expecting the thrust to carry",
  },
];

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

async function main() {
  const pool = db();
  const { rows } = await pool.query<{ strategy: string; thesis_canonical: string }>(
    `SELECT i.strategy, i.thesis_canonical
       FROM trade_intents i JOIN users u ON u.id = i.user_id
      WHERE u.email = $1 AND i.thesis_canonical IS NOT NULL`,
    [EMAIL],
  );
  console.log(`\nCorpus: ${rows.length} canonical theses`);
  const mix = rows.reduce<Record<string, number>>((m, r) => ((m[r.strategy] = (m[r.strategy] ?? 0) + 1), m), {});
  console.log(`Mix: ${Object.entries(mix).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const majority = Math.max(...Object.values(mix)) / rows.length;
  console.log(`Majority-class share: ${Math.round(majority * 100)}% — any model scoring near this is guessing\n`);

  const docs = rows.map((r) => r.thesis_canonical);

  async function score(name: string, docVecs: number[][], queryVecs: number[][]) {
    let total = 0;
    console.log(`${name}`);
    for (let p = 0; p < PROBES.length; p++) {
      const ranked = docVecs
        .map((v, i) => ({ s: cos(queryVecs[p], v), strategy: rows[i].strategy }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 8);
      const hits = ranked.filter((x) => x.strategy === PROBES[p].expect).length;
      total += hits / 8;
      const mark = hits >= 4 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`  ${mark} ${PROBES[p].expect.padEnd(16)} ${hits}/8  top=${ranked[0].s.toFixed(3)}  [${ranked.map((x) => x.strategy.slice(0, 5)).join(" ")}]`);
    }
    const avg = total / PROBES.length;
    console.log(`  → purity ${Math.round(avg * 100)}%\n`);
    return avg;
  }

  // Titan: one embedding space, no query/document distinction.
  const titanDocs: number[][] = [];
  for (let i = 0; i < docs.length; i += 3) {
    titanDocs.push(...(await Promise.all(docs.slice(i, i + 3).map((t) => embed(t)))));
  }
  const titanQ = [];
  for (const p of PROBES) titanQ.push(await embed(p.text));
  const titanScore = await score("Titan v2 (symmetric)", titanDocs, titanQ);

  // Cohere: asymmetric — documents and queries embedded differently.
  const cohereDocs: number[][] = [];
  for (let i = 0; i < docs.length; i += 90) {
    cohereDocs.push(...(await cohere(docs.slice(i, i + 90), "search_document")));
  }
  const cohereQ = await cohere(PROBES.map((p) => p.text), "search_query");
  const cohereScore = await score("Cohere embed v4 (asymmetric)", cohereDocs, cohereQ);

  console.log(
    `Verdict: ${cohereScore > titanScore ? "Cohere v4" : "Titan v2"} wins ` +
      `(${Math.round(cohereScore * 100)}% vs ${Math.round(titanScore * 100)}%), ` +
      `chance is ~${Math.round((1 / 5) * 100)}%\n`,
  );
  await pool.end();
}

main().catch((e) => { console.error("\nFailed:", (e as Error).message); process.exit(1); });
