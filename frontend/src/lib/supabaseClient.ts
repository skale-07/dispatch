import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_CONFIGURED,
  SUPABASE_URL,
} from "./appConfig";

/**
 * The one seam to Supabase. Everything auth- or data-shaped in the
 * public app goes through this client; nothing else in the codebase may
 * call createClient.
 *
 * Fail-closed like every capability in this repo: an unconfigured build
 * exports null, and every consumer must handle that by rendering the
 * disabled state with the reason — never by throwing at module load,
 * which would take down the landing page a signup-less build can still
 * serve perfectly well.
 *
 * The anon key is the PUBLIC client key by design (row-level security on
 * the launcher-owned schema is what protects data); it is still supplied
 * by env at build time, never committed.
 */
export const supabase: SupabaseClient | null = SUPABASE_CONFIGURED
  ? createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        // Magic-link sign-in returns to the app with tokens in the URL
        // fragment; the client stores the session and strips the hash.
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;
