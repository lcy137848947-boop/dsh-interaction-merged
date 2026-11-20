# Engineering notes

Design notes for `dsh-interaction-merged`. This file replaces the internal beta
reports; it keeps the conclusions and drops the transcripts, test workspaces, and
personal material.

## Shape

One runtime, three seams:

```text
agent/inbox/inserted ─┐
agent/inbox/claimed ──┤ judge(text, context) → state → system-prompt/assemble
agent/error ──────────┘
```

- `lib/recognize.js` — boundary classifier (quote / defer / limit / stop / confirm).
- `lib/core.js` — task-state machine (task, correction, temporary, preference, waiting).
- `lib/judge.js` — merges the two into one decision: speech acts, actions, task change,
  confidence, trace id.
- `lib/store.js` — one JSON state file, lock + field-level three-way merge.

Nothing here performs an action. The plugin appends short prompt sections and keeps
local state; approvals, sandboxing, and real execution stay with the host.

## State and concurrency

- Writes take `<state>.lock` (`open … wx`), re-read the file inside the lock, merge
  field by field against the in-memory base, then `rename` a per-process temp file.
- Merge rule: apply only the fields this process changed; take everything else from
  disk. Global flags (`enabled`, `guardEnabled`) and preferences follow the same rule.
- Stale locks are detected by age and by `process.kill(pid, 0)`; corrupt state is
  backed up next to the original before recovery.
- Sessions are capped by LRU (`maxSessions`, default 50). Read-only commands use a
  non-creating lookup, so `/itk` from another session cannot evict a live one.
- State and lock files are written with mode `0600` where the platform honours it.

## Turn identity and idempotency

“One injection per turn” needs a key that survives a second `system-prompt/assemble`
in the same turn. A re-derived hash of the message text cannot distinguish a retry
from a new turn, and a timestamp moves on every attempt.

- Primary key: the host turn id from `agent/inbox/claimed` (`turn.id` / `message.turnId`).
- Fallback: `<sessionId>#<local turn counter>`.
- A late claim only upgrades the fallback key **before** the turn has been injected, so
  a retry that assembles after the first injection cannot reopen the turn.

## Task end

A task ends for more than “done”. Completion, cancellation, failure, and interruption
all release task-bound temporary requirements:

- explicit `完成了` / `取消任务` → `completed` / `cancelled`;
- `agent/error` while a task or temporary requirement exists → `failed`;
- turn status `failed|interrupted|aborted|cancelled` in `session/event` → `failed`/`cancelled`.

`failed` is a distinct waiting state: the next “继续” gets a short `itk:state` section
that says the previous task did not finish and must not be presented as complete.

## Message sources

Host-injected messages are not authored by the human. The plugin ignores these source
kinds for task state: `runtime-context`, `untrusted-memory`, `compact-checkpoint`,
`skill-invocation`, `session-reference`, `schedule`, `plan-mode`, `goal`, `ptc-mode`,
`retry`, `cordis-host-runner`, `webhook`.

`user-question-reply` is the opposite: it is the user's answer to a native question.
It takes the same path as a plain user message, clears the clarification, and keeps the
original task with the answer attached.

## Acceptance: three-way reply check

The same material must resolve the same way through all three delivery paths:

| Path | Expected |
| --- | --- |
| user types the file name directly | file name kept, original task kept |
| user answers a native question (`user-question-reply`) | file name kept, original task kept |
| a memory plugin recalls a fact containing the file name (`runtime-context`) | current task unchanged |

Covered by `test/acceptance.test.mjs`.

## Clarification state

A pending clarification is state, not a one-shot hint:

- `tools/pre-execute` denies every tool except `ask_user_question` while it is pending;
- exactly one `itk:clarify` section is injected, even though the judge stayed “quiet” for
  that turn;
- the pending flag survives the injection so the guard keeps blocking;
- it is cleared when the user answers (the answer is attached to the task), when the task
  ends, or after five minutes of inactivity.

The answer path itself is deliberately strict: an explicit clarification request accepts the
reply, otherwise only a value-shaped reply (path, file name, number, short noun) is treated
as the missing material. A new instruction such as “换个方案” stays a normal turn.

## Verification status

- 103/103 offline tests on Node 22 (`npm test`, i.e. `node --test` discovery).
- Node 20 is declared in `engines` but was not run here; the concurrency suite can flake on a
  loaded machine because it spawns real child processes.
- Unit-level simulation of compaction and session-id changes; a live DSH compaction run
  is not part of the suite.
- The three-way source check is simulated at the event level. A real-machine run on
  Windows with the native question UI is still pending.
- CI runs the Node tests only; no DSH UI is started.

## Known limits

- Heuristic Chinese/English intent rules; no model calls, so unusual phrasing can be
  misclassified. When the judge is not confident it stays quiet rather than guessing.
- Answer detection is heuristic: a short reply while waiting is only accepted when it looks
  like a value or the plugin itself asked for material.
- `wakeWords` is passed per call, so two plugin instances in one process do not share the
  list; the recognizer still compiles and caches the resulting regex.
- No client UI, no settings panel, no migration from the older separate plugins.
- `maxChars` (620) is a hard budget: protected control sections are kept whole, other
  blocks are trimmed, so a very long task text is shortened before injection.

