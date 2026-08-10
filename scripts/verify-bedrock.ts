/**
 * Phase 0 exit criterion: both Bedrock models round-trip.
 *
 * Run this before writing any feature code. An un-enabled model or a wrong
 * region is the classic multi-day hackathon killer, and it is much cheaper to
 * discover here than three phases in.
 *
 *   npm run verify:bedrock
 */
import "dotenv/config";
import { chat, embed } from "../src/lib/bedrock";
import { env } from "../src/lib/env";

function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function explain(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);

  if (name === "AccessDeniedException" || /access|not authoriz/i.test(msg)) {
    return (
      `${msg}\n` +
      `    → The model is not available to this account in this region.\n` +
      `      Bedrock console → Model catalog → confirm the model shows "Serverless",\n` +
      `      and check the region selector matches AWS_REGION.`
    );
  }
  if (name === "ValidationException") {
    return (
      `${msg}\n` +
      `    → Usually a bad model id. Cross-region models need the "us." prefix\n` +
      `      (an inference profile id), not the bare model id.`
    );
  }
  if (name === "ThrottlingException") {
    return `${msg}\n    → Rate limited. Retry; check Bedrock → Quotas if it persists.`;
  }
  if (/UnrecognizedClient|InvalidSignature|security token/i.test(msg)) {
    return `${msg}\n    → Credentials rejected. Re-check AWS_BEARER_TOKEN_BEDROCK.`;
  }
  return msg;
}

async function main() {
  const e = env();
  console.log(`\nBedrock check — region ${e.AWS_REGION}\n`);
  let failures = 0;

  const auth = e.AWS_BEARER_TOKEN_BEDROCK ? "bearer token" : "IAM keypair";
  ok(`credentials present (${auth})`);

  // --- fast tier ---
  try {
    const r = await chat({
      tier: "fast",
      messages: [{ role: "user", content: [{ text: "Reply with the single word: ready" }] }],
      maxTokens: 16,
    });
    ok(`fast model  ${e.BEDROCK_MODEL_FAST}\n      → "${r.text}" (${r.inputTokens}in/${r.outputTokens}out)`);
  } catch (err) {
    failures++;
    fail(`fast model  ${e.BEDROCK_MODEL_FAST}\n    ${explain(err)}`);
  }

  // --- reasoning tier ---
  try {
    const r = await chat({
      tier: "reasoning",
      messages: [{ role: "user", content: [{ text: "Reply with the single word: ready" }] }],
      maxTokens: 16,
    });
    ok(`reasoning model  ${e.BEDROCK_MODEL_REASONING}\n      → "${r.text}" (${r.inputTokens}in/${r.outputTokens}out)`);
  } catch (err) {
    failures++;
    fail(`reasoning model  ${e.BEDROCK_MODEL_REASONING}\n    ${explain(err)}`);
  }

  // --- embeddings ---
  // Also sanity-checks that the model encodes *situation* rather than
  // vocabulary: the paraphrase must land closer than the unrelated trade.
  try {
    const [a, b, c] = await Promise.all([
      embed("breakout above resistance, retested and held, volume rising"),
      embed("price reclaimed the prior range high and flipped it to support"),
      embed("sold into exhaustion after a parabolic move on low volume"),
    ]);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    const near = cos(a, b);
    const far = cos(a, c);

    ok(`embeddings  ${e.BEDROCK_MODEL_EMBED} (${a.length} dims)`);
    if (near > far) {
      ok(`semantic sanity: paraphrase ${near.toFixed(3)} > unrelated ${far.toFixed(3)}`);
    } else {
      failures++;
      fail(
        `semantic sanity FAILED: paraphrase ${near.toFixed(3)} <= unrelated ${far.toFixed(3)}\n` +
          `    → Retrieval would be matching vocabulary, not situation.`,
      );
    }
  } catch (err) {
    failures++;
    fail(`embeddings  ${e.BEDROCK_MODEL_EMBED}\n    ${explain(err)}`);
  }

  console.log(
    failures === 0
      ? "\n\x1b[32mBedrock ready.\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n\x1b[31mUnexpected failure\x1b[0m\n", err);
  process.exit(1);
});
