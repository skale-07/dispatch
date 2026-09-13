import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import { PanelState } from "../../components/public/PanelState";
import type { ApplicationRowPublic } from "../contract";
import { getFieldSuggestionInputs, saveProfileStep, saveScreenerAnswers } from "../data";
import { rankSuggestions, type Suggestion } from "../fieldSuggestions";
import { applySuggestionAnswer, suggestionAction, suggestionTitle } from "./applySuggestion";

/**
 * "Suggested for you" (plan M11): the ranker's top cards — the questions
 * forms keep asking that this profile has not answered — each with the
 * evidence it was ranked on and either a one-field answer or a link to
 * the step that owns the question. Answering writes to the right store
 * and re-ranks; "not now" hides a card on this browser only (a per-viewer
 * convenience in localStorage, never a fact about the account).
 */

const DISMISS_KEY = "dispatch.dismissedSuggestions";
const SHOW = 5;

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}
function writeDismissed(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
  } catch {
    /* per-viewer convenience only */
  }
}

export function SuggestedPanel({
  applications,
  compact = false,
}: {
  /** For the own-event "why": company by engine application id. */
  applications: ApplicationRowPublic[] | null;
  /** Review step: fewer cards, no heading card chrome. */
  compact?: boolean;
}): JSX.Element {
  const [inputs, setInputs] = useState<Awaited<ReturnType<typeof getFieldSuggestionInputs>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const load = useCallback(async (): Promise<void> => {
    try {
      setInputs(await getFieldSuggestionInputs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const companies = useMemo(() => {
    const m: Record<string, string | undefined> = {};
    for (const a of applications ?? []) m[a.id] = a.company ?? undefined;
    return m;
  }, [applications]);

  const cards: Suggestion[] = useMemo(
    () =>
      inputs
        ? rankSuggestions(inputs, { applications: companies, titleFor: suggestionTitle, dismissed }).slice(
            0,
            compact ? 3 : SHOW,
          )
        : [],
    [inputs, companies, dismissed, compact],
  );

  const dismiss = (id: string): void => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <section aria-labelledby="suggested-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Eyebrow as="h2">
          <span id="suggested-heading">suggested for you</span>
        </Eyebrow>
        {!compact ? (
          <p className="m-0 text-sm text-text-dim">
            Questions forms keep asking that your profile does not answer yet. Answer once here
            and every later application stops asking you.
          </p>
        ) : null}
      </div>
      {error ? (
        <PanelState
          kind="error"
          title="Could not load suggestions"
          body={error}
          action={
            <Button type="button" variant="outline" onClick={() => void load()}>
              <Icon name="refresh" size={14} />
              try again
            </Button>
          }
        />
      ) : inputs === null ? (
        <PanelState kind="loading" />
      ) : cards.length === 0 ? (
        <PanelState
          kind="empty"
          icon="check"
          title="Nothing to suggest right now"
          body="Every question we have evidence for is answered. New ones appear here as your runs and other users' forms surface them."
        />
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {cards.map((c) => (
            <li key={c.id}>
              <SuggestionCard suggestion={c} onDone={() => void load()} onDismiss={() => dismiss(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionCard({
  suggestion,
  onDone,
  onDismiss,
}: {
  suggestion: Suggestion;
  onDone: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const action = suggestionAction(suggestion.target);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `sug-${suggestion.id.replace(/[^a-zA-Z0-9]+/g, "-")}`;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const wrote = await applySuggestionAnswer(suggestion.target, value, {
        saveProfile: saveProfileStep,
        saveScreener: saveScreenerAnswers,
      });
      if (wrote) onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const [primaryWhy, ...moreWhy] = suggestion.why;

  return (
    <Card className="h-full gap-3 py-4">
      <CardContent className="flex h-full flex-col gap-3 px-4">
        <p className="m-0 text-sm font-heavy text-text">{suggestion.title}</p>
        <p className="m-0 text-xs text-text-dim">
          <span className="font-heavy text-text">{primaryWhy}</span>
          {moreWhy.map((w) => (
            <span key={w}>
              {" "}
              · {w}
            </span>
          ))}
        </p>

        {action.mode === "inline" ? (
          <form
            className="mt-auto flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {action.kind === "boolean" ? (
              <RadioGroup
                value={value}
                onValueChange={setValue}
                aria-label={suggestion.title}
                className="flex flex-row gap-5"
              >
                {["Yes", "No"].map((o) => (
                  <div key={o} className="flex min-h-11 items-center gap-2">
                    <RadioGroupItem value={o} id={`${id}-${o}`} />
                    <Label htmlFor={`${id}-${o}`} className="font-regular">
                      {o}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            ) : (
              <>
                <Label htmlFor={id} className="sr-only">
                  {suggestion.title}
                </Label>
                <Input
                  id={id}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  inputMode={action.kind === "number" ? "numeric" : "text"}
                  {...(action.suggestions ? { list: `${id}-list` } : {})}
                  placeholder="your answer, verbatim"
                />
                {action.suggestions ? (
                  <datalist id={`${id}-list`}>
                    {action.suggestions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                ) : null}
              </>
            )}
            {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy || !value.trim()}>
                {busy ? "saving…" : "save answer"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
                not now
              </Button>
            </div>
          </form>
        ) : action.mode === "navigate" ? (
          <div className="mt-auto flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to={action.to}>
                <Icon name="arrow-right" size={14} />
                {action.label}
              </Link>
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              not now
            </Button>
          </div>
        ) : (
          <FieldHint tone="warn">{action.reason}</FieldHint>
        )}
      </CardContent>
    </Card>
  );
}
