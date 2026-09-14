import type { ReactNode } from "react";
import { useFieldArray, useFormContext } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import {
  EMPLOYMENT_MAX_ROLES,
  EMPLOYMENT_SUMMARY_MAX,
  EMPLOYMENT_TYPE_OPTIONS,
  EMPTY_EDUCATION_ENTRY,
  EMPTY_EMPLOYMENT_ENTRY,
  HOW_HEARD_SUGGESTIONS,
  SCREENER_QUESTIONS,
  WORK_AUTH_OPTIONS,
} from "../contract";
import {
  CheckboxGroupField,
  CheckField,
  ChoiceField,
  LongTextField,
  ScreenerField,
  TextField,
} from "./fields";
import { ImportPromptDialog } from "./ImportPromptDialog";
import { ResumeFillDialog } from "./ResumeFillDialog";
import {
  ABOUT_MAX,
  ABOUT_MIN,
  aboutLenient,
  aboutStrict,
  compensationLenient,
  compensationStrict,
  contactLenient,
  contactStrict,
  educationLenient,
  educationStrict,
  eligibilityLenient,
  eligibilityStrict,
  experienceLenient,
  experienceStrict,
  identityLenient,
  identityStrict,
  preferencesLenient,
  preferencesStrict,
} from "./schema";
import { ProfileStepForm, type StepProps } from "./StepChrome";

/**
 * Steps whose answers are the user's own words, saved to the profile row
 * and the screener bank. What each step asks is decided in steps.ts (and
 * gated there by the coverage test); this file only lays it out.
 *
 * No demographic / EEO question appears on any of these steps.
 * Self-identification is its own opt-in, encrypted step (selfId.ts,
 * decision 2026-09-11), never on the profile draft.
 */

const TRI: ReadonlyArray<{ value: string; label: string }> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

function Grid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>;
}

function Screeners({ keys }: { keys: readonly string[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      {keys.map((key) => {
        const q = SCREENER_QUESTIONS.find((x) => x.key === key);
        return q ? <ScreenerField key={key} question={q} /> : null;
      })}
    </div>
  );
}

/* ── 1 identity ─────────────────────────────────────────────────────── */

export function IdentityStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={identityLenient} strict={identityStrict}>
      <ImportPromptDialog draft={props.draft} onMerge={props.onImported} />
      <Grid>
        <TextField name="legal_first_name" label="legal first name" autoComplete="given-name" />
        <TextField name="legal_last_name" label="legal last name" autoComplete="family-name" />
        <TextField
          name="legal_middle_name"
          label="legal middle name"
          optional
          autoComplete="additional-name"
        />
        <TextField
          name="preferred_name"
          label="preferred name"
          optional
          hint="What a form's preferred-name field gets. Blank means your legal first name."
        />
      </Grid>
      <TextField
        name="contact_email"
        label="contact email"
        optional
        type="email"
        inputMode="email"
        autoComplete="email"
        hint="Blank means the email you sign in with."
      />
      <Separator />
      <Grid>
        <TextField name="linkedin_url" label="LinkedIn URL" optional type="url" inputMode="url" placeholder="https://linkedin.com/in/…" />
        <TextField name="github_url" label="GitHub URL" optional type="url" inputMode="url" placeholder="https://github.com/…" />
        <TextField name="portfolio_url" label="personal website" optional type="url" inputMode="url" placeholder="https://…" />
      </Grid>
    </ProfileStepForm>
  );
}

/* ── 2 contact & address ────────────────────────────────────────────── */

export function ContactStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={contactLenient} strict={contactStrict}>
      <TextField
        name="phone"
        label="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="+1 412 555 0100"
        hint="Most forms require one. Dispatch never calls or texts it."
      />
      <Grid>
        <TextField name="address_line1" label="street address" optional autoComplete="address-line1" />
        <TextField name="address_line2" label="apartment, suite" optional autoComplete="address-line2" />
        <TextField name="location_city" label="city" autoComplete="address-level2" placeholder="Pittsburgh" />
        <TextField name="location_region" label="state / region" optional autoComplete="address-level1" placeholder="PA" />
        <TextField name="postal_code" label="postal code" optional autoComplete="postal-code" />
        <TextField name="location_country" label="country" autoComplete="country-name" placeholder="United States" />
      </Grid>
      <FieldHint>
        Some forms ask for a full address; without one on file those fields become a to-do
        for that application instead of a guess.
      </FieldHint>
    </ProfileStepForm>
  );
}

/* ── 3 education ────────────────────────────────────────────────────── */

