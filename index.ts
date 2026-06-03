import { ExtensionAPI, type ExtensionContext, theme } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { Key, truncateToWidth, type EditorTopBorder } from "@oh-my-pi/pi-tui";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
interface ModeDef {
  id: string;
  name: string;
  color: string;
  disabledTools: Set<string>;
  prompt: string;
  path: string;
  /** True for the synthetic "default" mode that injects no mode prompt and
   *  disables no tools.  Synthesized by the extension; not loaded from disk. */
  isDefault?: boolean;
}

const PERSIST_KEY = "modes-state";

export default function modesExtension(pi: ExtensionAPI): void {
  // Resolve modes directory: check well-known locations first, then fall back
  // to __dirname/modes (for development). OMP copies index.ts to a temp dir
  // for compilation, so __dirname/modes won't exist at runtime.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(home, ".omp/agent/modes"),           // user-level (well-known)
    path.join(process.cwd(), ".omp/modes"),         // project-level
    path.join(__dirname, "modes"),                  // fallback (dev only)
  ];
  const modesDir = candidates.find(d => fs.existsSync(d) && fs.statSync(d).isDirectory()) || candidates[0];
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
      let color = "accent";
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

        if (/^color:(?: |$)/.test(trimmed)) {
          const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
          if (parsed) color = parsed;
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
        color,
        disabledTools: new Set(disabledTools),
        prompt,
        path: path.join(modesDir, file),
      });
    }
  // ── 1a. Synthesize "default" mode ─────────────────────────────────────────
  // Always present.  No tools disabled, no prompt injected.  Use this when you
  // want OMP's original system prompt with no mode-specific instructions.
  availableModes.unshift({
    id: "default",
    name: "Default",
    color: "muted",
    disabledTools: new Set(),
    prompt: "",
    path: "",
    isDefault: true,
  });
  if (availableModes.length === 1) {
    console.warn(`[modes] No valid .md files found in ${modesDir}. Only the synthetic "default" mode is available.`);
  }
  // ── 1b. Custom editor with mode indicator in top border ───────────────────
  //
  // Subclass `CustomEditor` (the standard OMP editor) and override
  // `setTopBorder()` to prepend the active mode name to the statusline
  // content.  `updateEditorTopBorder()` calls `setTopBorder()` on every
  // agent event, resize, and mode-status change — so the indicator
  // refreshes automatically.
  class ModeEditor extends CustomEditor {
    #storedContent: EditorTopBorder | undefined;

    setTopBorder(content: EditorTopBorder | undefined): void {
      this.#storedContent = content;
      super.setTopBorder(this.#applyMode(content));
    }

    // Re-apply mode indicator on every render cycle so the indicator
    // updates immediately when currentModeIndex changes, without
    // needing updateEditorTopBorder() from the extension.
    render(width: number): string[] {
      super.setTopBorder(this.#applyMode(this.#storedContent));
      return super.render(width);
    }

    // Insert the mode indicator just before the model name in the top border.
    // The statusline format is: " π  │ ⬢ ModelName ... │ path ... │ context ..."
    // We insert " PLAN │ " right before ⬢ to make it a separate segment.
    #applyMode(content: EditorTopBorder | undefined): EditorTopBorder | undefined {
      if (!content) return content;
      const mode = availableModes[currentModeIndex];
      if (!mode) return content;
      const label = ` ${mode.name.toUpperCase()} `;
      const colored = theme.fg(mode.color as any, label);
      const sep = theme.fg("statusLineSep" as any, "│");
      const insert = colored + " " + sep + " ";
      // Visible width of the inserted text: label (ASCII) + " │ " = label.length + 3
      const insertWidth = label.length + 3;
      // Find the model icon ⬢ (U+2B22) in the content, skipping ANSI codes.
      // Insert the mode indicator right before it so it sits between the first
      // separator and the model name.
      const pos = this.#findVisibleChar(content.content, "\u2B22");
      if (pos === -1) {
        // Fallback: no model icon found — truncate and append at end
        const available = Math.max(0, content.width - label.length);
        return { content: truncateToWidth(content.content, available) + colored, width: content.width };
      }
      return {
        content: content.content.slice(0, pos) + insert + content.content.slice(pos),
        width: content.width + insertWidth,
      };
    }

    // Find the first visible occurrence of `ch` in a string that may contain
    // ANSI escape sequences, returning its byte index.  Returns -1 if not found.
    #findVisibleChar(str: string, ch: string): number {
      let i = 0;
      while (i < str.length) {
        if (str[i] === "\x1b") {
          // Skip CSI sequence: ESC [ ... m (or any final byte)
          i++;
          if (i < str.length && str[i] === "[") {
            i++;
            while (i < str.length && str[i] !== "m") i++;
            if (i < str.length) i++; // skip the 'm'
          }
          continue;
        }
        if (str.startsWith(ch, i)) return i;
        i++;
      }
      return -1;
    }
  }

  // ── 2. Mode switcher ───────────────────────────────────────────────────────

  // Cached prompt for the current mode — only re-read from disk on mode switch.
  let cachedPrompt: string = "";
  let previousModeId: string = "";

  function loadPrompt(mode: ModeDef): string {
    try {
      return fs.readFileSync(mode.path, "utf-8").trim();
    } catch {
      return mode.prompt;
    }
  }

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
    // Update index and cache prompt only after setActiveTools succeeds.
    previousModeId = availableModes[currentModeIndex]?.id || "";
    currentModeIndex = index;
    cachedPrompt = loadPrompt(mode);
    return true;
  }

  function persistState(): void {
    try {
      pi.appendEntry(PERSIST_KEY, { modeId: availableModes[currentModeIndex].id });
    } catch (err) {
      console.warn(`[modes] Failed to persist mode state: ${err}`);
    }
  }

  // Inject a mode switch marker into the conversation so the model knows
  // the context boundary between modes.
  function notifyModeSwitch(oldModeId: string, newModeId: string): void {
    // Default mode is the original baseline — no marker injection, no status
    // chatter.  The model sees the unmodified system prompt.
    if (newModeId === "default") return;
    // Also suppress when coming from default (oldModeId "" means default was
    // active but never injected a marker — no point saying "DEFAULT → EDIT").
    if (!oldModeId) return;
    const oldName = oldModeId.toUpperCase();
    const newName = newModeId.toUpperCase();
    const tools = availableModes[currentModeIndex];
    const disabled = tools.disabledTools.size > 0
      ? ` Tools disabled: ${[...tools.disabledTools].join(", ")}.`
      : "";
    const marker = [
      `[MODE SWITCH: ${oldName} → ${newName}]`,
      `You are now in ${newName} mode.${disabled}`,
      `Previous responses were under ${oldName} mode rules. From this point forward, follow ${newName} mode rules.`,
    ].join(" ");
    try {
      pi.sendMessage({ customType: "mode-switch", content: marker, display: false });
    } catch {
      // sendMessage may not be available in all contexts
    }
  }

  function persistAndNotifySwitch(oldModeId: string): void {
    persistState();
    notifyModeSwitch(oldModeId, availableModes[currentModeIndex].id);
  }

  // ── 3. /mode command ───────────────────────────────────────────────────────

  pi.registerCommand("mode", {
    description: `Switch mode (${availableModes.map(m => m.id).join(" | ")})`,
    getArgumentCompletions: (prefix: string) => {
      const all = availableModes.map(m => ({
        value: m.id,
        label: m.id,
        description: m.isDefault
          ? "unmodified system prompt"
          : m.disabledTools.size > 0
            ? `disabled: ${[...m.disabledTools].join(", ")}`
            : "all tools enabled",
      }));
      if (!prefix) return all;
      return all.filter(item => item.value.startsWith(prefix.toLowerCase()));
    },
    handler: async (args, ctx) => {
      // No args → show interactive selector (arrow keys + click)
      if (!args?.trim()) {
        const options = availableModes.map(m => {
          const marker = m.id === availableModes[currentModeIndex].id ? " ← active" : "";
          const tools = m.isDefault
            ? " [unmodified prompt]"
            : m.disabledTools.size > 0
              ? ` [no: ${[...m.disabledTools].join(", ")}]`
              : " [all tools]";
          return `${m.name}${tools}${marker}`;
        });
        const selected = await ctx.ui.select("Switch Mode", options, {
          initialIndex: currentModeIndex,
        });
        if (selected === undefined) return; // user cancelled
        const selectedIndex = options.indexOf(selected);
        if (selectedIndex === -1) return;
        const oldModeId = availableModes[currentModeIndex].id;
        if (setMode(ctx, selectedIndex)) {
          persistAndNotifySwitch(oldModeId);
          const mode = availableModes[selectedIndex];
          const toolInfo = mode.disabledTools.size > 0
            ? ` (${[...mode.disabledTools].join(", ")} disabled)`
            : "";
          ctx.ui.notify(`Switched to ${mode.name}${toolInfo}`, "info");
        } else {
          ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
        }
        return;
      }
      // Args provided → switch directly
      const index = availableModes.findIndex(m => m.id === args.trim().toLowerCase());
      if (index === -1) {
        ctx.ui.notify(`Unknown mode. Available: ${availableModes.map(m => m.id).join(", ")}`, "error");
        return;
      }
      const oldModeId = availableModes[currentModeIndex].id;
      if (setMode(ctx, index)) {
        persistAndNotifySwitch(oldModeId);
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
      const oldModeId = availableModes[currentModeIndex].id;
      const next = (currentModeIndex + 1) % availableModes.length;
      if (setMode(ctx, next)) {
        persistAndNotifySwitch(oldModeId);
        ctx.ui.notify(`Mode: ${availableModes[next].name}`, "info");
      } else {
        ctx.ui.notify("Session not ready yet", "warning");
      }
    },
  });

  pi.registerShortcut(Key.ctrlShift("h"), {
    description: "Previous mode",
    handler: async (ctx) => {
      const oldModeId = availableModes[currentModeIndex].id;
      const prev = (currentModeIndex - 1 + availableModes.length) % availableModes.length;
      if (setMode(ctx, prev)) {
        persistAndNotifySwitch(oldModeId);
        ctx.ui.notify(`Mode: ${availableModes[prev].name}`, "info");
      } else {
        ctx.ui.notify("Session not ready yet", "warning");
      }
    },
  });

  // ── 5. Inject mode prompt on every provider request ──────────────────────
  // Uses before_provider_request (not before_agent_start) because compaction can
  // happen mid-agentic-loop. Uses cached prompt — no disk reads on hot path.

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
    // Default mode: leave the system prompt untouched.  This is the only mode
    // where `cachedPrompt` is empty and we want OMP's original behavior.
    if (mode.isDefault) return;
    // Inject cached prompt — no disk I/O on hot path
    if (cachedPrompt) {
      injectIntoPayload(event.payload, `\n\n[MODE: ${mode.name.toUpperCase()}]\n${cachedPrompt}`);
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
      allKnownTools = new Set(pi.getAllTools());
    } catch (err) {
      console.warn(`[modes] Failed to initialize tools: ${err}`);
      return;
    }

    if (baselineTools.length === 0) {
      ctx.ui.notify("[modes] No active tools found. Mode restore skipped.", "warning");
      return;
    }
    // Always start in "default" mode unless --mode flag overrides it.
    const modeFlag = pi.getFlag("mode");
    let targetIndex: number;
    if (typeof modeFlag === "string" && modeFlag) {
      const flagIndex = availableModes.findIndex(m => m.id === modeFlag.toLowerCase());
      if (flagIndex !== -1) {
        targetIndex = flagIndex;
      } else {
        console.warn(`[modes] Unknown --mode "${modeFlag}". Available: ${availableModes.map(m => m.id).join(", ")}`);
        targetIndex = availableModes.findIndex(m => m.id === "default");
      }
    } else {
      targetIndex = availableModes.findIndex(m => m.id === "default");
    }
    if (targetIndex === -1) targetIndex = 0;
    // setMode BEFORE setEditorComponent so currentModeIndex is correct when
    // the editor is created — otherwise the top border would briefly show
    // DEFAULT until the next updateEditorTopBorder() call.
    if (setMode(ctx, targetIndex)) {
      const targetMode = availableModes[targetIndex];
      if (!targetMode.isDefault) {
        notifyModeSwitch("", targetMode.id);
      }
    }
    // Install the custom editor that shows the mode name in the top border.
    // Store the instance so we can re-trigger updateEditorTopBorder() later.
    try {
      ctx.ui.setEditorComponent((_tui, editorTheme, _keybindings) => {
        const editor = new ModeEditor(editorTheme);
        return editor as any;
      });
    } catch (err) {
      console.warn(`[modes] setEditorComponent failed: ${err}`);
    }
});
}
}
