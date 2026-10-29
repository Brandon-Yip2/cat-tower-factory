# Cat Tower Factory

A local, always-on harness for the Cat Tower Studio Team. Ideas come in from you, from scheduled loops,
from QA and from the agents; the Factory starts and resumes the right `ct-*` agent for each step, records
every run, keeps single-user tools (Roblox Studio, Blender, uploads, git commits) to one agent at a time,
learns which model fits which task from your reviews, and improves its own instructions every few days.
You watch and steer it from one dashboard: **http://127.0.0.1:4477**.

Design: [docs/superpowers/specs/2026-10-29-cattower-factory-design.md](../docs/superpowers/specs/2026-10-29-cattower-factory-design.md)

## Install (once)

```powershell
./factory/install.ps1
```

That installs the one dependency, adds a **Startup** shortcut (the daemon starts hidden when you log in),
adds a **Desktop** shortcut "Cat Tower Factory" for the dashboard, starts the daemon and opens the page.
`./factory/install.ps1 -Uninstall` removes the shortcuts and stops it (your data in `factory/data/` stays).
To run it in a console instead: `./factory/start.ps1`.

## Using it

| You want to… | Do this |
| --- | --- |
| Give the team work | **New idea** (sidebar). It lands in the inbox; triage routes it. |
| Answer an agent | **Home → Needs you**. One click on a choice, or type an answer. The agent resumes in the same session. |
| Approve a brand-new agent idea | It shows in **Needs you** and the **Needs approval** tab. Everything else proceeds on its own. |
| Talk to one agent | **Agents** → pick the role → chat. A running agent gets your message at its next step; an idle one is resumed or started. |
| See who has Studio and why | **Home → Tools in use**, or **Tools**. **Release** takes a tool back. |
| Turn a timed loop on/off, or run it now | **Loops**. |
| Judge a result | Open the idea (or run) → **Good** or **Redo** with a reason. "Model wasn't strong enough" twice in five runs moves that task type up a model. |
| Stop everything starting | **Pause the Factory** (sidebar). Running agents finish; nothing new starts. |
| See what changed in the Factory itself | **Improvements**. **Undo** reverts it. |

Notifications: a Windows toast appears when an agent asks you something, an idea needs approval, or a run fails.

## How it works

- `server.mjs` — the daemon: dashboard + API on 127.0.0.1, the **dispatcher** (every 15 s moves approved ideas:
  triage → spec → build → QA → shipped), the **scheduler** (cron loops in `factory.config.json`), the **runner**
  (spawns `claude -p --agent ct-<role> --model <routed>` with prompt on stdin, `--permission-mode auto`,
  stream-json output), sweeps for idle tool locks and token use, and the agent-bus mirror.
- `hooks/hook.mjs` — Claude Code hooks (registered in `.claude/settings.json`) for **every** session in this repo:
  logs each step, gives a "FACTORY NOW" snapshot at session start, gates single-user tools, delivers your
  messages mid-run. Fails open: it can never break a session.
- `mcp/server.mjs` — the `factory` MCP tools agents use: `factory_status`, `who_is_using`, `claim_tool`,
  `release_tool`, `claim_files`, `list_ideas`, `get_idea`, `propose_idea`, `update_idea`, `ask_owner`,
  `send_note`, `report_progress`, `record_improvement`, `factory_stats`.
- `data/factory.db` — SQLite (ideas, runs, activity, tool holds, questions, messages, loops, routing, improvements).
  Git-ignored. `data/factory.log` is the daemon log.

## Factory as code

| File | What | Who may edit |
| --- | --- | --- |
| `factory.config.json` | roles, single-user tools, loops (cron), model routing per task type, areas, current pass | you, the Factory Engineer |
| `prompts/*.md` | what every run is told (`preamble.md`) and the triage / spec / build / QA / chat prompt templates | you, the Factory Engineer |
| `guards.json` | safety limits: concurrency (3), daily token budget (60 M), runs per idea, rework limit, idle release, per-run $ caps, approval switches, protected paths | **you only** (agents are blocked) |
| `../CLAUDE.md` *Learned rules* | one-line rules learned from past runs | the Factory Engineer |
| `../.claude/agents/ct-*.md` | the team | you, the Factory Engineer (small edits) |

The daemon reloads `factory.config.json` and `guards.json` within 30 s of a change; prompt changes apply to the next run.

**Rules the Factory enforces:** owner ruling 2026-10-29: agents push to Studio, commit their own files and edit their
own instructions without asking. The one gate is a **brand-new idea an agent invented** (a feature with no parent owner
idea), which waits for your approval. Agents never publish the place. Owner sessions are never blocked by tool locks
(they get a heads-up instead).

**Tokens:** "billable tokens" = input + output + cache writes (cache reads are cheap and excluded). When the daily
budget is reached, no new automatic runs or loops start until midnight; your own actions (answers, chat, Run now) still work.

## Development

```bash
node --test factory/test/*.test.mjs            # unit + integration tests (no tokens spent)
FACTORY_DB=/tmp/demo.db node factory/tools/seed-demo.mjs
FACTORY_DEMO=1 FACTORY_DB=/tmp/demo.db FACTORY_DATA_DIR=/tmp FACTORY_PORT=4478 node factory/server.mjs   # look at the UI with demo data
node factory/tools/digest.mjs --days 3          # what the self-review loop reads
```
