#!/usr/bin/env node
/**
 * S-spike navigate sidecar (Stagehand engine).
 *
 * Contract: ONE JSON AgentNavigateTask on stdin, exactly ONE JSON
 * AgentNavigateResult on stdout (src/agent/contract.ts is authoritative —
 * the Node side zod-validates and rejects anything off-contract; this
 * process's self-report is never trusted). Progress rides stderr as
 * NDJSON {"jaa_progress":1,...} lines, same as the Python sidecar.
 *
 * Seam: attaches to the operator's already-running CDP Chrome
 * (task.cdp_url) — it NEVER launches a browser, and Stagehand's close()
 * leaves a connected browser running by design.
 *
 * Safety mirrors the browser_use sidecar's navigation rules: navigation
 * only — never answer application-form questions, never click a submit
 * control, never touch demographic questions, stop and report on any
 * CAPTCHA. Fail-safe by construction: every failure path (dependency not
 * installed, CDP unreachable, agent error, timeout) still emits a
 * contract-valid error result, so the orchestrator's turn accounting and
 * telemetry see a failed TURN, not a crashed phase.
 */
import process from "node:process";

const STEP_CAP = 25;

function emit(result) {
  process.stdout.write(JSON.stringify(result));
}

function progress(event) {
  try {
    process.stderr.write(`${JSON.stringify({ jaa_progress: 1, ...event })}\n`);
  } catch {
    /* progress is telemetry, never worth dying for */
  }
}

function errorResult(reason, extra = {}) {
  return {
    status: "error",
    final_url: null,
    wall: "none",
    steps_used: 0,
    domains_visited: [],
    notes: [],
    reason: String(reason).slice(0, 500),
    ...extra,
  };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Wall classification from the agent's own summary text — coarse on purpose. */
function classifyWall(message) {
  const m = (message || "").toLowerCase();
  if (/captcha|verify you are human|challenge/.test(m)) return "captcha";
  if (/phone|sms|otp/.test(m)) return "phone_otp";
  if (/log ?in|sign ?in|password|account|authenticat/.test(m)) return "auth";
  return "budget";
}

const SYSTEM_RULES = [
  "You navigate to an employer's job application form. NAVIGATION ONLY:",
  "- Never answer application questions, never fill form fields beyond what navigation itself requires (e.g. a cookie banner dismiss).",
  "- Never click any Submit/Send Application control. Reaching the form IS the goal.",
  "- Never interact with demographic or self-identification questions.",
  "- If a CAPTCHA or human-verification challenge appears, STOP immediately and say so.",
  "- If a login wall appears and you were not given credentials, STOP and say so.",
  "- Stay on job-board / employer-career domains. Never open unrelated sites.",
].join("\n");

async function main() {
  let task;
  try {
    task = JSON.parse(await readStdin());
  } catch (err) {
    emit(errorResult(`task JSON unreadable: ${err?.message ?? err}`));
    return;
  }
  if (!task || task.task_type !== "navigate" || !task.cdp_url || !task.goal) {
    emit(errorResult("task is not a navigate task (need task_type, cdp_url, goal)"));
    return;
  }

  let stagehandModule;
  try {
    stagehandModule = await import("@browserbasehq/stagehand");
  } catch {
    emit(
      errorResult(
        "stagehand engine not installed — run `npm install` in agent/stagehand (see docs/agent-engine-decision.md), or set AGENT_ENGINE=browser_use",
      ),
    );
    return;
  }
  const { Stagehand, localBrowser } = stagehandModule;

  progress({ phase: "attach", cdp: true });
  let browser;
  try {
    browser = await localBrowser.connect({ cdpUrl: task.cdp_url });
  } catch (err) {
    emit(
      errorResult(
        `CDP attach failed at ${task.cdp_url}: ${err?.message ?? err} — is the debug Chrome running (npm run chrome:debug:jobright)?`,
      ),
    );
    return;
  }

  let stagehand = null;
  const visited = new Set();
  try {
    stagehand = await Stagehand.create({ browser });
    const pages = await browser.context.pages();
    const page = pages[pages.length - 1] ?? (await browser.context.newPage());
    const startHost = hostOf(task.start_url);
    if (startHost) visited.add(startHost);
    await page.goto(task.start_url, { waitUntil: "domcontentloaded" });
    progress({ phase: "start", host: startHost });

    const model = process.env.STAGEHAND_MODEL || "anthropic/claude-sonnet-4-5";
    const agent = stagehand.agent({
      mode: "dom",
      model,
      systemPrompt: SYSTEM_RULES,
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(30_000, Math.min(300_000, task.timeout_ms ?? 180_000)),
    );
    let agentResult;
    try {
      agentResult = await agent.execute({
        instruction: task.goal,
        maxSteps: Math.min(task.max_steps ?? STEP_CAP, STEP_CAP),
        signal: controller.signal,
        // Secrets ride ONLY as agent variables — never into notes/results.
        ...(task.credentials?.available && task.credentials.username
          ? {
              variables: {
                username: task.credentials.username,
                password: task.credentials.password ?? "",
              },
            }
          : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    const finalUrl = (() => {
      try {
        return page.url();
      } catch {
        return null;
      }
    })();
    const finalHost = finalUrl ? hostOf(finalUrl) : null;
    if (finalHost) visited.add(finalHost);
    const steps = Array.isArray(agentResult?.actions)
      ? agentResult.actions.length
      : 0;
    const message = String(agentResult?.message ?? "").slice(0, 500);

    if (agentResult?.success && finalUrl && finalUrl.startsWith("https://")) {
      emit({
        status: "ok",
        final_url: finalUrl,
        wall: "none",
        steps_used: steps,
        domains_visited: [...visited].slice(0, 50),
        notes: message ? [message] : [],
      });
      return;
    }
    emit({
      status: "error",
      final_url: null,
      wall: classifyWall(message),
      steps_used: steps,
      domains_visited: [...visited].slice(0, 50),
      notes: message ? [message] : [],
      reason: message || "agent did not report success",
    });
  } catch (err) {
    const aborted = err?.name === "AbortError" || /abort/i.test(String(err?.message));
    emit(
      errorResult(
        aborted
          ? "navigate turn timed out"
          : `stagehand turn failed: ${String(err?.message ?? err).slice(0, 300)}`,
        {
          wall: "budget",
          domains_visited: [...visited].slice(0, 50),
        },
      ),
    );
  } finally {
    // close() detaches; a browser we connected to (not launched) stays up.
    try {
      await stagehand?.close();
    } catch {
      /* detach best-effort */
    }
  }
}

void main();
