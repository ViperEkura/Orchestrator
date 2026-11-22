# Agent roles, workspace instructions and skills

The TUI, web and Windows clients use the same runtime. A parent delegates a bounded objective with `delegate_task`, gets a task ID and session ID, and uses `wait_tasks` for results. Use `list_agents` to inspect children, `send_message` to steer work, and `followup_task` to give an idle session another turn. A parent can call `interrupt_agent({taskId})` to cancel that task and its children while retaining the session for follow-up. `close_agent` retires a child session and its descendants. Each child sees its own history and receives the workspace rules for its task.

Roles live in the data directory under `agents/*.json`. The parent sees registered role IDs, names and optional descriptions when it can delegate. Give a custom role a short `description` to explain which objectives it handles. Its `allowedTools` constrain what it can do. Include `read_skill` to enable skills for that role. A child's tools are further limited by the parent and its workspace mode.

## Workspace instructions

Each new task loads one instruction file per directory. Start with the Orchestrator data directory (normally `~/.orchestrator`), then visit the nearest Git root through the task's starting directory. Outside Git, only the project directory follows the global layer. The first nonempty file in each directory wins, in the order `AGENTS.override.md`, `AGENTS.md`, `agent.md`. More specific instructions appear last. The combined text budget is 64 KiB. Worktree tasks use their recorded source directory to resolve guidance. New turns and follow-ups pick up edits.

## Install and use a skill

Create `.agents/skills/review/SKILL.md` in the repository:

```markdown
---
name: review
description: Review a change for regressions and missing tests.
---

Inspect the diff and its affected callers. Report each finding with a file and line.
```

Type `Use $review on the latest changes` in any client to request the skill explicitly. Otherwise the model sees names and descriptions and can call `read_skill` when a skill fits. It can also read a bundled reference with `read_skill({name:"review",resource:"references/checklist.md"})`. Scripts use ordinary workspace tools and their existing approvals.

Personal skills go in `~/.orchestrator/skills/<name>/SKILL.md` (or the configured data directory). The default installation also discovers `~/.agents/skills`. Project skills are discovered along the same Git-root-to-working-directory chain. A closer scope wins when names match. Use lowercase letters, numbers and hyphens in a name. The catalog holds up to 128 names. Each Markdown or text read returns up to 64 KiB.

## Upstream references

- [Codex local agent controller](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs)
- [Codex workspace instructions](https://developers.openai.com/codex/guides/agents-md)
- [Codex skill discovery](https://developers.openai.com/codex/skills)
