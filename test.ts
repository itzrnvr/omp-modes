import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modesDir = path.join(__dirname, "modes");

// ── Test 1: Mode Discovery ──────────────────────────────────────────────────

interface ModeDef {
  id: string;
  name: string;
  color: string;
  disabledTools: Set<string>;
  prompt: string;
}

function parseModeFile(file: string): ModeDef | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(modesDir, file), "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const sep = lines.findIndex((l: string, i: number) => i > 0 && l.trim() === "---");
  if (sep === -1) return null;

  const yamlLines = lines.slice(1, sep);
  const prompt = lines.slice(sep + 1).join("\n").trim();

  let name = file.replace(".md", "");
  let color = "accent";
  const disabledTools: string[] = [];
  let inTools = false;

  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (inTools && (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-"))) {
      const stripped = trimmed.replace(/^-\s*/, "");
      const colonIdx = stripped.indexOf(":");
      if (colonIdx !== -1) {
        const toolName = stripped.slice(0, colonIdx).trim();
        const value = stripped.slice(colonIdx + 1).trim().toLowerCase();
        if (toolName && value === "false") disabledTools.push(toolName);
      }
      continue;
    }
    if (inTools && trimmed !== "") inTools = false;
    if (/^name:(?: |$)/.test(trimmed)) {
      let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'")))
        parsed = parsed.slice(1, -1);
      if (parsed) name = parsed;
      continue;
    }
    if (/^color:(?: |$)/.test(trimmed)) {
      const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (parsed) color = parsed;
      continue;
    }
    if (trimmed === "tools:") { inTools = true; continue; }
  }

  const id = file.replace(".md", "").toLowerCase();
  return { id, name, color, disabledTools: new Set(disabledTools), prompt };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

console.log("\n=== Test 1: Mode Discovery ===\n");
const files = fs.readdirSync(modesDir).filter(f => f.endsWith(".md")).sort();
assert(files.length === 5, `Found ${files.length} mode files (expected 5)`);
const modes: ModeDef[] = [];
for (const file of files) {
  const mode = parseModeFile(file);
  assert(mode !== null, `Parsed ${file}`);
  if (mode) modes.push(mode);
}
// Simulate the extension's synthetic "default" mode prepended at index 0.
const defaultMode: ModeDef & { isDefault: boolean } = {
  id: "default",
  name: "Default",
  color: "muted",
  disabledTools: new Set(),
  prompt: "",
  isDefault: true,
};
modes.unshift(defaultMode as ModeDef);
assert(modes.length === 6, `After prepending default: ${modes.length} modes (expected 6)`);
assert(modes[0].id === "default", "default mode is at index 0");

console.log("\n=== Test 2: Mode Properties ===\n");
const def = modes[0]; // default mode is at index 0
assert(def.id === "default", "default mode: id is 'default'");
assert((def as any).isDefault === true, "default mode: isDefault flag is set");
assert(def.disabledTools.size === 0, "default mode: no tools disabled");
assert(def.prompt === "", "default mode: empty prompt (no system prompt injection)");
const edit = modes.find(m => m.id === "edit");
assert(edit !== undefined, "edit mode exists");
assert(edit?.disabledTools.size === 0, "edit mode: no tools disabled");
assert(edit?.name === "Edit", "edit mode: name is 'Edit'");
assert(edit?.color === "accent", "edit mode: color is 'accent'");

const ask = modes.find(m => m.id === "ask");
assert(ask !== undefined, "ask mode exists");
assert(ask?.disabledTools.has("write"), "ask mode: write disabled");
assert(ask?.disabledTools.has("edit"), "ask mode: edit disabled");
assert(ask?.disabledTools.has("bash"), "ask mode: bash disabled");
assert(ask?.name === "Ask", "ask mode: name is 'Ask'");

const plan = modes.find(m => m.id === "plan");
assert(plan !== undefined, "plan mode exists");
assert(plan?.disabledTools.has("bash"), "plan mode: bash disabled");
assert(!plan?.disabledTools.has("write"), "plan mode: write NOT disabled");
assert(!plan?.disabledTools.has("edit"), "plan mode: edit NOT disabled");

const review = modes.find(m => m.id === "review");
assert(review !== undefined, "review mode exists");
assert(review?.disabledTools.has("write"), "review mode: write disabled");
assert(review?.disabledTools.has("edit"), "review mode: edit disabled");
assert(review?.disabledTools.has("bash"), "review mode: bash disabled");

