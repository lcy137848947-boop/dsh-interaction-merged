# dsh-interaction-merged

`0.3.1-beta.14` · MIT · offline · zero dependencies

One DSH plugin that does **two related jobs in one runtime**:

- **turn boundary** — quote / defer / limit / stop / confirm: does this message authorize an action, or is it asking, quoting, correcting, or holding back?
- **task state** — current task, correction, temporary requirement, long-term preference, waiting state.

It is a single package, not a suite of two plugins:

```text
agent/inbox/inserted ─┐
agent/inbox/claimed ──┤ one shared judge → one state file → system-prompt/assemble
agent/error ──────────┘
```

## Status

**Beta.** Behavior is covered by offline unit tests and a heuristic regression set; it is not a claim of general Chinese or English intent coverage. Expect breaking changes before 1.0.

## Requirements

- Node.js ≥ 20.
- A DSH host that exposes the plugin lifecycle (`apply(ctx, config)`), the events
  `agent/inbox/inserted`, `agent/inbox/claimed`, `agent/error`, `session/event`,
  `system-prompt/assemble`, `tools/pre-execute`, and the `commands` registry.
  Hosts without a given hook degrade gracefully: the related feature stays off.

## Install

From a local checkout:

```text
dsh plugin --profile <profile> add <absolute path to this directory>
```

`cordis.patch.yml` enables the plugin by default with the defaults below. To keep it
installed but paused, use `/itk off`; to pause only boundary actions, use `/guard off`.

## Configuration

Every key is optional; the values below are the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `/itk on|off` flips it at runtime. |
| `guardEnabled` | `true` | Boundary actions only; `/guard on|off`. Task state keeps working when off. |
| `maxPrefs` | `2` | Long-term preferences injected per turn. |
| `maxChars` | `620` | Total budget for the injected block. Control sections are never trimmed. |
| `maxSessions` | `50` | LRU cap for per-session state. |
| `statePath` | `$DSH_HOME/dsh-interaction-merged/state.json` | Where state lives. |
| `wakeWords` | `["助手","小助手","assistant","deepseek","dsh"]` | Honorific prefixes stripped before classification. Pass your own list, or `[]` to disable stripping. |
| `metrics` | `true` | Log write/injection timings. |

## Commands

- `/itk` — task, waiting state, preferences, last injection, turn key, timings
- `/itk prefs` — list active long-term preferences
- `/itk forget <id>` — delete one preference
- `/itk replace <id> <rule>` — replace one preference, keeping its scope
- `/itk off` / `/itk on` — pause/resume the whole plugin
- `/itk why` — the shared decision, injected sections, and timings
- `/itk why raw` — same, with external prompt-block names unredacted (local debugging only)
- `/guard` — boundary actions and per-rule counts
- `/guard off` / `/guard on` — pause/resume boundary actions only
- `/guard why` — same trace as `/itk why`

## How it works

1. **One inbox hook.** Each user message is judged once by `lib/judge.js`, which merges
   the boundary classifier (`lib/recognize.js`) and the task-state machine (`lib/core.js`).
2. **One state file.** Task, correction, temporary requirement, preferences, waiting state,
   action counts and trace id live in a single JSON file. Writes are lock-serialised and
   merged field-by-field against the latest disk snapshot, so two processes editing
   different sessions or fields do not overwrite each other.
3. **One assembly hook.** The judge decides which short sections to append. Total input is
   capped by `maxChars`; protected control sections are kept whole, low-priority blocks are
   trimmed first.
4. **One injection per turn.** The idempotency key is the **host turn id** (`agent/inbox/claimed`),
   not a timestamp: a streaming retry that assembles the same turn twice still injects once.
   Hosts without a turn id fall back to a session-local turn counter.
5. **A task ends on more than “done”.** Completion, cancellation, failure, and interrupted
   turns all release task-bound temporary requirements, so a boundary cannot leak into the
   next task.
6. **Host-injected messages are ignored for state.** Memory recall, compaction checkpoints and
   scheduled context are not the user speaking. A native question reply
   (`user-question-reply`) is the opposite: it is the user's answer and takes the same path as
   a plain user message.
7. **A clarification is state, not just advice.** The guard blocks tools while it waits for the
   missing material, injects one `itk:clarify` section, and keeps blocking until the user
   answers or the wait expires.
8. **Diagnostics are safe to share.** `/itk why` shows unknown prompt-block names as
   `外部块 N`; `/itk why raw` keeps the original names for local debugging.

The plugin never executes anything. It only appends short prompt sections and keeps local
state; hard safety enforcement stays with DSH approvals and sandboxing.

## Tests

```text
npm test
```

**108/108 passing** on Node 22. The suites cover true two-process concurrent writes, lock
recovery, op-id retry, compaction rehydrate, cross-day reconfirmation, schema migration,
turn-id idempotency under a double assemble, task end by completion / cancellation /
failure, and a three-way acceptance check (direct message, native question reply, memory
recall). Tests are offline: no model calls, no network.

`npm test` uses `node --test` discovery; helper scripts live in `scripts/fixtures/` so they are
not executed as tests. Node 20 is claimed by `engines` but has not been run in this repository;
the concurrency suite can flake on a heavily loaded machine — rerun it before blaming a change.

The three-way acceptance check is the one to run after changing anything about inbox
filtering or task storage:

| Path | Expected |
| --- | --- |
| user types a file name directly | file name kept, original task kept |
| user answers a native question (`user-question-reply`) | file name kept, original task kept |
| a memory plugin recalls a fact (`runtime-context`) | current task unchanged |

See [`docs/ENGINEERING-NOTES.md`](docs/ENGINEERING-NOTES.md) for design notes and what is
*not* verified.

## Not implemented

- No client UI or settings panel; commands only.
- No migration of state from the older separate plugins.
- No macOS/Linux DSH UI verification (CI runs the Node tests only).
- Real DSH compaction and session-id changes are covered by unit-level simulation, not by a
  live harness run.
- Answer detection is heuristic: only an explicit clarification request, or a value-shaped
  reply (path, file name, number, short noun), is treated as the missing material.
- Repeated answers are appended as “（补充：…）” segments; a very long chain trims the older
  task text first.
- Honorifics are stripped with `wakeWords`; a name that is not in the list stays part of the
  text and can still be read as content.

## Privacy and security

- No full chat log, no API keys, no tool results.
- State holds truncated snippets (220 chars of the last user message, 300 of the last
  assistant message) plus task state, written with mode `0600` where the platform supports it.
- No network code, no model calls, no third-party dependencies.
- Report security-relevant behavior per [`SECURITY.md`](SECURITY.md); write permissions are
  in [`PRIVACY.md`](PRIVACY.md).

## License

MIT — see [`LICENSE`](LICENSE). Contributions follow [`CONTRIBUTING.md`](CONTRIBUTING.md).
