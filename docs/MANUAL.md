# Manual

**中文速览**：装好后它会做两件事——判断“这句是授权还是问问/引用/纠正/叫停”，并记住当前任务、纠正、临时要求、长期偏好。常用命令 `/itk`、`/guard`。所有状态在一个 JSON 文件里，不联网、不调模型。装不上先看“故障排查”第一节：多数情况是包没真正装进 profile（锁文件/导出声明）。

---

## 1. What it does

`dsh-interaction-merged` is one DSH plugin with two responsibilities that share a single
judge, one state file, and one prompt-assembly hook:

| Responsibility | Question it answers | Output |
| --- | --- | --- |
| Turn boundary | Is this message authorizing an action, or asking / quoting / correcting / holding back? | At most a few short control sections |
| Task state | What is the current task, correction, temporary requirement, standing preference, waiting state? | `itk:task`, `itk:correction`, `itk:temp`, `itk:prefs`, `itk:state` |

It never executes anything. It appends short prompt sections and keeps local state; approvals
and sandboxing stay with DSH.

## 2. Install

```text
dsh plugin --profile <profile> add /absolute/path/to/dsh-interaction-merged
```

Or install from a tarball / npm:

```text
dsh plugin --profile <profile> add ./dsh-interaction-merged-0.3.1-beta.15.tgz
```

After the next DSH start you should see both of these:

- `<DSH_HOME>/dsh-interaction-merged/state.json` exists;
- the host log contains `dsh-interaction-merged: active v0.3.1 (state=...)`.

If neither appears, the bundle was not loaded. See §9.

### Uninstall

```text
dsh plugin --profile <profile> remove dsh-interaction-merged
```

State is not deleted automatically. Remove `<DSH_HOME>/dsh-interaction-merged/` if you want it
gone.

## 3. Configuration

All keys are optional. Put them in the bundle row of your profile's `cordis.patch.yml`, or pass
them when mounting the plugin:

```yaml
- id: dsh-interaction-merged
  config:
    enabled: true
    guardEnabled: true
    maxPrefs: 2
    maxChars: 620
    maxSessions: 50
    statePath: null
    wakeWords: ["助手", "小助手", "assistant", "deepseek", "dsh"]
    metrics: true
```

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `/itk off` flips it at runtime. |
| `guardEnabled` | `true` | Boundary sections only. Task state keeps working when off. |
| `maxPrefs` | `2` | Standing preferences injected per turn. |
| `maxChars` | `620` | Budget for non-protected sections. Protected control sections are never trimmed. |
| `maxSessions` | `50` | LRU cap for per-session state. |
| `statePath` | `$DSH_HOME/dsh-interaction-merged/state.json` | Where state lives. |
| `wakeWords` | generic list | Honorific prefixes stripped before judging **and** before storing the task. `[]` disables stripping. |
| `metrics` | `true` | Log write and injection timings. |

Runtime switches are written back to the state file, so they survive restarts within the same
profile. The config layer still wins: `enabled: false` in config means `/itk on` cannot make the
plugin process messages until the config changes.

## 4. Commands

| Command | Meaning |
| --- | --- |
| `/itk` | Task, waiting state, correction, temporary requirement, last injection, turn key, timings |
| `/itk prefs` | List active standing preferences |
| `/itk forget <id>` | Delete one preference |
| `/itk replace <id> <rule>` | Replace one preference, keeping its scope |
| `/itk on` / `/itk off` | Toggle the whole plugin |
| `/itk why` | Decision, speech acts, actions, reasons, timings, state size |
| `/itk why raw` | Same, without redacting external prompt-block names |
| `/guard` | Boundary action counts per rule |
| `/guard on` / `/guard off` | Toggle boundary sections only |
| `/guard why` | Same trace as `/itk why` |

Writes report their result: if the state file cannot be written, the command returns an error
and the in-memory switch is rolled back instead of pretending success.

## 5. Behavior rules you should know

1. **One injection per turn**, keyed by the host turn id (`agent/inbox/claimed`). A streaming
   retry that assembles the same turn twice injects once. Hosts without turn ids fall back to a
   session-local counter.
2. **Clarification is state.** While it waits for material, tools other than
   `ask_user_question` are denied and exactly one `itk:clarify` section is injected. It ends when
   the user answers, the task ends, or five minutes pass without a new user message.
