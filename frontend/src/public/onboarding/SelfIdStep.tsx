import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Icon } from "../../components/Icon";
import { FieldHint } from "../../components/public/FieldHint";
import { PanelState } from "../../components/public/PanelState";
import {
  EMPTY_SENSITIVE,
  PREFER_NOT_LABEL,
  SENSITIVE_FIELDS,
  type SensitiveDraft,
  type SensitiveFieldSpec,
} from "../contract";
import { clearMySelfId, getMySelfId, saveMySelfId } from "../selfId";
import { StepActions, type StepProps } from "./StepChrome";

/**
 * Step 9 — self-identification, opt-in and encrypted (selfId.ts,
 * migration 20260911000500; decision 2026-09-11). Nothing here touches
 * the profile draft. Consent is off by default and every field starts as
 * "ask me per application"; per field the user may pick a verbatim
 * option, "Prefer not to answer" (an answer the engine places), or leave
 * it for the per-application to-do. Saved explicitly on Next through the
 * RPC, which refuses without consent — that refusal is shown verbatim.
 */

const PREFER_NOT = "__prefer_not";
const SKIP = "__skip";
const CUSTOM = "__custom";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; answered: number }
  | { kind: "error"; message: string };

export function SelfIdStep(props: StepProps): JSX.Element {
  const [draft, setDraft] = useState<SensitiveDraft>(EMPTY_SENSITIVE);
  const [hadConsent, setHadConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    getMySelfId()
      .then((d) => {
        if (!alive) return;
        setDraft(d);
        setHadConsent(d.consent);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setField = (key: SensitiveFieldSpec["key"], entry: SensitiveDraft["fields"][typeof key]): void =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: entry } }));

  const next = async (): Promise<void> => {
    setStatus({ kind: "saving" });
    try {
      if (draft.consent) {
        const { answeredKeys } = await saveMySelfId(draft);
        setStatus({ kind: "saved", answered: answeredKeys.length });
        setHadConsent(true);
      } else if (hadConsent) {
        // Consent withdrawn: the encrypted row goes, nothing is kept.
        await clearMySelfId();
        setHadConsent(false);
        setStatus({ kind: "idle" });
      } else {
        setStatus({ kind: "idle" });
      }
      await props.goNext();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const statusText =
    status.kind === "saving"
      ? "saving…"
      : status.kind === "saved"
        ? `saved — ${status.answered} ${status.answered === 1 ? "answer" : "answers"} on file, encrypted`
        : status.kind === "error"
          ? `not saved: ${status.message}`
          : draft.consent
            ? "saved when you continue"
            : "nothing is stored while this is off";

  return (
    <div className="flex flex-col gap-6">
      <Card className="py-6">
        <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
          <p className="m-0 text-base leading-relaxed text-text-dim">
            Many US employers ask voluntary self-identification questions. Dispatch answers
            them only if you opt in here, only with what you choose below, and keeps your
            answers encrypted where only your own applications can read them. Left off,
            those questions become a quick per-application to-do instead.
          </p>

          {loadError ? (
            <Alert variant="destructive" role="alert">
              <Icon name="alert" size={14} />
              <AlertDescription>
                <p className="m-0">
                  Could not load your saved answers ({loadError}). Continuing with consent
                  on would replace them with what you set here.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          {loading ? (
            <PanelState kind="loading" />
          ) : (
            <>
              <div className="flex min-h-11 items-start gap-3 rounded-md border border-border bg-bg-inset p-4">
                <Checkbox
                  id="self-id-consent"
                  checked={draft.consent}
                  onCheckedChange={(c: boolean | "indeterminate") =>
                    setDraft((d) => ({ ...d, consent: c === true }))
                  }
                />
                <Label htmlFor="self-id-consent" className="font-regular leading-relaxed">
                  Answer self-identification questions on my behalf with the answers below.
                  I can change or clear them any time; clearing removes them entirely.
                </Label>
              </div>

              {/* Every control below takes `disabled` itself (Radix items,
                  checkboxes, inputs), so keyboard and AT are blocked too;
                  the dimming is only the visual echo. */}
              <div className={cn("flex flex-col gap-6", !draft.consent && "opacity-50")}>
                {SENSITIVE_FIELDS.map((spec, i) => (
                  <div key={spec.key} className="flex flex-col gap-4">
                    {i > 0 ? <Separator /> : null}
                    <SensitiveFieldEditor
                      spec={spec}
                      entry={draft.fields[spec.key]}
                      disabled={!draft.consent}
                      onChange={(entry) => setField(spec.key, entry)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <StepActions
        goBack={props.goBack}
        onNext={() => void next()}
        busy={status.kind === "saving" || loading}
        status={
          <p
            role="status"
            aria-live="polite"
            className={cn("m-0 font-mono text-xs", status.kind === "error" ? "text-danger" : "text-text-dim")}
          >
            {statusText}
          </p>
        }
      />
    </div>
  );
}

function SensitiveFieldEditor({
  spec,
  entry,
  disabled,
  onChange,
}: {
  spec: SensitiveFieldSpec;
  entry: SensitiveDraft["fields"][SensitiveFieldSpec["key"]];
  disabled: boolean;
  onChange: (entry: SensitiveDraft["fields"][SensitiveFieldSpec["key"]]) => void;
}): JSX.Element {
  const id = (suffix: string): string => `selfid-${spec.key}-${suffix.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const single = typeof entry.value === "string" ? entry.value : "";
  const chosen = Array.isArray(entry.value) ? entry.value : [];
  // "Another answer" is an explicit MODE, not inferred from the text: a
  // typed value that passes through a listed option ("They/them/theirs"
  // through "They/them") must not flip the radio and disable its own
  // input mid-keystroke (review 2026-09-12).
  const [customMode, setCustomMode] = useState(
    () => entry.choice === "answer" && single !== "" && !spec.options.includes(single),
  );
  // The radio's value: an option verbatim, or one of the three sentinels.
  const radioValue =
    entry.choice === "prefer_not"
      ? PREFER_NOT
      : entry.choice === "skip"
        ? SKIP
        : spec.multi
          ? "answer"
          : customMode || single === ""
            ? CUSTOM
            : single;

  const pick = (v: string): void => {
    // Switching mode keeps the multi selections so a round trip through
    // "prefer not" does not lose the ticks; draftToPlain sends them only
    // when the choice is "answer".
    if (v === PREFER_NOT) {
      setCustomMode(false);
      onChange({ choice: "prefer_not", value: spec.multi ? chosen : "" });
    } else if (v === SKIP) {
      setCustomMode(false);
      onChange({ choice: "skip", value: spec.multi ? chosen : "" });
    } else if (v === "answer") {
      onChange({ choice: "answer", value: chosen });
    } else if (v === CUSTOM) {
      setCustomMode(true);
      onChange({ choice: "answer", value: customMode ? single : "" });
    } else {
      setCustomMode(false);
      onChange({ choice: "answer", value: v });
    }
  };

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-1 p-0 text-sm text-text">{spec.label}</legend>
      <RadioGroup
        value={radioValue}
        onValueChange={pick}
        disabled={disabled}
        aria-label={spec.label}
        className="flex flex-col gap-1"
      >
        {spec.multi ? (
          <div className="flex min-h-11 items-center gap-3">
            <RadioGroupItem value="answer" id={id("answer")} />
            <Label htmlFor={id("answer")} className="font-regular">
              choose all that apply
            </Label>
          </div>
        ) : (
          spec.options.map((o) => (
            <div key={o} className="flex min-h-11 items-center gap-3">
              <RadioGroupItem value={o} id={id(o)} />
              <Label htmlFor={id(o)} className="font-regular">
                {o}
              </Label>
            </div>
          ))
        )}
        {spec.multi && entry.choice === "answer" ? (
          <div role="group" aria-label={`${spec.label} options`} className="ml-7 flex flex-col gap-1">
            {spec.options.map((o) => (
              <div key={o} className="flex min-h-11 items-center gap-3">
                <Checkbox
                  id={id(`opt-${o}`)}
                  disabled={disabled}
                  checked={chosen.includes(o)}
                  onCheckedChange={(c: boolean | "indeterminate") =>
                    onChange({
                      choice: "answer",
                      value: c === true ? [...chosen, o] : chosen.filter((x) => x !== o),
                    })
                  }
                />
                <Label htmlFor={id(`opt-${o}`)} className="font-regular">
                  {o}
                </Label>
              </div>
            ))}
          </div>
        ) : null}
        {!spec.multi && spec.allowCustom ? (
          <div className="flex min-h-11 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex min-h-11 items-center gap-3">
              <RadioGroupItem value={CUSTOM} id={id("custom")} />
              <Label htmlFor={id("custom")} className="font-regular">
                another answer, verbatim:
              </Label>
            </div>
            <Input
              aria-label={`${spec.label} — another answer`}
              disabled={disabled || radioValue !== CUSTOM}
              value={radioValue === CUSTOM ? single : ""}
              onChange={(e) => {
                setCustomMode(true);
                onChange({ choice: "answer", value: e.target.value });
              }}
              className="sm:max-w-xs"
            />
          </div>
        ) : null}
        <div className="flex min-h-11 items-center gap-3">
          <RadioGroupItem value={PREFER_NOT} id={id("prefer-not")} />
          <Label htmlFor={id("prefer-not")} className="font-regular">
            {PREFER_NOT_LABEL}
            <span className="text-text-faint"> — an answer: the form's own decline option</span>
          </Label>
        </div>
        <div className="flex min-h-11 items-center gap-3">
          <RadioGroupItem value={SKIP} id={id("skip")} />
          <Label htmlFor={id("skip")} className="font-regular">
            ask me per application
          </Label>
        </div>
      </RadioGroup>
      {spec.hint ? <FieldHint>{spec.hint}</FieldHint> : null}
    </fieldset>
  );
}
