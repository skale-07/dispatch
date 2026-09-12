import { useCallback, useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

/** Quiet period after the last keystroke before an autosave. */
export const AUTOSAVE_DELAY_MS = 900;

/**
 * One onboarding step's form: react-hook-form validating on blur with the
 * step's STRICT schema, plus a debounced autosave gated by its LENIENT
 * schema (shape only), so a half-finished step still saves.
 *
 * Three rules keep answers from being lost or written out of order:
 * - Autosave fires only on a user edit (a watch event that names a
 *   field). A programmatic reset — the shell remounting a step after an
 *   import merge — names no field and never saves: an import is a draft
 *   the user reviews, not a write.
 * - Saves are serialized: a Next pressed during an autosave lands after
 *   it, never racing it to the row.
 * - Leaving the step goes through `flush()` (the shell's leave guard):
 *   a shape-invalid edit is SHOWN and the navigation refused rather than
 *   dropped. Unmounts that bypass the guard (browser back) still get a
 *   best-effort save when the shape is valid.
 *
 * Nothing retries: a failed save shows the server's own message and
 * waits for the next edit or Next.
 */
export function useStepForm<T extends FieldValues>(options: {
  lenient: z.ZodType<T, z.ZodTypeDef, T>;
  strict: z.ZodTypeAny;
  values: T;
  save: (values: T) => Promise<void>;
}): {
  form: UseFormReturn<T>;
  saveState: SaveState;
  /** Strict-validate, save, then run `after` (Next). */
  submit: (after: () => Promise<void>) => Promise<void>;
  /** Save now if the shape is valid; otherwise show the errors and return false. */
  flush: () => Promise<boolean>;
} {
  const form = useForm<T>({
    resolver: zodResolver(options.strict) as unknown as Resolver<T>,
    defaultValues: options.values as DefaultValues<T>,
    mode: "onBlur",
  });
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const latest = useRef(options);
  latest.current = options;
  const timer = useRef<number | null>(null);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const setState = useCallback((s: SaveState): void => {
    if (mounted.current) setSaveState(s);
  }, []);

  const save = useCallback(
    async (values: T): Promise<boolean> => {
      const run = inflight.current.then(async () => {
        setState({ kind: "saving" });
        await latest.current.save(values);
      });
      inflight.current = run.catch(() => undefined);
      try {
        await run;
        setState({ kind: "saved", at: new Date() });
        return true;
      } catch (err) {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
    [setState],
  );

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flushInner = useCallback(
    async (showErrors: boolean): Promise<boolean> => {
      clearTimer();
      const parsed = latest.current.lenient.safeParse(form.getValues());
      if (!parsed.success) {
        setState({ kind: "invalid" });
        if (showErrors) await form.trigger();
        return false;
      }
      return save(parsed.data);
    },
    [form, save, setState],
  );

  const flush = useCallback((): Promise<boolean> => flushInner(true), [flushInner]);

  useEffect(() => {
    mounted.current = true;
    const sub = form.watch((_values, info) => {
      if (!info.name) return;
      clearTimer();
      timer.current = window.setTimeout(() => {
        // Silent: an error under a field the user is still typing in is
        // noise; onBlur and the leave guard show it at the right moment.
        void flushInner(false);
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      sub.unsubscribe();
      mounted.current = false;
      if (timer.current !== null) {
        clearTimer();
        const parsed = latest.current.lenient.safeParse(form.getValues());
        if (parsed.success) void save(parsed.data);
      }
    };
  }, [form, flushInner, save]);

  const submit = useCallback(
    (after: () => Promise<void>): Promise<void> =>
      form.handleSubmit(async () => {
        if (await flush()) await after();
      })(),
    [form, flush],
  );

  return { form, saveState, submit, flush };
}
