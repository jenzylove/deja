import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredActor } from "../src/lib/server-actor";

const USER_ID = "11111111-1111-4111-8111-111111111111";

test("configured single-tenant actor resolution is server-only and fail-closed", async () => {
  assert.equal(await resolveConfiguredActor({}), null);
  assert.equal(
    await resolveConfiguredActor({ DEJA_ACTOR_MODE: "configured-single-tenant", DEJA_ACTOR_USER_ID: "not-a-uuid" }),
    null,
  );
  assert.equal(
    await resolveConfiguredActor({ DEJA_ACTOR_MODE: "unknown", DEJA_ACTOR_USER_ID: USER_ID }),
    null,
  );
  assert.deepEqual(
    await resolveConfiguredActor({
      DEJA_ACTOR_MODE: "configured-single-tenant",
      DEJA_ACTOR_USER_ID: USER_ID,
    }),
    { userId: USER_ID },
  );
});
