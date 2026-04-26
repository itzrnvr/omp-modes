import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ModeDef {
  id: string;
  name: string;
  disabledTools: Set<string>;
  prompt: string;
}

const PERSIST_KEY = "modes-state";

export default function modesExtension(pi: ExtensionAPI): void {
  const modesDir = path.join(__dirname, "modes");
  const availableModes: ModeDef[] = [];
  let currentModeIndex = 0;
  let baselineTools: string[] = []; // Populated by session_start; empty before then.
  let allKnownTools: Set<string> = new Set(); // Populated by session_start.

  // ── 1. Parse mode files ────────────────────────────────────────────────────
  //
  // Supported YAML frontmatter subset:
  //   name: Display Name        (optional; defaults to filename)
  //   tools:                    (optional)
  //     tool_name: false        (disable a tool)
  //
  // Everything after the second --- is the mode prompt (injected into system
  // prompt on each agent turn). An empty prompt body means no injection.

  if (fs.existsSync(modesDir) && fs.statSync(modesDir).isDirectory()) {
    const files = fs.readdirSync(modesDir)
      .filter(f => {
        if (!f.endsWith(".md")) return false;
        try { return fs.statSync(path.join(modesDir, f)).isFile(); }
        catch { return false; }
      })
      .sort();

    for (const file of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(modesDir, file), "utf-8");
      } catch (err) {
        console.warn(`[modes] Failed to read mode file "${file}": ${err}`);
        continue;
      }
      const lines = raw.split(/\r?\n/);

      if (lines[0] !== "---") continue;
      const sep = lines.findIndex((l: string, i: number) => i > 0 && l.trim() === "---");
      if (sep === -1) continue;

      const yamlLines = lines.slice(1, sep);
      const prompt = lines.slice(sep + 1).join("\n").trim();

      let name = file.replace(".md", "");
      const disabledTools: string[] = [];
      let inTools = false;
      let hadToolsBlock = false;

      for (const line of yamlLines) {
        const trimmed = line.trim();

        // Parse tool entries while inside a tools: block
        if (inTools && (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-"))) {
          const stripped = trimmed.replace(/^-\s*/, "");
          const colonIdx = stripped.indexOf(":");
          if (colonIdx !== -1) {
            const toolName = stripped.slice(0, colonIdx).trim();
            const value = stripped.slice(colonIdx + 1).trim().toLowerCase();
            if (toolName && value === "false") {
              disabledTools.push(toolName);
            } else if (toolName && value !== "false") {
              console.warn(`[modes] Mode file "${file}": ignoring tools.${toolName}: ${value} (only false is supported)`);
            }
          }
          continue;
        }

        // Non-indented, non-empty line exits the tools block
        if (inTools && trimmed !== "") {
          inTools = false;
        }

        // Top-level fields (outside tools: block)
        if (/^name:(?: |$)/.test(trimmed)) {
          let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
          if ((parsed.startsWith('"') && parsed.endsWith('"')) ||
              (parsed.startsWith("'") && parsed.endsWith("'"))) {
            parsed = parsed.slice(1, -1);
          }
          if (parsed) name = parsed;
          continue;
        }

        if (trimmed === "tools:") {
          inTools = true;
          hadToolsBlock = true;
          continue;
        }
      }

      if (hadToolsBlock && disabledTools.length === 0) {
        console.warn(`[modes] Mode file "${file}" has a tools: block but no disabled tools were parsed. Check YAML formatting.`);
      }

      const id = file.replace(".md", "").toLowerCase();

      // Check for duplicate mode ids (case-insensitive filesystems can cause this)
      const existing = availableModes.findIndex(m => m.id === id);
      if (existing !== -1) {
        console.warn(`[modes] Duplicate mode id "${id}" (from ${file}). Overwriting previous definition.`);
        availableModes.splice(existing, 1);
      }

      availableModes.push({
        id,
        name,
        disabledTools: new Set(disabledTools),
        prompt,
      });
    }
  }

  if (availableModes.length === 0) {
    console.warn(`[modes] No valid .md files found in ${modesDir}. Extension disabled.`);
    return;
  }

  // ── 2. Mode switcher ───────────────────────────────────────────────────────

  function setMode(ctx: ExtensionContext, index: number): boolean {
    if (index < 0 || index >= availableModes.length) return false;
    if (baselineTools.length === 0) return false;

    const mode = availableModes[index];

    // Warn about tool names in the mode file that don't match any known tool.
    const unknown = [...mode.disabledTools].filter(t => !allKnownTools.has(t));
    if (unknown.length > 0) {
      console.warn(`[modes] Mode "${mode.id}" references unknown tools: ${unknown.join(", ")}`);
    }

    const active = baselineTools.filter(t => !mode.disabledTools.has(t));
    try {
      pi.setActiveTools(active);
    } catch (err) {
      console.warn(`[modes] setActiveTools failed: ${err}`);
      return false;
    }

    // Update index only after setActiveTools succeeds.
    currentModeIndex = index;
    ctx.ui.setStatus("mode-indicator", `[Mode: ${mode.name}]`);
    return true;
  }

  function persistState(): void {
    try {
      pi.appendEntry(PERSIST_KEY, { modeId: availableModes[currentModeIndex].id });
    } catch (err) {
      console.warn(`[modes] Failed to persist mode state: ${err}`);
    }
  }

  // ── 3. /mode command ───────────────────────────────────────────────────────

  pi.registerCommand("mode", {
    description: `Switch mode (${availableModes.map(m => m.id).join(" | ")})`,
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        const current = availableModes[currentModeIndex];
        const toolInfo = current.disabledTools.size > 0
          ? ` | Disabled: ${[...current.disabledTools].join(", ")}`
          : " | All tools enabled";
        ctx.ui.notify(
          `Active: ${current.name}${toolInfo}\nAvailable: ${availableModes.map(m => m.id).join(", ")}`,
          "info"
        );
        return;
      }

      const index = availableModes.findIndex(m => m.id === args.trim().toLowerCase());
      if (index === -1) {
        ctx.ui.notify(`Unknown mode. Available: ${availableModes.map(m => m.id).join(", ")}`, "error");
        return;
      }

      if (setMode(ctx, index)) {
        persistState();
        const mode = availableModes[index];
        const toolInfo = mode.disabledTools.size > 0
          ? ` (${[...mode.disabledTools].join(", ")} disabled)`
          : "";
        ctx.ui.notify(`Switched to ${mode.name}${toolInfo}`, "info");
      } else {
        ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
      }
    },
  });

  // ── 4. Ctrl+Shift+H/L shortcuts ────────────────────────────────────
  // H = previous, L = next (vim-style). No built-in conflicts.

  pi.registerShortcut(Key.ctrlShift("l"), {
    description: "Next mode",
    handler: async (ctx) => {
      const next = (currentModeIndex + 1) % availableModes.length;
      if (setMode(ctx, next)) {
        persistState();
        ctx.ui.notify(`Mode: ${availableModes[next].name}`, "info");
      } else {
        ctx.ui.notify("Session not ready yet", "warning");
      }
    },
  });

  pi.registerShortcut(Key.ctrlShift("h"), {
    description: "Previous mode",
    handler: async (ctx) => {
      const prev = (currentModeIndex - 1 + availableModes.length) % availableModes.length;
      if (setMode(ctx, prev)) {
        persistState();
        ctx.ui.notify(`Mode: ${availableModes[prev].name}`, "info");
      } else {
        ctx.ui.notify("Session not ready yet", "warning");
      }
    },
  });

  // ── 5. Inject mode prompt and PLAN.md on every provider request ──────────
  // Uses before_provider_request (not before_agent_start) because compaction can
  // happen mid-agentic-loop. before_agent_start only fires once per user prompt,
  // so the mode prompt would be lost after mid-turn compaction.

  function injectIntoPayload(payload: any, text: string): void {
    // Anthropic-style: payload.system is a string or content block array
    if (typeof payload.system === "string") {
      payload.system += text;
    } else if (Array.isArray(payload.system)) {
      payload.system.push({ type: "text", text });
    }
    // OpenAI-style: system message in messages array
    else if (Array.isArray(payload.messages)) {
      const sysMsg = payload.messages.find((m: { role?: string }) => m.role === "system");
      if (sysMsg) {
        if (typeof sysMsg.content === "string") {
          sysMsg.content += text;
        } else if (Array.isArray(sysMsg.content)) {
          sysMsg.content.push({ type: "text", text });
        }
      } else {
        payload.messages.unshift({ role: "system", content: text });
      }
    }
  }

  pi.on("before_provider_request", async (event, ctx) => {
    const mode = availableModes[currentModeIndex];
    if (!mode) return;

    // Always inject the mode prompt (compaction-safe)
    if (mode.prompt) {
      injectIntoPayload(event.payload, `\n\n[MODE: ${mode.name.toUpperCase()}]\n${mode.prompt}`);
    }

    // Plan mode: also inject PLAN.md from disk
    if (mode.id === "plan") {
      try {
        const planContent = fs.readFileSync(path.join(ctx.cwd, "PLAN.md"), "utf-8").trim();
        if (planContent) {
          injectIntoPayload(event.payload, `\n\n[Current PLAN.md]\n${planContent}`);
        }
      } catch {
        // No PLAN.md yet — that's fine
      }
    }
  });

  // ── 6. --mode CLI flag ─────────────────────────────────────────────────────

  pi.registerFlag("mode", {
    description: `Start in a specific mode (${availableModes.map(m => m.id).join(" | ")})`,
    type: "string",
  });

  // ── 7. Bootstrap ───────────────────────────────────────────────────────────
  // session_start is the only safe place to capture baseline tools — all extensions
  // have registered by this point, so the tool list is complete.

  pi.on("session_start", async (_event, ctx) => {
    try {
      baselineTools = pi.getActiveTools();
      allKnownTools = new Set(pi.getAllTools().map(t => t.name));
    } catch (err) {
      console.warn(`[modes] Failed to initialize tools: ${err}`);
      return;
    }

    if (baselineTools.length === 0) {
      ctx.ui.notify("[modes] No active tools found. Mode restore skipped.", "warning");
      return;
    }

    // Restore persisted mode, or apply --mode flag, or fall back to edit/first.
    const entries = ctx.sessionManager.getEntries();
    let restoredId: string | undefined;

    // Reverse-iterate to find the most recent persisted state quickly.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === PERSIST_KEY) {
        const data = entry.data as { modeId?: string } | undefined;
        if (typeof data?.modeId === "string") {
          restoredId = data.modeId;
          break;
        }
      }
    }

    const modeFlag = pi.getFlag("mode");
    let targetIndex: number;

    if (typeof modeFlag === "string" && modeFlag) {
      // CLI flag takes priority
      const flagIndex = availableModes.findIndex(m => m.id === modeFlag.toLowerCase());
      if (flagIndex !== -1) {
        targetIndex = flagIndex;
      } else {
        console.warn(`[modes] Unknown --mode "${modeFlag}". Available: ${availableModes.map(m => m.id).join(", ")}`);
        const fallback = availableModes.findIndex(m => m.id === "edit");
        const restoredIndex = restoredId ? availableModes.findIndex(m => m.id === restoredId) : -1;
        targetIndex = restoredIndex !== -1 ? restoredIndex : (fallback !== -1 ? fallback : 0);
      }
    } else if (restoredId) {
      const restoredIndex = availableModes.findIndex(m => m.id === restoredId);
      if (restoredIndex !== -1) {
        targetIndex = restoredIndex;
      } else {
        // Mode was removed since last session — fall back to edit/first
        console.warn(`[modes] Previously active mode "${restoredId}" no longer exists.`);
        const editIndex = availableModes.findIndex(m => m.id === "edit");
        targetIndex = editIndex !== -1 ? editIndex : 0;
      }
    } else {
      const editIndex = availableModes.findIndex(m => m.id === "edit");
      targetIndex = editIndex !== -1 ? editIndex : 0;
    }

    if (setMode(ctx, targetIndex)) {
      ctx.ui.notify(`Mode: ${availableModes[targetIndex].name}`, "info");
    }
  });
}
