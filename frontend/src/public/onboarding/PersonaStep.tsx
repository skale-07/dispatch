import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm, type Resolver } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import { PanelState } from "../../components/public/PanelState";
import { deleteMyPersona, getMyIntegrations, getMyPersona, saveMyPersona, setMyIntegration } from "../data";
import { LongTextField, TextField } from "./fields";
import { integrationFor } from "./handoff";
import {
  EMPTY_PROJECT,
  personaFormFrom,
  personaIsBlank,
  personaRowFrom,
  personaStrict,
  type PersonaForm,
} from "./persona";
import { StepActions, type StepProps } from "./StepChrome";

/**
 * Step 10 — the outreach persona and the JobRight Premium self-report.
 * Referral drafts open with the headline and may only claim the projects
 * listed here; a blank form means "no persona" and the engine drafts
 * nothing for this account (it says so; it never writes a generic
 * email). Written explicitly on Next — the row's CHECKs need a headline.
 *
 * Premium is the user's own statement (set_my_integration accepts only
 * {premium} and {disconnect}); the engine may later confirm it from a
 * read-only probe but never demotes a self-report. The drafter runs only
 * when Premium AND Gmail are both connected.
 */

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export function PersonaStep(props: StepProps): JSX.Element {
  const [initial, setInitial] = useState<PersonaForm | null>(null);
  const [hadRow, setHadRow] = useState(false);
  const [premium, setPremium] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    Promise.all([getMyPersona(), getMyIntegrations()])
      .then(([row, integrations]) => {
        if (!alive) return;
        setInitial(personaFormFrom(row, props.draft));
        setHadRow(row !== null);
        setPremium(integrationFor(integrations, "jobright")?.premium ?? null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setInitial(personaFormFrom(null, props.draft));
      });
    return () => {
      alive = false;
    };
    // Mount-time prefill on purpose: the draft is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initial === null) {
    return <PanelState kind="loading" />;
  }
  return (
    <PersonaForm
      initial={initial}
      hadRow={hadRow}
      premium={premium}
      loadError={loadError}
      status={status}
      setStatus={setStatus}
      onPremium={setPremium}
      goBack={props.goBack}
      goNext={props.goNext}
    />
  );
}