function MoreEducation(): JSX.Element {
  const { control } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: "more_education" });
  return (
    <div className="flex flex-col gap-4">
      <Eyebrow as="h2">other schools</Eyebrow>
      {fields.length === 0 ? (
        <FieldHint>A transfer, study abroad, or an earlier degree — add it if forms should see it.</FieldHint>
      ) : null}
      {fields.map((f, i) => (
        <div key={f.id} className="flex flex-col gap-4 rounded-md border border-border p-4">
          <Grid>
            <TextField name={`more_education.${i}.school`} label="school" />
            <TextField name={`more_education.${i}.degree`} label="degree" optional />
            <TextField name={`more_education.${i}.field`} label="field of study" optional />
            <TextField name={`more_education.${i}.grad_year`} label="graduation year" optional inputMode="numeric" />
          </Grid>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => remove(i)}>
              <Icon name="x" size={14} />
              remove this school
            </Button>
          </div>
        </div>
      ))}
      {fields.length < 5 ? (
        <div>
          <Button type="button" variant="outline" onClick={() => append({ ...EMPTY_EDUCATION_ENTRY })}>
            <Icon name="plus" size={14} />
            add another school
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function EducationStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={educationLenient} strict={educationStrict}>
      <TextField name="school" label="school" autoComplete="organization" placeholder="University of Pittsburgh" hint="The one you attend now, or attended most recently." />
      <Grid>
        <TextField name="degree" label="degree" optional placeholder="Bachelor of Science" />
        <TextField name="field" label="major" optional placeholder="Computer Science" />
        <TextField name="start_month" label="start month" optional placeholder="August" />
        <TextField name="start_year" label="start year" optional inputMode="numeric" placeholder="2023" />
        <TextField name="grad_month" label="graduation month" optional placeholder="May" hint="Expected is fine." />
        <TextField name="grad_year" label="graduation year" optional inputMode="numeric" placeholder="2027" />
        <TextField name="gpa" label="GPA" optional inputMode="numeric" placeholder="3.7" hint="Only if you want forms to show it." />
        <TextField name="additional_fields" label="minors or second majors" optional placeholder="Statistics" />
      </Grid>
      <Separator />
      <MoreEducation />
    </ProfileStepForm>
  );
}

/* ── 4 experience & skills ──────────────────────────────────────────── */

function EmploymentHistory(): JSX.Element {
  const { control, getValues, setValue } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: "employment_history" });
  // A reader (or a model) can put the employer where the title goes; one
  // click fixes it instead of retyping both.
  const swap = (i: number): void => {
    const company = getValues(`employment_history.${i}.company`) as string;
    const title = getValues(`employment_history.${i}.title`) as string;
    setValue(`employment_history.${i}.company`, title, { shouldDirty: true });
    setValue(`employment_history.${i}.title`, company, { shouldDirty: true });
  };
  return (
    <div className="flex flex-col gap-4">
      <Eyebrow as="h2">roles</Eyebrow>
      {fields.length === 0 ? (
        <FieldHint>Jobs, internships, research positions. None yet is a fine answer.</FieldHint>
      ) : null}
      {fields.map((f, i) => (
        <div key={f.id} className="flex flex-col gap-4 rounded-md border border-border p-4">
          <Grid>
            <TextField name={`employment_history.${i}.company`} label="company" />
            <TextField name={`employment_history.${i}.title`} label="title" />
            <TextField
              name={`employment_history.${i}.location`}
              label="location"
              optional
              placeholder="Baltimore, MD"
              hint="City and state; blank or Remote means your home city on forms that require one."
            />
            <TextField name={`employment_history.${i}.start_month`} label="start month" optional placeholder="June" />
            <TextField name={`employment_history.${i}.start_year`} label="start year" optional inputMode="numeric" placeholder="2025" />
            <TextField name={`employment_history.${i}.end_month`} label="end month" optional placeholder="August" />
            <TextField name={`employment_history.${i}.end_year`} label="end year" optional inputMode="numeric" placeholder="2025" />
          </Grid>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <CheckField name={`employment_history.${i}.current`} label="I work here now" />
            <CheckField name={`employment_history.${i}.remote`} label="remote role" />
          </div>
          <LongTextField
            name={`employment_history.${i}.summary`}
            label="what you did"
            optional
            max={EMPLOYMENT_SUMMARY_MAX}
            rows={6}
            hint="Be specific and complete — one line per accomplishment, with the tools, numbers and outcomes. Forms with a description box get this verbatim, so more is better than less."
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => swap(i)}>
              <Icon name="refresh" size={14} />
              swap company and title
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => remove(i)}>
              <Icon name="x" size={14} />
              remove this role
            </Button>
          </div>
        </div>
      ))}
      {fields.length < EMPLOYMENT_MAX_ROLES ? (
        <div>
          <Button type="button" variant="outline" onClick={() => append({ ...EMPTY_EMPLOYMENT_ENTRY })}>
            <Icon name="plus" size={14} />
            add a role
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ExperienceStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={experienceLenient} strict={experienceStrict}>
      <ResumeFillDialog draft={props.draft} onMerge={props.onImported} />
      <TextField name="current_company" label="current employer" optional hint="Forms that ask where you work now get this; blank means none." />
      <LongTextField
        name="skills"
        label="skills"
        optional
        max={2000}
        rows={3}
        hint="Comma-separated, and complete — every language, framework, tool and method you would defend in an interview. Forms match their skill pickers against this list."
      />
      <Separator />
      <EmploymentHistory />
    </ProfileStepForm>
  );
}

