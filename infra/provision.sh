#!/usr/bin/env bash
# Deja — CockroachDB Cloud provisioning via ccloud CLI.
#
# Scripted rather than click-configured so the cluster is reproducible and the
# security posture is reviewable in version control. Run:
#
#   ccloud auth login
#   bash infra/provision.sh
#
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-deja}"
CLOUD="${CLOUD:-AWS}"
REGION="${REGION:-eu-west-1}"   # match AWS_REGION so app→db latency stays low
DB_NAME="deja"
APP_USER="deja_app"
RO_USER="deja_agent_ro"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need ccloud

echo "==> Checking auth"
ccloud auth whoami >/dev/null 2>&1 || { echo "Run: ccloud auth login" >&2; exit 1; }

echo "==> Creating cluster '$CLUSTER_NAME' ($CLOUD/$REGION)"
if ccloud cluster list --output json | grep -q "\"name\": *\"$CLUSTER_NAME\""; then
  echo "    cluster already exists, reusing"
else
  ccloud cluster create serverless "$CLUSTER_NAME" --cloud "$CLOUD" --region "$REGION"
fi

CLUSTER_ID="$(ccloud cluster list --output json \
  | python -c "import sys,json;print(next(c['id'] for c in json.load(sys.stdin) if c['name']=='$CLUSTER_NAME'))")"
echo "    cluster id: $CLUSTER_ID"

echo "==> Creating SQL user '$APP_USER'"
ccloud cluster user create "$CLUSTER_ID" "$APP_USER" || echo "    exists, skipping"

echo "==> Connection string"
ccloud cluster sql "$CLUSTER_ID" --print-url || true

cat <<'NOTE'

==> Next steps

1. Put the printed URL into DATABASE_URL in .env.local (append /deja and
   sslmode=verify-full).

2. Apply the schema:
       npm run db:push

3. Create the read-only role the MCP server uses. This is a security boundary,
   not a convenience — the agent must be unable to write memory or read across
   tenants. Run against the cluster:

       CREATE USER deja_agent_ro WITH PASSWORD '<strong-password>';
       GRANT CONNECT ON DATABASE deja TO deja_agent_ro;
       GRANT USAGE ON SCHEMA public TO deja_agent_ro;
       GRANT SELECT ON ALL TABLES IN SCHEMA public TO deja_agent_ro;
       ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT ON TABLES TO deja_agent_ro;

   Then set DATABASE_URL_READONLY in .env.local.

4. Verify the vector index round-trips:
       npm run verify:db

NOTE
