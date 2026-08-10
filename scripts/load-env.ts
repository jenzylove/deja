/**
 * Next.js loads .env.local automatically; plain tsx scripts do not. Load the
 * same files, in the same precedence order, so a value that works in the app
 * works in the verification scripts too.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) config({ path, override: false, quiet: true });
}
