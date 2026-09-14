import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "../../components/Icon";
import { CopyButton } from "../../components/public/CopyButton";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import type { DocumentRow, ProfileDraft } from "../contract";
import { downloadDocument, listMyDocuments } from "../data";
import { buildImportPrompt, importDraft, type ImportOutcome } from "../importPrompt";
import { applyResumeToDraft, parseResumeText, type ParsedResume } from "../resumeParse";

/**
 * "Fill from resume" (plan M23) on the experience step. One dialog, two
 * ways to turn a resume into cards, both review-first:
 *
 *   1. YOUR OWN ASSISTANT (recommended). The PDF is read on device, its
 *      text is dropped into the import prompt (importPrompt.ts) along
 *      with the exact fields to look for, the user pastes ONE thing into
 *      whatever assistant they use, and pastes the JSON back. Resumes
 *      come in every layout; a model reads all of them, and it costs us
 *      nothing (operator 2026-09-14: let users use their own agents as
 *      much as possible).
 *   2. QUICK FILL, no AI. The deterministic reader (resumeParse.ts) cuts
 *      the same text into roles / schools / skills instantly, for people
 *      without an assistant handy or a plain two-column resume.
 *
 * Nothing is saved here. "Use these" merges into the DRAFT, the shell
 * remounts the step, and the user edits every card before Continue.
 */

type Stage = "source" | "reading" | "review";

function extractError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/password/i.test(msg)) return "that PDF is password-protected — export an unlocked copy";
  if (/Invalid PDF|InvalidPDFException/i.test(msg)) return "that file is not a readable PDF";
  return msg;
}