function PersonaForm({
  initial,
  hadRow,
  premium,
  loadError,
  status,
  setStatus,
  onPremium,
  goBack,
  goNext,
}: {
  initial: PersonaForm;
  hadRow: boolean;
  premium: boolean | null;
  loadError: string | null;
  status: Status;
  setStatus: (s: Status) => void;
  onPremium: (p: boolean | null) => void;
  goBack: (() => void) | null;
  goNext: () => Promise<void>;
}): JSX.Element {
  const form = useForm<PersonaForm>({
    resolver: zodResolver(personaStrict) as unknown as Resolver<PersonaForm>,
    defaultValues: initial,
    mode: "onBlur",
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "projects" });
  const [premiumBusy, setPremiumBusy] = useState(false);
  const [premiumError, setPremiumError] = useState<string | null>(null);

  const submit = form.handleSubmit(async (values) => {
    setStatus({ kind: "saving" });
    try {
      const row = personaRowFrom(values);
      if (row) await saveMyPersona(row);
      else if (hadRow) await deleteMyPersona();
      setStatus({ kind: "idle" });
      await goNext();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  const togglePremium = async (next: boolean): Promise<void> => {
    setPremiumBusy(true);
    setPremiumError(null);
    try {
      await setMyIntegration("jobright", { premium: next });
      onPremium(next);
    } catch (err) {
      setPremiumError(err instanceof Error ? err.message : String(err));
    } finally {
      setPremiumBusy(false);
    }
  };

  const blank = personaIsBlank(form.watch());

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-6"
      >
        <Card className="py-6">
          <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
            <p className="m-0 text-base leading-relaxed text-text-dim">
              After a submission, Dispatch can draft a short intro email to a real person
              inside the company — for you to read and send. The draft opens with your
              headline and may only mention the projects you list here. Leave this blank
              and no drafts are written for you.
            </p>
            {loadError ? (
              <Alert variant="destructive" role="alert">
                <Icon name="alert" size={14} />
                <AlertDescription>
                  <p className="m-0">
                    Could not load a saved persona ({loadError}) — starting from your
                    profile. Continuing with a filled-in form replaces whatever was on file;
                    a blank form leaves it as it is.
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}

            <TextField
              name="headline"
              label="headline"
              placeholder="CS junior at Pitt building ML tooling; looking for a Summer 2027 SWE internship"
              hint="One line, in your voice. Referral drafts open with it."
            />
            <div className="grid gap-5 sm:grid-cols-3">
              <TextField name="school" label="school" optional />
              <TextField name="class_year" label="class year" optional inputMode="numeric" placeholder="2027" />
              <TextField name="majors" label="majors" optional hint="Comma-separated." />
            </div>

            <Separator />
            <Eyebrow as="h2">projects</Eyebrow>
            {fields.length === 0 ? (
              <FieldHint>
                The only things a draft may claim you built. Two or three with real names is
                plenty; none means no drafts.
              </FieldHint>
            ) : null}
            {fields.map((f, i) => (
              <div key={f.id} className="flex flex-col gap-4 rounded-md border border-border p-4">
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField name={`projects.${i}.name`} label="project name" />
                  <TextField name={`projects.${i}.tools`} label="tools" optional placeholder="Python, PyTorch" hint="Comma-separated." />
                </div>
                <LongTextField name={`projects.${i}.summary`} label="what it does, what you did" optional max={600} rows={3} />
                <TextField
                  name={`projects.${i}.relevance_tags`}
                  label="relevant to"
                  optional
                  placeholder="ml, backend, data"
                  hint="Comma-separated tags a draft uses to pick the right project for a role."
                />
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => remove(i)}>
                    <Icon name="x" size={14} />
                    remove this project
                  </Button>
                </div>
              </div>
            ))}
            {fields.length < 8 ? (
              <div>
                <Button type="button" variant="outline" onClick={() => append({ ...EMPTY_PROJECT })}>
                  <Icon name="plus" size={14} />
                  add a project
                </Button>
              </div>
            ) : null}

            <Separator />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField name="skills" label="skills a draft may name" optional hint="Comma-separated; prefilled from your profile." />
              <TextField name="interests" label="interests" optional placeholder="distributed systems, climate" hint="Comma-separated; used to pick a person worth writing to." />
            </div>

            <Separator />
            <Eyebrow as="h2">JobRight Premium</Eyebrow>
            <div className="flex min-h-11 items-start gap-3">
              <Checkbox
                id="jobright-premium"
                checked={premium === true}
                disabled={premiumBusy}
                onCheckedChange={(c: boolean | "indeterminate") => void togglePremium(c === true)}
              />
              <Label htmlFor="jobright-premium" className="font-regular leading-relaxed">
                I have JobRight Premium. Referral drafts need it (they use the insider
                contacts Premium unlocks) together with a connected Gmail.
              </Label>
            </div>
            {premiumError ? <FieldHint tone="danger">{premiumError}</FieldHint> : null}
          </CardContent>
        </Card>
        <StepActions
          goBack={goBack}
          busy={status.kind === "saving"}
          status={
            <p
              role="status"
              aria-live="polite"
              className={cn("m-0 font-mono text-xs", status.kind === "error" ? "text-danger" : "text-text-dim")}
            >
              {status.kind === "saving"
                ? "saving…"
                : status.kind === "error"
                  ? `not saved: ${status.message}`
                  : blank
                    ? hadRow
                      ? "blank — continuing removes the saved persona; no drafts"
                      : "blank — no persona, no drafts; continue to skip"
                    : "saved when you continue"}
            </p>
          }
        />
      </form>
    </Form>
  );
}
