#!/usr/bin/env node
import { getConfig } from "../config/index.js";
import { SIGNAL_KEY_RE, SUGGESTION_STORES } from "./fieldSignalKeys.js";
import { makeSyncClient } from "./syncSupabase.js";

/**
 * Admin pins for the suggestion ranker (plan v0.5, M21):
 *
 *   npm run cloud:field-pins -- list
 *   npm run cloud:field-pins -- add --key <signal_key> --store <store> [--target-key <k>] --reason "<why>" [--priority 1-10]
 *   npm run cloud:field-pins -- disable --key <signal_key>
 *
 * Service role, behind SUPABASE_SYNC_ENABLED (a pin is a cloud mutation).
 * A pin says "surface this question to everyone, here is where the answer
 * lives" — it never carries an answer. Keys must match the signal-key
 * vocabulary; stores must be one of the suggestion stores the SPA knows.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const config = getConfig();
  if (!config.supabaseSyncEnabled) {
    throw new Error("SUPABASE_SYNC_ENABLED is false (fail-closed default) — field pins are a cloud write.");
  }
  const client = await makeSyncClient(config);

  if (cmd === "list") {
    const { data, error } = await client.from("admin_field_pins").select("signal_key, target, reason, priority, active, updated_at").order("priority", { ascending: false });
    if (error) throw new Error(`admin_field_pins select failed: ${error.message}`);
    console.log(JSON.stringify(data ?? [], null, 2));
    return;
  }

  const key = arg("--key")?.trim() ?? "";
  if (!SIGNAL_KEY_RE.test(key)) throw new Error(`--key must match ${SIGNAL_KEY_RE} (got "${key}")`);

  if (cmd === "add") {
    const store = arg("--store")?.trim() ?? "";
    if (!(SUGGESTION_STORES as readonly string[]).includes(store)) {
      throw new Error(`--store must be one of ${SUGGESTION_STORES.join(", ")} (got "${store}")`);
    }
    const reason = arg("--reason")?.trim() ?? "";
    if (reason.length < 1 || reason.length > 300) throw new Error("--reason is required (1–300 chars)");
    const priorityRaw = arg("--priority");
    const priority = priorityRaw === undefined ? 5 : Number(priorityRaw);
    if (!Number.isInteger(priority) || priority < 1 || priority > 10) throw new Error("--priority must be an integer 1–10");
    const targetKey = arg("--target-key")?.trim();
    const target: Record<string, unknown> = { store, ...(targetKey ? { key: targetKey } : {}) };
    const { error } = await client
      .from("admin_field_pins")
      .upsert({ signal_key: key, target, reason, priority, active: true }, { onConflict: "signal_key" });
    if (error) throw new Error(`admin_field_pins upsert failed: ${error.message}`);
    console.log(JSON.stringify({ pinned: key, target, priority }, null, 2));
    return;
  }

  if (cmd === "disable") {
    const { error } = await client.from("admin_field_pins").update({ active: false }).eq("signal_key", key);
    if (error) throw new Error(`admin_field_pins update failed: ${error.message}`);
    console.log(JSON.stringify({ disabled: key }, null, 2));
    return;
  }

  console.error("usage: cloud:field-pins <list|add|disable> [--key <signal_key>] [--store <store>] [--target-key <k>] [--reason <why>] [--priority 1-10]");
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