export function ResumeFillDialog({
  draft,
  onMerge,
}: {
  draft: ProfileDraft;
  onMerge: (merged: ProfileDraft) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("source");
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [pastedText, setPastedText] = useState("");

  const reset = (): void => {
    setStage("source");
    setError(null);
    setSourceName("");
    setLines([]);
    setPastedText("");
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    listMyDocuments()
      .then((rows) => {
        if (alive) setDocs(rows.filter((d) => d.kind === "resume"));
      })
      .catch(() => {
        if (alive) setDocs([]);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const read = async (name: string, load: () => Promise<string[]>): Promise<void> => {
    setStage("reading");
    setError(null);
    setSourceName(name);
    try {
      const got = await load();
      setLines(got);
      setStage("review");
    } catch (err) {
      setError(extractError(err));
      setStage("source");
    }
  };

  const readPdf = (name: string, bytes: () => Promise<ArrayBuffer>): void => {
    void read(name, async () => {
      const { extractPdfLines } = await import("../resumePdf");
      return extractPdfLines(await bytes());
    });
  };

  const readFile = (file: File | undefined): void => {
    if (!file) return;
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      readPdf(file.name, () => file.arrayBuffer());
    } else {
      void read(file.name, async () => {
        const { extractTextLines } = await import("../resumePdf");
        return extractTextLines(file);
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <div className="flex flex-col gap-3 rounded-md border border-border bg-bg-inset p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="m-0 text-sm text-text-dim">
          Have a resume? Read it here and get one editable card per role, your schools and your
          skills — with your own AI assistant, or instantly without one. Nothing is saved until
          you continue.
        </p>
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            <Icon name="file" size={14} />
            fill from resume
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-heavy">Fill from your resume</DialogTitle>
          <DialogDescription>
            The file is read in your browser; Dispatch never uploads it anywhere new. You review
            every card before anything is saved.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive" role="alert">
            <Icon name="alert" size={14} />
            <AlertDescription>
              <p className="m-0">{error}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {stage === "source" ? (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <Eyebrow>your uploaded resumes</Eyebrow>
              {docs === null ? <FieldHint>loading…</FieldHint> : null}
              {docs !== null && docs.length === 0 ? (
                <FieldHint>None yet — the Documents step is next; or pick a file below.</FieldHint>
              ) : null}
              {docs && docs.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-mono text-sm text-text">{d.filename}</span>
                        <span className="flex gap-2">
                          <Badge variant="outline">{d.variant}</Badge>
                          {d.is_default ? <Badge variant="secondary">default</Badge> : null}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => readPdf(d.filename, () => downloadDocument(d))}
                      >
                        read this one
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <section className="flex flex-col gap-2">
              <Label htmlFor="resume-fill-file">or a file on this device (PDF or plain text)</Label>
              <Input
                id="resume-fill-file"
                type="file"
                accept="application/pdf,.pdf,.txt,.md,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  readFile(file);
                }}
              />
            </section>
            <section className="flex flex-col gap-2">
              <Label htmlFor="resume-fill-text">or paste the text of your resume</Label>
              <Textarea
                id="resume-fill-text"
                rows={4}
                className="font-mono text-xs"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Select all in your resume document, copy, paste here."
              />
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!pastedText.trim()}
                  onClick={() => void read("pasted text", async () => pastedText.split(/\r?\n/))}
                >
                  read the pasted text
                </Button>
              </div>
            </section>
          </div>
        ) : null}

        {stage === "reading" ? (
          <p className="m-0 font-mono text-xs text-text-dim" role="status" aria-live="polite">
            reading {sourceName}…
          </p>
        ) : null}

        {stage === "review" ? (
          <Review
            sourceName={sourceName}
            lines={lines}
            draft={draft}
            onBack={reset}
            onMerge={(merged) => {
              onMerge(merged);
              setOpen(false);
              reset();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ── review: the two paths ────────────────────────────────────────── */

function Review({
  sourceName,
  lines,
  draft,
  onBack,
  onMerge,
}: {
  sourceName: string;
  lines: string[];
  draft: ProfileDraft;
  onBack: () => void;
  onMerge: (merged: ProfileDraft) => void;
}): JSX.Element {
  const text = useMemo(() => lines.join("\n"), [lines]);
  const parsed = useMemo(() => parseResumeText(lines), [lines]);
  const empty = parsed.lineCount === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-mono text-xs text-text-dim" role="status">
          read {sourceName}: {parsed.lineCount} lines
          {parsed.headings.length > 0 ? ` · sections: ${parsed.headings.join(", ")}` : ""}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          choose another
        </Button>
      </div>

      {empty ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">
              That file has no readable text (a scanned or image-only PDF). Export a text PDF, or
              paste your resume's text instead.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="assistant">
        <TabsList>
          <TabsTrigger value="assistant">
            <Icon name="sparkle" size={12} />
            with your AI assistant
          </TabsTrigger>
          <TabsTrigger value="quick">quick fill, no AI</TabsTrigger>
        </TabsList>
        <TabsContent value="assistant">
          <AssistantPath text={empty ? "" : text} draft={draft} onMerge={onMerge} />
        </TabsContent>
        <TabsContent value="quick">
          <QuickPath parsed={parsed} draft={draft} onMerge={onMerge} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Path 1: the prompt with the resume text already in it, and the reply paste. */
function AssistantPath({
  text,
  draft,
  onMerge,
}: {
  text: string;
  draft: ProfileDraft;
  onMerge: (merged: ProfileDraft) => void;
}): JSX.Element {
  const prompt = useMemo(() => buildImportPrompt(text), [text]);
  const [pasted, setPasted] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  return (
    <div className="flex flex-col gap-4 pt-3">
      <FieldHint>
        Resumes come in every layout; your assistant reads all of them. The prompt below already
        contains your resume text and the exact fields to fill — it asks for every role in
        detail, every school and every skill, and never for work authorization or
        self-identification.
      </FieldHint>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Eyebrow>1 · copy the prompt (resume included)</Eyebrow>
          <CopyButton value={prompt} label="copy prompt" />
        </div>
        <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-inset p-3 font-mono text-xs text-text-dim">
          {prompt}
        </pre>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="resume-fill-reply">2 · paste the reply</Label>
        <Textarea
          id="resume-fill-reply"
          rows={5}
          className="font-mono text-xs"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            setOutcome(null);
          }}
          placeholder="{ … }"
        />
      </div>
      {outcome && !outcome.ok ? (
        <Alert variant="destructive" role="alert">
          <Icon name="alert" size={14} />
          <AlertDescription>
            <p className="m-0">{outcome.reason}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {outcome && outcome.ok ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="m-0 text-sm text-text">
            Filled {outcome.filled.length} {outcome.filled.length === 1 ? "field" : "fields"}
            {outcome.draft.employment_history.length > 0
              ? ` · ${outcome.draft.employment_history.length} ${outcome.draft.employment_history.length === 1 ? "role" : "roles"}`
              : ""}
            :
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {outcome.filled.map((k) => (
              <li key={k}>
                <Badge variant="secondary">{k}</Badge>
              </li>
            ))}
          </ul>
          {outcome.ignored.length > 0 ? (
            <>
              <p className="m-0 text-sm text-text-dim">Ignored — never imported:</p>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {outcome.ignored.map((k) => (
                  <li key={k}>
                    <Badge variant="outline">{k}</Badge>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => setOutcome(importDraft(pasted, draft))}>
          read it
        </Button>
        <Button
          type="button"
          disabled={!outcome?.ok}
          onClick={() => {
            if (outcome?.ok) onMerge(outcome.draft);
          }}
        >
          <Icon name="check" size={14} />
          use these answers
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Path 2: the deterministic reader's cards, each one opt-in. */
function QuickPath({
  parsed,
  draft,
  onMerge,
}: {
  parsed: ParsedResume;
  draft: ProfileDraft;
  onMerge: (merged: ProfileDraft) => void;
}): JSX.Element {
  const [roles, setRoles] = useState<Set<number>>(() => new Set(parsed.employment.map((_, i) => i)));
  const [schools, setSchools] = useState<Set<number>>(() => new Set(parsed.education.map((_, i) => i)));
  const [skills, setSkills] = useState(true);
  const [contact, setContact] = useState(true);
  const [replace, setReplace] = useState(draft.employment_history.length === 0);

  const toggle = (set: Set<number>, i: number, update: (s: Set<number>) => void): void => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    update(next);
  };
  const nothing = parsed.employment.length === 0 && parsed.education.length === 0 && parsed.skills.length === 0;
  const picked = roles.size + schools.size + (skills && parsed.skills.length > 0 ? 1 : 0);

  return (
    <div className="flex flex-col gap-4 pt-3">
      {nothing ? (
        <FieldHint tone="warn">
          The quick reader found no roles, schools or skills in this layout. The assistant tab
          handles any layout.
        </FieldHint>
      ) : (
        <FieldHint>
          Found by reading the text directly, no AI. Untick anything that is not a job; edit the
          cards after they land.
        </FieldHint>
      )}

      {parsed.employment.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow>roles · {parsed.employment.length}</Eyebrow>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {parsed.employment.map((r, i) => (
              <li key={i} className="flex items-start gap-3 rounded-md border border-border p-3">
                <Checkbox
                  id={`resume-role-${i}`}
                  checked={roles.has(i)}
                  onCheckedChange={() => toggle(roles, i, setRoles)}
                />
                <label htmlFor={`resume-role-${i}`} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
                  <span className="text-sm text-text">
                    <span className="font-heavy">{r.title || "(title?)"}</span>
                    {" · "}
                    {r.company || "(company?)"}
                  </span>
                  <span className="font-mono text-xs text-text-dim">
                    {[r.start_year && `${r.start_month} ${r.start_year}`.trim(), r.current ? "present" : r.end_year && `${r.end_month} ${r.end_year}`.trim()]
                      .filter(Boolean)
                      .join(" – ") || "no dates found"}
                    {r.location ? ` · ${r.location}` : ""}
                    {` · ${r.summary ? r.summary.split("\n").length : 0} lines`}
                  </span>
                  <span className="flex gap-2">
                    <Badge variant="outline">{r.section}</Badge>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {draft.employment_history.length > 0 ? (
            <div className="flex items-center gap-3">
              <Checkbox id="resume-replace" checked={replace} onCheckedChange={(c) => setReplace(c === true)} />
              <Label htmlFor="resume-replace" className="font-regular">
                replace the {draft.employment_history.length} {draft.employment_history.length === 1 ? "role" : "roles"} already on this step (otherwise add after them)
              </Label>
            </div>
          ) : null}
        </section>
      ) : null}

      {parsed.education.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow>schools · {parsed.education.length}</Eyebrow>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {parsed.education.map((e, i) => (
              <li key={i} className="flex items-start gap-3 rounded-md border border-border p-3">
                <Checkbox
                  id={`resume-school-${i}`}
                  checked={schools.has(i)}
                  onCheckedChange={() => toggle(schools, i, setSchools)}
                />
                <label htmlFor={`resume-school-${i}`} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
                  <span className="text-sm text-text">
                    <span className="font-heavy">{e.school}</span>
                    {e.degree ? ` · ${e.degree}` : ""}
                    {e.field ? ` in ${e.field}` : ""}
                  </span>
                  <span className="font-mono text-xs text-text-dim">
                    {[e.grad_year ? `graduating ${e.grad_month} ${e.grad_year}`.replace(/\s+/g, " ") : "", e.gpa ? `GPA ${e.gpa}` : "", e.additional_fields ? `minor ${e.additional_fields}` : ""]
                      .filter(Boolean)
                      .join(" · ") || "no dates found"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {draft.school.trim() ? (
            <FieldHint>Your primary school is already filled; these land under "other schools".</FieldHint>
          ) : null}
        </section>
      ) : null}

      {parsed.skills.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Checkbox id="resume-skills" checked={skills} onCheckedChange={(c) => setSkills(c === true)} />
            <Label htmlFor="resume-skills" className="font-regular">
              skills · {parsed.skills.length} (added to what you typed)
            </Label>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {parsed.skills.map((s) => (
              <li key={s}>
                <Badge variant="outline">{s}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {Object.keys(parsed.contact).length > 0 ? (
        <div className="flex items-center gap-3">
          <Checkbox id="resume-contact" checked={contact} onCheckedChange={(c) => setContact(c === true)} />
          <Label htmlFor="resume-contact" className="font-regular">
            fill blank contact fields ({Object.keys(parsed.contact).join(", ")})
          </Label>
        </div>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          disabled={picked === 0 && !(contact && Object.keys(parsed.contact).length > 0)}
          onClick={() => {
            const { draft: merged } = applyResumeToDraft(draft, parsed, {
              roles: [...roles].sort((a, b) => a - b),
              schools: [...schools].sort((a, b) => a - b),
              replaceRoles: replace,
              skills,
              contact,
            });
            onMerge(merged);
          }}
        >
          <Icon name="check" size={14} />
          use these
        </Button>
      </DialogFooter>
    </div>
  );
}
