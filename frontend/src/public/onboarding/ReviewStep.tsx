import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "../../components/Icon";
import { WORK_AUTH_OPTIONS, type DocumentRow } from "../contract";
import { completeMyOnboarding, listMyDocuments } from "../data";
import { ONBOARDING_STEPS, type StepSlug } from "./steps";
import { StepActions, type StepProps } from "./StepChrome";

type Finish =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "missing"; missing: string[] }
  | { kind: "error"; message: string };

/**
 * Step 13: what Dispatch applies from, with an edit link per line, and
 * the one action that can mark onboarding complete —
 * complete_my_onboarding(). The server decides; its `missing` list is
 * rendered verbatim. The browser never stamps completion itself.
 */
export function ReviewStep({ draft, screeners, goBack }: StepProps): JSX.Element {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [finish, setFinish] = useState<Finish>({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    listMyDocuments()
      .then((d) => {
        if (alive) setDocs(d);
      })
      .catch((err: unknown) => {
        if (alive) setDocsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const complete = async (): Promise<void> => {
    setFinish({ kind: "checking" });
    try {
      const result = await completeMyOnboarding();
      if (result.complete) {
        navigate("/dashboard", { state: { profileSaved: true } });
        return;
      }
      setFinish({ kind: "missing", missing: result.missing });
    } catch (err) {
      setFinish({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const resumeCount = docs?.filter((d) => d.kind === "resume").length ?? 0;
  const perApplication = ONBOARDING_STEPS.flatMap((s) => s.screeners).filter(
    (k) => !(screeners[k] ?? "").trim(),
  ).length;

  const lines: Array<{ label: string; value: string; step: StepSlug }> = [
    {
      label: "legal name",
      value: [draft.legal_first_name, draft.legal_middle_name, draft.legal_last_name]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" "),
      step: "identity",
    },
    { label: "phone", value: draft.phone.trim(), step: "contact" },
    {
      label: "location",
      value: [draft.location_city, draft.location_region, draft.location_country]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", "),
      step: "contact",
    },
    {
      label: "education",
      value: [[draft.degree, draft.field].filter(Boolean).join(", "), draft.school, draft.grad_year]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" · "),
      step: "education",
    },
    {
      label: "resumes",
      value:
        docs === null
          ? docsError
            ? `could not list (${docsError})`
            : "checking…"
          : `${resumeCount} on file`,
      step: "documents",
    },
    {
      label: "work authorization",
      value: WORK_AUTH_OPTIONS.find((o) => o.value === draft.work_authorization)?.label ?? "",
      step: "eligibility",
    },
    {
      label: "needs sponsorship",
      value: draft.needs_sponsorship === "yes" ? "Yes" : draft.needs_sponsorship === "no" ? "No" : "",
      step: "eligibility",
    },
    {
      label: "about you",
      value: draft.about_me.trim() ? `${draft.about_me.trim().length} characters` : "",
      step: "about",
    },
    { label: "roles", value: draft.titles.trim(), step: "preferences" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card className="py-6">
        <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
          <p className="m-0 text-base leading-relaxed text-text-dim">
            This is what Dispatch applies from. Blank stays blank on forms. Finishing asks
            the server to check the profile — it names anything missing, and only a complete
            profile is marked ready.
          </p>
          <dl className="m-0 flex flex-col">
            {lines.map((line) => (
              <div
                key={line.label}
                className="flex flex-col gap-1 border-b border-border py-3 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <dt className="m-0 w-44 shrink-0 font-mono text-xs uppercase tracking-widest text-text-dim">
                  {line.label}
                </dt>
                <dd className="m-0 flex-1 text-sm text-text">{line.value || "—"}</dd>
                <Link
                  to={`/onboarding/${line.step}`}
                  className="text-sm text-accent-brand"
                  aria-label={`edit ${line.label}`}
                >
                  edit
                </Link>
              </div>
            ))}
          </dl>
          <p className="m-0 text-sm text-text-dim">
            <span className="font-mono text-text">{perApplication}</span>{" "}
            {perApplication === 1 ? "question" : "questions"} Dispatch will ask you per
            application. Answering them on the eligibility and compensation steps removes
            those to-dos.
          </p>

          {finish.kind === "missing" ? (
            <Alert role="alert">
              <Icon name="alert" size={14} />
              <AlertTitle className="font-heavy">Not complete yet</AlertTitle>
              <AlertDescription>
                <p className="m-0">The server says these are still missing:</p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                  {finish.missing.map((m) => (
                    <li key={m} className="font-mono text-xs">
                      {m}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {finish.kind === "error" ? (
            <Alert variant="destructive" role="alert">
              <Icon name="alert" size={14} />
              <AlertDescription>
                <p className="m-0">Could not check your profile: {finish.message}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <StepActions
        goBack={goBack}
        onNext={() => void complete()}
        busy={finish.kind === "checking"}
        nextLabel="finish — I'm ready to apply"
        status={
          <p className="m-0 font-mono text-xs text-text-dim">
            every step saved as you went
          </p>
        }
      />
    </div>
  );
}
