import { useEffect, useState, type ReactNode } from "react";
import type { FieldValues } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { Icon } from "../../components/Icon";
import type { ProfileDraft } from "../contract";
import { saveProfileStep, saveScreenerAnswers } from "../data";
import { pickAnswers, pickDraft, screenerRows, stepPatch, type OnboardingStep } from "./steps";
import { useStepForm, type SaveState } from "./useStepForm";

/** What the wizard shell hands every step. */
export type StepProps = {
  step: OnboardingStep;
  draft: ProfileDraft;
  screeners: Record<string, string>;
  onSaved: (fields: Partial<ProfileDraft>, answers: Record<string, string> | null) => void;
  onImported: (draft: ProfileDraft) => void;
  goNext: () => Promise<void>;
  goBack: (() => void) | null;
  /**
   * A form step registers its flush here; the shell runs it before any
   * navigation away (step links, Back) and stays put when it refuses.
   */
  setLeaveGuard: (guard: (() => Promise<boolean>) | null) => void;
};

export function SaveStatus({ state }: { state: SaveState }): JSX.Element {
  const text =
    state.kind === "saving"
      ? "saving…"
      : state.kind === "saved"
        ? `saved ${state.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : state.kind === "invalid"
          ? "not saved yet — fix the highlighted field"
          : state.kind === "error"
            ? `not saved: ${state.message}`
            : "answers save as you go";
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "m-0 font-mono text-xs",
        state.kind === "error" ? "text-danger" : state.kind === "invalid" ? "text-warn" : "text-text-dim",
      )}
    >
      {text}
    </p>
  );
}

export function StepActions({
  goBack,
  onNext,
  status,
  busy = false,
  nextLabel = "next",
}: {
  goBack: (() => void) | null;
  /** Absent = the Next button submits the surrounding form. */
  onNext?: (() => void) | undefined;
  status: ReactNode;
  busy?: boolean | undefined;
  nextLabel?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-h-5">{status}</div>
      <div className="flex gap-3">
        {goBack ? (
          <Button type="button" variant="outline" onClick={goBack}>
            <Icon name="arrow-left" size={14} />
            back
          </Button>
        ) : null}
        <Button
          type={onNext ? "button" : "submit"}
          disabled={busy}
          className="flex-1 sm:flex-none"
          {...(onNext ? { onClick: onNext } : {})}
        >
          {busy ? "saving…" : nextLabel}
          <Icon name="arrow-right" size={14} />
        </Button>
      </div>
    </div>
  );
}

/**
 * A step whose answers live in the profile row and/or the screener bank:
 * the form, its card, its autosave status and its back/next row. Next
 * validates strictly, saves, then moves on; a failed save stays put.
 */
export function ProfileStepForm<T extends FieldValues>({
  props,
  lenient,
  strict,
  children,
}: {
  props: StepProps;
  lenient: z.ZodType<T, z.ZodTypeDef, T>;
  strict: z.ZodTypeAny;
  children: ReactNode;
}): JSX.Element {
  const { step } = props;
  // The form starts from what the shell holds when the step mounts; the
  // shell remounts the step (new key) after an import merge.
  const [initial] = useState(
    () =>
      ({
        ...pickDraft(props.draft, step.fields),
        ...(step.screeners.length > 0
          ? { screeners: pickAnswers(props.screeners, step.screeners) }
          : {}),
      }) as unknown as T,
  );
  const { form, saveState, submit, flush } = useStepForm<T>({
    lenient,
    strict,
    values: initial,
    save: async (values) => {
      const { screeners: answers, ...fields } = values as unknown as Partial<ProfileDraft> & {
        screeners?: Record<string, string>;
      };
      if (step.columns.length > 0) {
        await saveProfileStep(stepPatch(step, { ...props.draft, ...fields }));
      }
      if (answers) await saveScreenerAnswers(screenerRows(step, answers));
      props.onSaved(fields, answers ?? null);
    },
  });

  const { setLeaveGuard } = props;
  useEffect(() => {
    setLeaveGuard(flush);
    return () => setLeaveGuard(null);
  }, [setLeaveGuard, flush]);

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(props.goNext);
        }}
        className="flex flex-col gap-6"
      >
        <Card className="py-6">
          <CardContent className="flex flex-col gap-6 px-5 sm:px-8">{children}</CardContent>
        </Card>
        <StepActions
          goBack={props.goBack}
          status={<SaveStatus state={saveState} />}
          busy={form.formState.isSubmitting}
        />
      </form>
    </Form>
  );
}

