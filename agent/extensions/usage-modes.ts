import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

// Set up different session modes for different use cases

type Mode = "explore" | "research" | "code";
const MODES: Mode[] = ["explore", "research", "code"];

const LABELS: Record<Mode, string> = {
  explore:
    "Explore - read the codebase, answer questions, weigh design decisions",
  research: "Research - open-ended study and investigation",
  code: "Code - write code and fix bugs",
};

const DEFAULT_MODELS: Record<Mode, string[]> = {
  explore: ["anthropic", "claude-opus-4-8"],
  research: ["google", "gemini-3.6-flash"],
  code: ["anthropic", "claude-opus-4-8"],
};

const PROMPTS: Record<Mode, string> = {
  explore: `SESSION MODE: EXPLORE.
Your job is to help understand this codebase and through through design decisons.
- Read files, trace call paths, and explain how things fit together.
- When the user floats a half-formed idea, interrogate the framing before
running with it. Bring up assumptions, trade-offs, and alternatives.
- Do NOT edit files or write implementation code unless explicitly asked.
Prefer sketches, pseudocode, and prose over patches.
- But do try to catch mistakes, code smells, and bad decisions in user-written code.`,
  research: `SESSION MODE: RESEARCH.
This is open-ended study, not writing code.
- Be prepared both for narrow, self-contained questions and broad research surveys.
- Compare approaches and cite where ideas come from.
- When something is unknown or unclear, be explicit about this, rather than seizing on your best guess.
- When working with PDFs:
  - Use \`pdfinfo\` to inspect a pdf before reading it.
  - Prefer \`pdftotext -layout\` for text extraction.
  - For long PDFs, search/extract relevant pages rather than loading the entire document.
  - If text extraction is empty or clearly corrputed, consider OCR with \`ocrmypdf\`.
  - If understand a figure, table, equation, or page layout is important,
  render the relevant page and inspect it as an image when image input is available.`,
  code: `SESSION MODE: CODE.
Implementation work: write code and fix bugs.
- Make the smallest change that solves the problem; match existing conventions.
- Ask before destructive or wide-reaching changes.
- Use top level imports unless there's strong reason for inline import.
- Don't trivialize unit tests in order to make them pass.`,
};

function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as string[]).includes(v);
}

export default function (pi: ExtensionAPI) {
  let mode: Mode | null = null;
  let disposeWriteGateAuthorizer: (() => void) | undefined;

  // Register with pi-permission-system (if installed) so `write`/`edit`
  // asks auto-allow only while in code mode; other modes fall through to
  // the normal ask prompt configured in pi-permission-system's config.
  pi.events.on("permissions:ready", () => {
    void (async () => {
      try {
        const { getPermissionsService } = await import(
          "@gotgenes/pi-permission-system"
        );
        const permissions = getPermissionsService();
        disposeWriteGateAuthorizer = permissions?.registerAuthorizer(
          "usage-mode-write-gate",
          async (details) => {
            const surface = details.toolName ?? details.payload.request.surface;
            if (mode === "code" && (surface === "write" || surface === "edit")) {
              return { kind: "allow" };
            }
            return { kind: "defer" };
          },
        );
      } catch {
        // permission-system not installed — nothing to register
      }
    })();
  });

  pi.on("session_shutdown", () => {
    disposeWriteGateAuthorizer?.();
    disposeWriteGateAuthorizer = undefined;
  });

  // 1) CLI flag: pi --mode code
  pi.registerFlag("mode", {
    description: `Session mode: ${MODES.join(" | ")}`,
    type: "string",
    default: "",
  });

  // 2) Resolve the mode at session start
  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("--mode");
    if (isMode(flag)) {
      mode = flag;
    } else {
      const labels = MODES.map((m) => LABELS[m]);
      const choice = await ctx.ui.select(
        "What are you doing this session?",
        labels,
      );
      mode = choice ? (MODES[labels.indexOf(choice)] ?? "code") : "code";
    }
    ctx.ui.setStatus("mode", `mode: ${mode}`);
    const model: Model<Api> | undefined = ctx.modelRegistry.find(
      DEFAULT_MODELS[mode][0],
      DEFAULT_MODELS[mode][1],
    );
    if (!model) {
      throw new Error(
        `Model not found: ${DEFAULT_MODELS[mode][0]}/${DEFAULT_MODELS[mode][1]}`,
      );
    }
    pi.setModel(model);
  });

  // 3) Switch mid-session: e.g. /mode research
  // does not switch model
  pi.registerCommand("mode", {
    description: "Switch session mode (explore | research | code)",
    getArgumentCompletions: (prefix: string) =>
      MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
        value: m,
        label: m,
      })),
    handler: async (args, ctx) => {
      const next = (args || "").trim();
      if (isMode(next)) {
        mode = next;
        ctx.ui.setStatus("mode", `mode: ${mode}`);
        ctx.ui.notify(`Switched to ${mode} mode`, "info");
      } else {
        ctx.ui.notify(`Usage: /mode ${MODES.join("|")}`, "warning");
      }
    },
  });

  // 4) Appy the mode's prompt on every agent run.
  // Appends to Pi's base prompt.
  // To REPALCE instead, return { systemPrompt: PROMPTS[mode] } with no base.
  pi.on("before_agent_start", async (event) => {
    if (!mode) return;
    return { systemPrompt: `${event.systemPrompt}\n\n---\n${PROMPTS[mode]}` };
  });
}
