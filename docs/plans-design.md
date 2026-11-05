# Plans: design

A plan lets the owner give Noop a goal, approve the steps, and come back to it later. Today the owner can hand over one task at a time. Agents can split a task with `delegated`, but nobody sees the steps in advance, approves them or edits them.

## What the owner does

1. **Create:** type a goal and optionally choose a project, in the app or in chat.
2. **Review:** a planner member drafts the steps. The owner edits, reorders, reassigns or removes them, then approves.
3. **Run:** steps run one at a time. Each one is a normal task, visible in the same places as any other.
4. **Handle stops:** if a step fails or needs an answer, the plan stops and says why.
5. **Continue:** at any time, even after the plan finishes, add instructions. The planner proposes the updated remaining steps for approval.

## The rule that keeps this small

**A plan never runs anything itself.** It decides which task to create next and watches that task. Agents, models, retries, decision cards, cancelling, follow-ups and project folders all stay in the existing task engine.

## Storage

`plans/PL-0001.json`, one file per plan, in the data folder:

```json
{
  "id": "PL-0001", "goal": "Add dark mode", "project": "site", "status": "running",
  "branch": "agent/plan-PL-0001", "created": "…",
  "notes": ["Owner's later instructions, in order"],
  "steps": [
    { "title": "Add theme tokens", "details": "…", "agent": "lead", "checkpoint": false,
      "status": "done", "task": "T-0031", "result": "…" },
    { "title": "Convert the settings page", "details": "…", "agent": "lead", "checkpoint": true,
      "status": "running", "task": "T-0032" }
  ]
}
```

- **JSON, not Markdown:** this replaces the `plans/<id>.md` proposed earlier. Steps are nested data that the daemon rewrites constantly, and parsing them back out of Markdown would be fragile. Agents never read the file; they get a rendered summary in their prompt.
- **Plan status:** `drafting → review → running ⇄ paused → done`, or `cancelled`. Continuing a `done` plan goes back to `drafting`.
- **Step status:** `pending`, `running`, `done`, `stopped`, `skipped`.
- **Removed plans** move to `archive/plans/`, like members and projects.

## How it runs

One new function, `advancePlans()`, runs on the primary in the daemon tick, inside the same lock as `wakeParents`. It works out what to do from the files alone, so a restart at any point loses nothing.

For each `running` plan, it looks at the current step's task:

| The task is in | What the plan does |
|---|---|
| `inbox`, `active`, `waiting` | Nothing. A task waiting on CI or sub-tasks is still running. |
| `blocked` | Nothing; the existing decision card asks the owner. The plan page shows "waiting for your decision". |
| `done` | Saves the result and marks the step done. Pauses if it's a checkpoint; otherwise moves on. |
| `failed`, with retries used up | Marks the step stopped, pauses the plan and notifies the owner. |
| `failed`, retries left | Nothing. `handleFailure` is about to put it back in the queue, so this must not read as a final failure. |
| `rejected` (owner cancelled it) | Marks the step stopped and pauses the plan. |

Starting a step calls `newTask` with:

- `source: plan:PL-0001`, so runs can be traced to their plan
- `extra.origin: owner`, because approving the plan is the owner's approval, so a step doesn't go back to the approval queue
- `extra.parent: PL-0001`, so results post quietly to the channel instead of pushing a notification for every step (this field only affects notifications today)
- `extra.plan` and `extra.plan_step`
- `project`, which already sets the folder and machine

**No duplicates after a crash:** before creating a task, it searches for one already tagged with this plan and step, and adopts it if found. If the daemon dies between writing the task and the plan, the step still runs only once.

**A hard crash during a step:** the restart stops the agent the dead daemon left behind, then runs the step again. Without this, two agents edited the plan's branch at once, which the first real test showed. A task's agent records its process id in `logs/pids/`, and the id is only acted on if it's still an agent process.

**A finished plan's last message:** when the final step is done, the plan posts one notification, not one per step.

## What each step's agent is told

A new section in `buildPrompt`, only for tasks with `plan`:

- The goal, and the owner's later instructions.
- Every step with its status, plus a short result for each finished one. Agents don't message each other, so this is how step 3 learns what step 2 did.
- **Which step is theirs,** and that they must only do that step.
- **The plan's branch:** if the project uses git, work on `agent/plan-PL-0001`. This matters: the autonomy policy has agents commit to `agent/<task-id>-*` branches, so without this rule each step would start without the previous step's commits.
- **Follow-ups:** use `delegated` if a step needs splitting, because the plan waits for delegated work. Plain follow-ups aren't awaited, so anything needed by later steps must be finished within the step.

## Drafting

