# Privacy

## What is stored

- Current task text, task ID, correction object, temporary requirement, waiting state.
- Up to 220 characters of the latest user input.
- Up to 300 characters of the latest assistant message.
- Explicit long-term preferences and their scope/status.
- Action counts and trace IDs.

## What is not stored

- Full chat history.
- API keys or credentials.
- Tool results, file contents, or command output.
- Messages the host injects on its own (`runtime-context`, `untrusted-memory`, compaction
  checkpoints, schedules, …): they never become task state.
- Data from other memory/plugin systems.

## Permissions and redaction

- The state file and its lock are written with mode `0600` where the platform supports it.
- Diagnostic output (`/itk`, `/itk why`, `/guard`) renders prompt-block names from other
  plugins as `外部块 N`. `/itk why raw` shows the original names; use it only when sharing is
  not a concern.
- Configuration can pass `wakeWords` to strip local honorifics; the default list is generic and
  contains no names.

## Deletion

- `/itk forget <id>` removes one preference.
- Uninstalling the plugin does not automatically delete `state.json`; delete the file manually
  if desired.
- Sessions are capped by LRU (50) but old task state may remain until evicted.

## Network

The plugin has no network code and makes no model calls.
