/**
 * Ask the account which models it can actually invoke in this region, instead
 * of guessing version strings. Inference profile ids are region-prefixed and
 * change over time, so this is the reliable way to populate .env.local.
 *
 *   npm run models
 */
import "./load-env";
import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { env } from "../src/lib/env";

async function main() {
  const e = env();
  const client = new BedrockClient({
    region: e.AWS_REGION,
    ...(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: e.AWS_ACCESS_KEY_ID,
            secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  console.log(`\nInference profiles in ${e.AWS_REGION} (use these ids):\n`);
  const profiles = await client.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
  const rows = (profiles.inferenceProfileSummaries ?? [])
    .filter((p) => /anthropic|claude/i.test(p.inferenceProfileId ?? ""))
    .sort((a, b) => (a.inferenceProfileId ?? "").localeCompare(b.inferenceProfileId ?? ""));

  if (rows.length === 0) {
    console.log("  (no Anthropic inference profiles found)");
  }
  for (const p of rows) {
    console.log(`  ${p.status === "ACTIVE" ? "●" : "○"} ${p.inferenceProfileId}`);
  }

  console.log(`\nEmbedding models in ${e.AWS_REGION}:\n`);
  const fm = await client.send(
    new ListFoundationModelsCommand({ byOutputModality: "EMBEDDING" }),
  );
  for (const m of fm.modelSummaries ?? []) {
    const onDemand = m.inferenceTypesSupported?.includes("ON_DEMAND") ? "●" : "○";
    console.log(`  ${onDemand} ${m.modelId}`);
  }
  console.log("\n● = usable on demand\n");
}

main().catch((err) => {
  console.error("\nFailed to list models:", (err as Error).message);
  console.error(
    "\nIf this is an access error, the Bedrock API key may not cover control-plane\n" +
      "calls. The Bedrock console → Model catalog shows the same information.\n",
  );
  process.exit(1);
});
