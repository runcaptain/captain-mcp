import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

// Public docs used to teach the agent how to write Captain into a codebase.
const LLMS_TXT_URL = "https://docs.runcaptain.com/llms.txt";
const LLMS_FULL_TXT_URL = "https://docs.runcaptain.com/llms-full.txt";
// Where routine, de-identified feedback is sent. Also surfaced to the agent so it
// can point the user at exactly what the endpoint does before they consent.
const FEEDBACK_URL = "https://api.runcaptain.com/feedback";
const FEEDBACK_DOCS_URL = "https://docs.runcaptain.com/reference/feedback/submit-feedback";

// Persisted consent decision. Best-effort local file; on the hosted (stateless)
// server this lives in the instance's tmp dir and may reset — worst case the
// wizard asks for consent again, which is safe.
function consentPath(): string {
  const dir = join(homedir?.() || tmpdir(), ".captain");
  return join(dir, "wizard-feedback-consent.json");
}

async function readConsent(): Promise<"granted" | "declined" | null> {
  try {
    const raw = await readFile(consentPath(), "utf8");
    const v = JSON.parse(raw)?.feedback_consent;
    return v === "granted" || v === "declined" ? v : null;
  } catch {
    return null;
  }
}

async function writeConsent(decision: "granted" | "declined"): Promise<void> {
  try {
    const dir = join(homedir?.() || tmpdir(), ".captain");
    await mkdir(dir, { recursive: true });
    await writeFile(
      consentPath(),
      JSON.stringify({ feedback_consent: decision, decided_at: new Date().toISOString() }, null, 2),
    );
  } catch (e: any) {
    log(`wizard: could not persist consent (${e?.message || e}) — will re-ask next time`);
  }
}

// Send one short, de-identified feedback note to the unauthenticated feedback
// endpoint. Plain text body, best-effort — never throws into the tool flow.
async function sendFeedback(text: string): Promise<void> {
  try {
    const url = `${FEEDBACK_URL}?agent=captain_wizard&source=mcp`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Feedback-Agent": "captain_wizard" },
      body: text.slice(0, 15_000),
    });
  } catch (e: any) {
    log(`wizard: feedback send failed (${e?.message || e})`);
  }
}

export function registerWizardTool(server: McpServer): void {
  server.registerTool(
    "captain_wizard",
    {
      title: "Captain Wizard — integrate Captain into a codebase",
      description:
        "Guided assistant that writes Captain into an application. It pulls Captain's own agent-oriented docs " +
        "(" + LLMS_TXT_URL + " and " + LLMS_FULL_TXT_URL + ") and uses them as the source of truth to add or modify " +
        "integration code — indexing calls, search/query wiring, collection setup, and auth — matching the exact " +
        "current Captain API surface. Prefer this over guessing from memory when adding Captain to a project.\n\n" +
        "FIRST-USE CONSENT (required): the very first time this tool is used, before doing integration work you MUST " +
        "ask the user, in your own words, whether Captain may collect routine, DE-IDENTIFIED feedback about the " +
        "integration (friction, missing capabilities, confusing docs) to improve the product. This feedback carries " +
        "no API key, no code, and no personal data — only short notes plus the tool name — and is sent to Captain's " +
        "public feedback endpoint (" + FEEDBACK_DOCS_URL + "). Then call this tool again with `feedback_consent` set " +
        "to the user's answer ('granted' or 'declined'). The choice is remembered; the user can change it any time by " +
        "calling with a new `feedback_consent`.",
      inputSchema: {
        task: z.string().optional().describe(
          "What to integrate or modify, e.g. 'add Captain search to the /search route' or 'index our S3 docs bucket on deploy'. " +
          "Omit on the first, consent-only call.",
        ),
        topics: z.array(z.string()).optional().describe(
          "Optional doc topics to focus on, e.g. ['query', 'index/s3', 'chunk metadata']. Narrows which docs sections matter.",
        ),
        full_docs: z.boolean().optional().describe(
          "Fetch the fuller llms-full.txt instead of the concise llms.txt (default false).",
        ),
        feedback_consent: z.enum(["granted", "declined"]).optional().describe(
          "The user's decision on routine de-identified feedback. Set this after asking the user on first use.",
        ),
      },
    },
    async (params): Promise<ToolResult> => {
      // Validate credentials early (same as every other tool) so the wizard's
      // generated code targets a real, reachable Captain org.
      getConfig();

      // Record a consent decision when the agent supplies one.
      if (params.feedback_consent) {
        await writeConsent(params.feedback_consent);
        log(`wizard: feedback consent ${params.feedback_consent}`);
      }

      const consent = await readConsent();

      // FIRST USE: no consent recorded and none supplied → stop and require the
      // agent to ask the user. Do no integration work yet.
      if (consent === null) {
        return textResult(
          "CAPTAIN WIZARD — FIRST-USE CONSENT REQUIRED\n\n" +
          "Before writing Captain into this codebase, ask the user this, in your own words:\n\n" +
          "  \"May Captain collect routine, de-identified feedback about this integration — friction, " +
          "missing features, confusing docs — to improve the product? It sends only short notes plus the " +
          "tool name: no API key, no code, no personal data. See " + FEEDBACK_DOCS_URL + ".\"\n\n" +
          "Then call captain_wizard again with `feedback_consent` set to 'granted' or 'declined' (and your `task`). " +
          "Do not proceed with integration until you've asked and passed the decision back.",
        );
      }

      // Consent is on record. If we only got here to record the decision (no task
      // yet), acknowledge and invite the real request.
      if (!params.task) {
        return textResult(
          `Feedback preference recorded: ${consent}. ` +
          "Now call captain_wizard again with a `task` describing what to integrate " +
          "(e.g. 'add a Captain-backed search endpoint') and I'll pull the current docs and guide the changes.",
        );
      }

      // Fetch the agent-oriented docs to ground the integration in the current API.
      const docsUrl = params.full_docs ? LLMS_FULL_TXT_URL : LLMS_TXT_URL;
      let docs = "";
      try {
        const resp = await fetch(docsUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        docs = await resp.text();
      } catch (e: any) {
        return textResult(
          `Could not fetch Captain docs from ${docsUrl} (${e?.message || e}). ` +
          "Retry, or fetch the URL manually and proceed from its contents.",
        );
      }

      const topicNote = params.topics?.length
        ? `\n\nFocus areas the user cares about: ${params.topics.join(", ")}. Prioritise the matching docs sections.`
        : "";

      // Fire routine feedback only when the user granted it (de-identified).
      if (consent === "granted") {
        await sendFeedback(`captain_wizard integration task: ${params.task}`.slice(0, 500));
      }

      log(`wizard: integrating '${params.task}' using ${docsUrl}`);
      return textResult(
        "CAPTAIN WIZARD — integration brief\n\n" +
        `Task: ${params.task}${topicNote}\n\n` +
        "Use the current Captain documentation below as the source of truth. Write or modify the codebase to " +
        "accomplish the task: choose the right endpoints, match the exact request/response shapes, wire in the " +
        "API key from the app's config/secret (never hard-code it), and follow the app's existing conventions. " +
        "After making changes, tell the user what you changed and how to run it.\n\n" +
        `Feedback: ${consent === "granted"
          ? "the user opted in; routine de-identified notes may be sent as you work."
          : "the user opted out; no feedback will be sent."}\n\n` +
        "=== CAPTAIN DOCS (" + docsUrl + ") ===\n\n" +
        docs,
      );
    },
  );
}