/* ── 6 work eligibility & logistics ─────────────────────────────────── */

export function EligibilityStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={eligibilityLenient} strict={eligibilityStrict}>
      <p className="m-0 text-base leading-relaxed text-text-dim">
        These go onto forms exactly as you set them. Dispatch never guesses either of the
        first two, and an imported resume never fills them.
      </p>
      <ChoiceField
        name="work_authorization"
        label="Your work authorization in the United States"
        options={WORK_AUTH_OPTIONS}
      />
      <ChoiceField
        name="needs_sponsorship"
        label="Will you now or in the future require sponsorship?"
        options={TRI}
      />
      <ChoiceField
        name="open_to_relocation"
        label="Open to relocating for a role?"
        options={TRI}
        unsetLabel="ask me per application"
      />
      <ChoiceField
        name="restrictive_covenants"
        label="Are you bound by a non-compete or other restrictive covenant?"
        options={TRI}
        unsetLabel="ask me per application"
      />
      <Separator />
      <Eyebrow as="h2">questions forms ask</Eyebrow>
      <FieldHint>
        Leave any of these unanswered and applications that ask become a quick to-do for you
        instead.
      </FieldHint>
      <Screeners keys={props.step.screeners} />
    </ProfileStepForm>
  );
}

/* ── 7 compensation & how-heard ─────────────────────────────────────── */

export function CompensationStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={compensationLenient} strict={compensationStrict}>
      <TextField
        name="how_heard"
        label="How did you hear about us — your usual answer"
        optional
        suggestions={HOW_HEARD_SUGGESTIONS}
        hint="Forms ask this about the employer. Dispatch picks your answer from each form's own list."
      />
      <TextField
        name="how_heard_fallbacks"
        label="fallback answers"
        optional
        placeholder="Job board, Company website"
        hint="Comma-separated, in order — used when a form's list does not have your first answer."
      />
      <Separator />
      <Screeners keys={props.step.screeners} />
    </ProfileStepForm>
  );
}

/* ── 8 about you ────────────────────────────────────────────────────── */

export function AboutStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={aboutLenient} strict={aboutStrict}>
      <p className="m-0 text-base leading-relaxed text-text-dim">
        In your own voice: what you have built, what you are good at, what you want next.
        Open-ended application questions are answered from this text and nothing else — if
        it is not here, Dispatch leaves the question for you.
      </p>
      <LongTextField
        name="about_me"
        label="about you"
        min={ABOUT_MIN}
        max={ABOUT_MAX}
        rows={12}
        hint="The import on the first step can draft this from your resume for you to edit."
      />
    </ProfileStepForm>
  );
}

/* ── 12 preferences ─────────────────────────────────────────────────── */

const REMOTE_OPTIONS = [
  { value: "remote", label: "remote" },
  { value: "hybrid", label: "hybrid" },
  { value: "onsite", label: "on-site" },
  { value: "any", label: "any" },
] as const;

export function PreferencesStep(props: StepProps): JSX.Element {
  return (
    <ProfileStepForm props={props} lenient={preferencesLenient} strict={preferencesStrict}>
      <TextField name="titles" label="roles you want" placeholder="Software Engineer Intern, Data Analyst" hint="Comma-separated." />
      <TextField name="locations" label="locations" optional placeholder="New York, remote" hint="Comma-separated, or anywhere." />
      <ChoiceField name="remote" label="work style" options={REMOTE_OPTIONS} unsetLabel="no preference" />
      <CheckboxGroupField
        name="employment_types"
        label="employment types"
        options={EMPLOYMENT_TYPE_OPTIONS.map((t) => ({ value: t, label: t.replace("_", "-") }))}
      />
      <TextField name="min_salary_usd" label="minimum salary, USD per year" optional inputMode="numeric" placeholder="70000" />
    </ProfileStepForm>
  );
}
