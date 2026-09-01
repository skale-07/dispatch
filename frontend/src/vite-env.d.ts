/// <reference types="vite/client" />

/**
 * Build-time env the app may read (all optional — every consumer is
 * fail-closed; see lib/appConfig.ts). Declaring them keeps a typo'd
 * env name from silently reading undefined.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CONSOLE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