const research = modes.find(m => m.id === "research");
assert(research !== undefined, "research mode exists");
assert(research?.disabledTools.has("write"), "research mode: write disabled");
assert(research?.disabledTools.has("edit"), "research mode: edit disabled");
assert(!research?.disabledTools.has("bash"), "research mode: bash NOT disabled (for profiling)");
assert(research?.name === "Research", "research mode: name is 'Research'");
assert(research?.color === "error", "research mode: color is 'error'");

console.log("\n=== Test 3: System Prompt Injection ===\n");

// Simulate the injectIntoPayload function from the extension
function injectIntoPayload(payload: any, text: string): void {
  if (typeof payload.system === "string") {
    payload.system += text;
  } else if (Array.isArray(payload.system)) {
    payload.system.push({ type: "text", text });
  } else if (Array.isArray(payload.messages)) {
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

// Test Anthropic-style payload (string)
const anthropicPayload = { system: "Base system prompt." };
injectIntoPayload(anthropicPayload, "\n\n[MODE: RESEARCH]\nResearch prompt here.");
assert(
  anthropicPayload.system.includes("[MODE: RESEARCH]"),
  "Anthropic string: mode prompt injected"
);
assert(
  anthropicPayload.system.includes("Base system prompt."),
  "Anthropic string: base prompt preserved"
);

// Test Anthropic-style payload (array)
const anthropicArrayPayload = { system: [{ type: "text", text: "Base." }] };
injectIntoPayload(anthropicArrayPayload, "\n\n[MODE: RESEARCH]\nResearch prompt.");
assert(
  anthropicArrayPayload.system.length === 2,
  "Anthropic array: mode prompt appended as new block"
);
assert(
  anthropicArrayPayload.system[0].text === "Base.",
  "Anthropic array: base prompt preserved"
);

// Test OpenAI-style payload
const openaiPayload = {
  messages: [
    { role: "system", content: "Base system prompt." },
    { role: "user", content: "Hello" },
  ],
};
injectIntoPayload(openaiPayload, "\n\n[MODE: RESEARCH]\nResearch prompt.");
assert(
  openaiPayload.messages[0].content.includes("[MODE: RESEARCH]"),
  "OpenAI: mode prompt injected into system message"
);
assert(
  openaiPayload.messages[0].content.includes("Base system prompt."),
  "OpenAI: base prompt preserved"
);

// Test OpenAI-style with no existing system message
const openaiNoSys = {
  messages: [{ role: "user", content: "Hello" }],
};
injectIntoPayload(openaiNoSys, "\n\n[MODE: RESEARCH]\nResearch prompt.");
assert(
  openaiNoSys.messages[0].role === "system",
  "OpenAI no-system: system message prepended"
);
assert(
  openaiNoSys.messages[0].content.includes("[MODE: RESEARCH]"),
  "OpenAI no-system: mode prompt in new system message"
);
// Default mode: should NOT inject anything (empty prompt + isDefault guard)
const defaultPayload = { system: "Base system prompt." };
// The extension's hook checks `if (mode.isDefault) return;` before injection.
// Simulate: if prompt is empty AND isDefault, skip injection.
const defaultCachedPrompt = def!.prompt;
if (defaultCachedPrompt) {
  injectIntoPayload(defaultPayload, `\n\n[MODE: DEF]\n${defaultCachedPrompt}`);
}
assert(
  defaultPayload.system === "Base system prompt.",
  "Default mode: system prompt unchanged (no injection for empty prompt)"
);

console.log("\n=== Test 4: Tool Enforcement ===\n");

// Simulate setActiveTools logic
const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "task", "lsp"];
const baselineTools = [...allTools];

function simulateSetMode(mode: ModeDef): string[] {
  return baselineTools.filter(t => !mode.disabledTools.has(t));
}

const researchActive = simulateSetMode(research!);
assert(!researchActive.includes("write"), "research setActiveTools: write removed");
assert(!researchActive.includes("edit"), "research setActiveTools: edit removed");
assert(researchActive.includes("bash"), "research setActiveTools: bash present");
assert(researchActive.includes("read"), "research setActiveTools: read present");
assert(researchActive.includes("grep"), "research setActiveTools: grep present");
assert(researchActive.includes("task"), "research setActiveTools: task present");

const askActive = simulateSetMode(ask!);
assert(!askActive.includes("write"), "ask setActiveTools: write removed");
assert(!askActive.includes("edit"), "ask setActiveTools: edit removed");
assert(!askActive.includes("bash"), "ask setActiveTools: bash removed");
assert(askActive.includes("read"), "ask setActiveTools: read present");
// Verify default mode preserves all tools
const defaultActive = simulateSetMode(def!);
assert(defaultActive.length === allTools.length, "default setActiveTools: all tools present (no tools disabled)");

const editActive = simulateSetMode(edit!);
assert(editActive.length === allTools.length, "edit setActiveTools: all tools present");

console.log("\n=== Test 5: Research Prompt Content ===\n");

assert(research!.prompt.includes("anti-shallow-directive"), "research prompt: contains anti-shallow-directive");
assert(research!.prompt.includes("investigation-philosophy"), "research prompt: contains investigation-philosophy");
assert(research!.prompt.includes("autonomous-problem-solving"), "research prompt: contains autonomous-problem-solving");
assert(research!.prompt.includes("BASELINE, not the deliverable"), "research prompt: baseline vs deliverable distinction");
assert(research!.prompt.includes("SCOPE SUBSTITUTION"), "research prompt: scope substitution warning");
assert(research!.prompt.includes("[CONTRACT]"), "research prompt: contains CONTRACT section");
assert(research!.prompt.includes("output-structure"), "research prompt: contains output structure");
assert(research!.prompt.includes("read-only"), "research prompt: mentions read-only constraint");

console.log("\n=== Test 6: Mode Cycling ===\n");

const modeIds = modes.map(m => m.id);
// Modes after prepending default: default(0), ask(1), edit(2), plan(3), research(4), review(5)
let currentIndex = 0; // starts at default
function cycleNext(): string {
  currentIndex = (currentIndex + 1) % modes.length;
  return modes[currentIndex].id;
}
function cyclePrev(): string {
  currentIndex = (currentIndex - 1 + modes.length) % modes.length;
  return modes[currentIndex].id;
}
// Start at default (index 0)
assert(cycleNext() === "ask", "cycle next from default -> ask");
assert(cycleNext() === "edit", "cycle next from ask -> edit");
assert(cycleNext() === "plan", "cycle next from edit -> plan");
assert(cycleNext() === "research", "cycle next from plan -> research");
assert(cycleNext() === "review", "cycle next from research -> review");
assert(cycleNext() === "default", "cycle next from review -> default (wraps)");
assert(cyclePrev() === "review", "cycle prev from default -> review (wraps)");
assert(cyclePrev() === "research", "cycle prev from review -> research");

console.log("\n=== Test 7: Argument Completions ===\n");

// Simulate getArgumentCompletions logic (mirrors extension's logic)
function getArgumentCompletions(prefix: string): { value: string; label: string; description: string }[] {
  const all = modes.map(m => ({
    value: m.id,
    label: m.id,
    description: (m as any).isDefault
      ? "unmodified system prompt"
      : m.disabledTools.size > 0
        ? `disabled: ${[...m.disabledTools].join(", ")}`
        : "all tools enabled",
  }));
  if (!prefix) return all;
  return all.filter(item => item.value.startsWith(prefix.toLowerCase()));
}
const allCompletions = getArgumentCompletions("");
assert(allCompletions.length === 6, "completions: returns all 6 modes with empty prefix");
assert(allCompletions[0].value === "default", "completions: first is default");
assert(allCompletions[0].description === "unmodified system prompt", "completions: default description is unmodified prompt");
assert(allCompletions[1].value === "ask", "completions: second is ask");
assert(allCompletions[2].description === "all tools enabled", "completions: edit description says all tools enabled");

const rCompletions = getArgumentCompletions("r");
assert(rCompletions.length === 2, "completions: 'r' matches research and review");
assert(rCompletions[0].value === "research", "completions: 'r' first match is research");
assert(rCompletions[1].value === "review", "completions: 'r' second match is review");

const reCompletions = getArgumentCompletions("re");
assert(reCompletions.length === 2, "completions: 're' still matches both");

const resCompletions = getArgumentCompletions("res");
assert(resCompletions.length === 1, "completions: 'res' matches only research");
assert(resCompletions[0].value === "research", "completions: 'res' is research");

const dCompletions = getArgumentCompletions("d");
assert(dCompletions.length === 1, "completions: 'd' matches only default");
assert(dCompletions[0].value === "default", "completions: 'd' is default");
const zCompletions = getArgumentCompletions("z");
assert(zCompletions.length === 0, "completions: 'z' matches nothing");

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
