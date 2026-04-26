# pi-modes

Switchable agent modes for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Each mode controls which tools are available and injects a mode-specific system prompt.

Inspired by [opencode modes](https://opencode.ai/docs/modes/).

## Install

```
pi install npm:pi-modes
```

Or clone into your extensions directory:

```
git clone https://github.com/R-Dson/pi-modes ~/.pi/agent/extensions/pi-modes
```

Or load directly:

```
pi --extension /path/to/pi-modes
```

After installing, enter `/reload` or restart Pi.

## Usage

| Action | How |
|---|---|
| Switch mode | `/mode ask`, `/mode edit`, `/mode review` |
| Next mode | `Ctrl+Shift+L` |
| Previous mode | `Ctrl+Shift+H` |
| Check current mode | `/mode` (shows active mode and disabled tools) |
| Start in a mode | `pi --extension pi-modes --mode ask` |

## Shipped modes

| Mode | Tools disabled | Purpose |
|---|---|---|
| Edit | none | Full access (default) |
| Plan | bash | Read-only exploration, writes only to PLAN.md |
| Ask | write, edit, bash | Read-only exploration and questions |
| Review | write, edit, bash | Code review without making changes |

## Adding modes

Create a `.md` file in the `modes/` directory. The filename becomes the mode id used with `/mode` and `--mode`.

```markdown
---
name: Debug
color: warning
tools:
  write: false
  edit: false
---
You are in debug mode. Investigate issues by reading code and running
diagnostic commands. Do not make changes.
```

Supported frontmatter:

- `name` -- display name (defaults to filename)
- `color` -- theme color for the chat box label: `accent`, `warning`, `muted`, `success`, `error`, `dim` (defaults to `accent`)
- `tools` -- list of tools to disable, each set to `false`

The body after the second `---` is injected into the system prompt when the mode is active. Leave it empty to skip injection.

## Persistence

Mode selection survives `/reload` and session resume via session state. The `--mode` flag takes priority over persisted state.

Note: each mode switch appends a small entry to the session. This is the standard pattern used by other pi extensions (tools, presets). In very long sessions this adds negligible overhead.

## Plan mode

Plan mode uses both tool restrictions and prompt enforcement. `bash` is disabled at the harness level; the agent is told via prompt to only write to `PLAN.md`.

The current `PLAN.md` content is injected into the system prompt on every provider request (not just at session start), so it survives compaction and reflects mid-session edits. This uses the `before_provider_request` hook rather than `before_agent_start` because compaction can happen mid-agentic-loop during multi-turn tool use.

## Caveats

Running alongside other extensions that call `setActiveTools()` (e.g., `tools.ts`, `preset.ts`) may cause conflicts, as both can modify the active tool set independently.