Drafting is itself a task, by default for `lead`, marked `plan_draft: PL-0001`:

- The agent is told to read what it needs, change nothing, and return the steps in the existing `followups` result field (`title`, `body`, `agent`).
- `processTask` has one new branch: for a draft task, `followups` are saved to the plan as steps instead of being created as tasks. The plan then moves to `review` and notifies the owner.
- Continuing uses the same path. The planner also gets the progress and the new instruction, and may only replace steps that haven't finished.
- A draft that fails, or returns no steps, puts the plan back in `review` with the reason, so the owner can write the steps by hand or try again.
- Limit: 20 steps.

"Change nothing" is an instruction, not a hard block. This is the same level of protection as read-only routines today.

## Owner actions while running

| Action | Effect |
|---|---|
| **Pause** | Starts no further steps. The current step finishes; to stop it now, cancel its task. |
| **Resume** | Carries on, including after a checkpoint. |
| **Retry step** | Creates a new task for the stopped step, with the previous result included. |
| **Skip step** | Marks it skipped and moves on. |
| **Edit steps** | Only steps that haven't started. |
| **Continue with instructions** | Adds a note and goes through drafting and approval again. |
| **Cancel** | Stops the plan and cancels the running task. Finished work stays in the project. |

Approving a plan doesn't bypass the autonomy policy. A step that wants to merge, release or do anything else on the must-ask list still raises a decision card, and the plan waits for it.

## API

Local hub first, like members and projects. The app shows the same "local hub only" message on a Worker.

- `GET /api/plans`, `GET /api/plans/<id>`
- `POST /api/plans` `{goal, project?, agent?}`
- `PUT /api/plans/<id>` `{steps}`, unfinished steps only
- `DELETE /api/plans/<id>`, finished or cancelled plans only; moves to `archive/plans/`
- `POST /api/plans/<id>/approve`, `pause`, `resume`, `retry`, `skip`, `cancel`
- `POST /api/plans/<id>/continue` `{instructions}`

Chat gets `list_plans`, `create_plan` and `continue_plan`, plus open plans in the brain's context. So "plan out dark mode for the site" and "continue the dark mode plan, and also do the mobile nav" both work. Approval stays an explicit owner action. Chat can draft a plan, but it can only approve one when the owner says so plainly.

## The app

- **Sidebar:** a **Plans** row above All tasks, and running or stopped plans appear in the status area.
- **Plans page:** a list with progress, like "3 of 7", and a **New plan** button.
- **Plan page:**
  - Goal, project and status at the top.
  - Steps with status, member and a link to the existing task page.
  - In `review`: editable steps, then **Approve and start**.
  - While running: the actions above, with the reason at the top if it has stopped.
- **Phones:** the same pages through the existing navigation stack.

## Not in this version

- **Parallel steps or dependencies.** Steps are strictly in order. A step can still split its own work with subagents or `delegated`.
- **Editing the plan from an agent.** Agents can recommend changes in their results, and only the owner approves changes.
- **Plans across several projects.** A plan has one project or none.
- **Worker support, recurring plans and cost limits.** A plan spends quota for as long as it runs, so **Pause** is the limit for now.

## Known risks

- **Other work in the same folder:** nothing stops another task from running in a plan's folder at the same time. This is true of projects today, but plans make it more likely. The first version warns on the plan page instead of adding locks.
- **Reopened tasks:** amending a finished step's task reopens it after the plan has moved on. The plan only watches the current step, so it won't notice. That's acceptable for now, and the task page still shows it.
- **Agents saying "done" too early:** the plan trusts the step's result. Checkpoints are the way to review anything important.
- **Plain follow-ups:** the next step can start while a plain follow-up is still running, despite the instruction above.

## Build order

Each part is testable before the next one starts.

1. **Engine:** plan file, `advancePlans`, the prompt section. Tested with the fake CLI in `test/e2e.sh`, including a restart mid-plan, failure with retries, a decision card, cancelling and a checkpoint.
2. **Drafting and continuing:** tested with the fake CLI, then one real planner run.
3. **API and chat tools.**
4. **App pages:** tested with `nsh test`, then checked by eye at desktop and phone widths.
5. **Real end-to-end run** on a throwaway install: create a plan in chat, approve it, watch three steps build on each other on the plan's branch, restart the daemon mid-plan, then continue the plan with a new instruction.

## Decisions for the owner

1. **Steps run on by themselves after approval, with optional checkpoints.** The alternative is approving every step, which is safer but brings back the one-task-at-a-time experience.
2. **Strictly one step at a time** in this version.
3. **`lead` drafts by default,** with a choice of member when creating the plan.
4. **One git branch per plan,** so steps build on each other and the result can be reviewed as a whole.
