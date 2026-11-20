# Security

This plugin runs locally and does not make model or network requests. It has no dependencies
and executes nothing on the user's behalf; it only appends short prompt sections and keeps
local state.

## Data

- State is stored locally at `$DSH_HOME/dsh-interaction-merged/state.json`, mode `0600` where
  the platform supports it.
- It contains truncated user/assistant snippets, task/correction/temporary state, preferences,
  action counts, and trace IDs.
- It does not store full chat logs, API keys, or credentials.
- Toggle and edit commands report a failed write instead of pretending success; a failed
  write leaves the previous flag in place.

## Prompt-injection surface

- The plugin never trusts recalled material as the user's own instruction: host-injected
  context (`runtime-context`, `untrusted-memory`, …) cannot create or replace a task.
- Injected sections are short, bounded by `maxChars`, and marked as control sections only for
  the plugin's own guidance.

## Reporting

Please open a GitHub issue for security-relevant behavior. Do not include real chat
transcripts, credentials, or personal data in the report; use a minimal reproduction. If the
report needs diagnostic output, prefer `/itk why` (redacted) over `/itk why raw`.

## Scope

The plugin only injects prompt sections and maintains local task state. Hard safety enforcement
remains the responsibility of DSH approvals, sandboxing, and other guard layers.
