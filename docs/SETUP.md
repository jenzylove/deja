# Deja — Local Setup

## Prerequisites
- Node 24+ / npm 11+
- AWS account with Bedrock model access (see below)
- CockroachDB Cloud account

## 1. AWS Bedrock model access

Bedrock model access is granted **per region**. Use `us-east-1` for everything so nothing
mismatches between the embedding model and the chat model.

1. AWS Console → **Bedrock** → set region to **us-east-1**
2. Left sidebar → **Model access** → *Modify model access*
3. Enable:
   - **Anthropic — Claude Sonnet** (brief generation, rule compilation)
   - **Anthropic — Claude Haiku** (thesis canonicalization — high volume, cheap)
   - **Amazon — Titan Text Embeddings V2** (1024-dim embeddings)
4. Anthropic models require a short use-case form. One or two sentences is enough.
   Titan grants instantly; Anthropic is usually a few minutes.
5. IAM → create a user with `AmazonBedrockFullAccess` → create an access key.

Verify with:
```bash
npm run verify:bedrock
```

## 2. CockroachDB Cloud

The cluster is provisioned via the **ccloud CLI**, scripted in `infra/provision.sh` so the
setup is reproducible rather than click-configured.

```bash
ccloud auth login
bash infra/provision.sh
```

This creates a serverless cluster, a SQL user, and prints the connection string. It also
creates the read-only role that the MCP server uses — the agent must never be able to write
memory or read another tenant.

`ccloud` is installed at `~/bin/ccloud.exe` and `~/bin` is on the user PATH.

## 3. Environment

Copy `.env.example` to `.env.local` and fill it in. `.env.local` is gitignored and must never
be committed.

## 4. Run

```bash
npm install
npm run db:push       # apply schema
npm run verify:all    # bedrock + database + vector index round-trip
npm run dev
```
