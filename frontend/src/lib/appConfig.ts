/**
 * Which surface this build serves, decided by env at build time — the
 * same fail-closed posture as every backend flag in this repo.
 *
 * PUBLIC (default): the consumer web app. No localhost assumptions, no
 * boot tokens, no console pages in the route table, and signup renders
 * disabled-with-a-reason until Supabase is configured.
 *
 * CONSOLE (VITE_CONSOLE_ENABLED="true", operator's local build only):
 * exactly the internal operator console this frontend always was. The
 * public app never links to it, and a public deploy — which does not set
 * the flag — never mounts it.
 */

export const CONSOLE_ENABLED =
  import.meta.env.VITE_CONSOLE_ENABLED === "true";

export const SUPABASE_URL: string | undefined = import.meta.env
  .VITE_SUPABASE_URL as string | undefined;

export const SUPABASE_ANON_KEY: string | undefined = import.meta.env
  .VITE_SUPABASE_ANON_KEY as string | undefined;

/** True only when both halves of the Supabase config are present. */
export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** The one honest sentence shown wherever signup has to be disabled. */
export const SUPABASE_UNCONFIGURED_REASON =
  "Sign-up is not available in this build: the app was deployed without " +
  "its account service configured. Nothing is wrong with your invite.";