3. **Answers keep the task.** A pending clarification accepts the reply and appends it to the
   task as `（补充：…）`; value-shaped replies (path, file name, number, short noun) are accepted
   while the assistant is waiting. A bare “谢谢/收到” is ignored; a new instruction starts a new
   turn instead of being swallowed.
4. **A task ends on completion, cancellation, failure, or interruption.** All four release
   task-bound temporary requirements.
5. **Host-injected context is not the user.** `runtime-context`, `untrusted-memory`, compaction
   checkpoints, schedules and similar sources never create a turn or overwrite a task. A native
   question reply (`user-question-reply`) does count as the user's answer.
6. **Writes are lock-serialised and merged field by field** against the latest disk snapshot, so
   two processes editing different sessions or preferences do not overwrite each other.
7. **A correction is scoped, never standing.** It is cleared when the task ends (completion,
   cancellation, failure), when a new task starts, and on an explicit stop; it is never promoted
   to a standing preference. A temporary correction must not survive as the next task's default
   — that is exactly how a guard turns into a new source of drift.

## 6. State file

`$DSH_HOME/dsh-interaction-merged/state.json`, mode `0600` where supported.

- `schema: "dsh-interaction-merged/2"`.
- `sessions`: per-session task, correction, temporary requirement, waiting state, last snippets
  (220/300 chars), last decision, injection record.
- `prefs`: standing preferences with `status` (`active` / `superseded`).
- `removedPrefs`: tombstones so a deleted preference is not resurrected by a merge.
- `lastInjected`: last injected section names and size.

Corrupt files are backed up next to the original (`state.json.corrupt-<time>`) before recovery.

## 7. Token cost

Worst case per turn: `maxChars` (620) characters plus protected control sections, usually a few
hundred characters total. Measure it with `/itk why` (`上次注入 … 字符`). Lower `maxChars` if the
overhead matters; raise it if task text is being trimmed too aggressively.

## 8. Tests

```text
npm test
```

`node --test` discovery; helper fixtures live in `scripts/fixtures/`. Offline only.

## 9. Troubleshooting

### 9.1 Plugin appears installed but nothing happens

Checklist, in order:

1. **Dependency present** — profile `package.json` `dependencies` contains
   `dsh-interaction-merged`.
2. **Bundle selected** — profile `package.json` `dsh.profile.bundles` contains it.
3. **Resolvable** — from the profile directory:
   `node -e "console.log(require.resolve('dsh-interaction-merged/package.json'))"`.
   If this fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, the package's `exports` does not expose
   `./package.json`; DSH resolves the manifest this way and silently skips the bundle. Add
   `"./package.json": "./package.json"` to `exports`.
4. **Patch declared** — `<package>/package.json` has `dsh.bundle.patch` pointing at an existing
   YAML file.
5. **Installed through the package manager** — editing files by hand is not enough; the profile's
   `pnpm-lock.yaml` must contain the package. Run the official install path.
6. **Restarted** — bundles are resolved at startup; a running host does not pick up a new bundle.

### 9.2 `/itk` says the command does not exist

The plugin is not mounted. See 9.1. An entry id is `include:dsh-interaction-merged` in
`list_plugins` when mounted.

### 9.3 Tools stay blocked

A clarification is pending. Answer it, send a new task, or wait five minutes. `/itk` shows
`等待：awaiting_input` and `/itk why` shows the pending state.

### 9.4 A reply replaced the task instead of being attached

The assistant's question was not recognised as waiting for material. Add the local question form
to `inferWaiting` in `index.js`. See the AI adaptation guide.

### 9.5 Wake word breaks “继续”

`wakeWords` is stripped only if listed. Add the name; the prefix is then removed before judging
and before storing.

### 9.6 Install fails with `EPERM` while DSH is running

A file inside `node_modules` is held by the running app. Close DSH, run the install again, or
retry after the lock clears. `pnpm install --config.ignore-scripts=true` avoids postinstall
falures; rebuild the native packages you actually need afterwards.

## 10. Privacy and security

No network code, no model calls, no third-party dependencies. See `PRIVACY.md` and `SECURITY.md`.

## 11. For an AI agent porting this

Read `docs/AI-ADAPTATION.md`. It lists every heuristic, where it lives, how to measure it on the
target machine, and the exact verification steps that catch the silent-skip class of failures.
