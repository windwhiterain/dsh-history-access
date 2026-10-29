# dsh-history-access

Model-facing recall of a session's own pre-compaction history for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Compaction replaces earlier conversation with a summary. The originals stay in the session's append-only log, but nothing told the model they were reachable, so recovering a condensed detail meant remembering it or shelling out to read and decompress a `session.vN.jsonl.zstd` file by hand. This plugin registers three tools over the durable log — an outline, a windowed transcript read with a span-map view, and a literal search — and injects one short pointer after a compaction pass so the model knows what was condensed and how to get it back.

Those three tools are registered **lazily**: a session that has condensed nothing never sees them, so recall costs no schema tokens until there is something to recall. The registration lands in the calling agent's own scope at the moment the need appears — on a completed compaction pass, or at agent creation for a session that already carries checkpoints (a resume). Registering mid-session is a first-class harness operation: the loop logs a `request/header` for the new tool set plus a `developer/message` carrying `tool-addition` blocks, so the model is told the tools appeared and sees their schemas from the next step on.

## The data path

The plugin reads the session through a registered `sessionProjections` unit with no wire view. That unit appends each committed event reference to a per-session array — the projection registry already folds the array from the in-memory log on first materialization and drives it per append — and the plugin advances its own derived index (checkpoints, shadowed-owner map, turns, per-turn surface counts) over the events appended since the previous call. A recall tool therefore costs O(events appended since the previous call) and works on references the session already holds: no index, no embeddings, no sidecar file, no disk read, no second model call, and no deep clone of the session.

This is the whole point of the rewrite. The previous data path asked `sessionQuery` for the session structure on every call, and each of its calls deep-clones the entire live log (`snapshotLive`); one `history_read` made ~24 such calls, which measured ~20 s and ~1 GB of heap per call on a 58k-event session. The transcript pages were also a fixed 8,000 characters, about 7 events in that session, so every page cut and every cut cost another 20-second round trip. See [`docs/notes/recall-v2.md`](docs/notes/recall-v2.md) for the measurements and the design record.

The plugin declares no dependency and imports no harness package: it talks to the injected `ctx` services only.

## The three tools

| Tool | Arguments | Returns |
|---|---|---|
| `history_outline` | none | The session's event count, every compaction checkpoint (id `c<summarySeq>`, summary seq, shadowed event count, shadowed seq range, shadowed token count, time, whether a later checkpoint superseded it, and a one-line summary preview), and the turn list (index, seq range, event count, visible or shadowed, and the turn's first user message). Bounded by `outlineMaxChars`; the checkpoint list stays complete and turn detail is elided behind an explicit marker. |
| `history_read` | `checkpoint` (optional), `seq` (optional), `cursor` (optional), `chars` (optional), `events` (optional), `view` (optional) | A page of the role-labeled transcript (`User:`, `Assistant:`, `Tool result:`, each carrying its event seq), or — with `view: "map"` — a one-line-per-event index of the same range. `checkpoint` reads the exact span that checkpoint replaced, including superseded checkpoints; `seq` reads forward from that position; the two combine to start inside a span; `cursor` continues a previous page. Bounded by the caller's `chars`/`events` budgets (clamped into the deployment's range). A cut page or a truncated event is marked explicitly and reports how many events remain. |
| `history_search` | `query` (required), `checkpoint` (optional), `limit` (optional), `context` (optional) | Numbered matches over this session's message text — every shadowed span plus currently visible history, or one checkpoint's span — each with `seq`, `surface`, the owning checkpoint id (or `(visible)`), its time, its role, and a snippet `context` characters wide, followed by `scanned`, `matched`, and `truncated`. |

`history_read` and `history_search` both state in their own descriptions that they are the supported way to recover condensed history, and that session files must not be read or decompressed. The plugin ships no system-prompt section, so those descriptions are the only standing hint the model gets — and after a lazy registration the harness announces the tools itself, one `tool-addition` block per tool, so the model learns they exist without the plugin spending a word on it.

### Page budgets

A call names its page size instead of accepting the plugin's:

- `chars` defaults to `readDefaultChars` (24,000) and is clamped into `[1200, readMaxChars]`; `events` defaults to `readDefaultEvents` (120) and is clamped into `[1, readMaxEvents]`. A value out of range is clamped and reported in the page's status line rather than rejected, because a page that asked for more than the deployment allows still has a useful answer.
- The continuation cursor carries the budgets of the page it came from (`c245@470@24000@120`), so continuing a page keeps the size the caller chose instead of silently growing to the deployment default.
- A page never splits an event: when the next event is larger than the remaining room, the page ends early and the status line says how many events remain. That is why a page may be shorter than its budget, and why `chars` is the honest lever for fetching a whole region at once.

### Reading versus mapping

`view: "map"` renders the same range as an index: `seq 40350 | Assistant | 2.1k | …preview…`, plus user requests, error tool results, and nested checkpoint summaries. It exists because the expensive part of recall is not reading text, it is finding where in a large span the text is. A span map costs a few hundred milliseconds for thousands of events, and its entries name the exact seq to read next. A successful tool result is not a map entry; it is bulk content for the transcript.

## Example pages

```
history_read checkpoint c245 — shadowed seqs 41-188, 96 events, ~18422 tokens
showing 12 events (seqs 41-96); 84 more in this range; budget 24000 chars / 120 events
User (seq 41): Fix the failing retry tests.
Assistant (seq 42): I will inspect the retry helper first.
  [tool call] read {"path":"src/retry.ts"}
Tool result (seq 44): export const RETRY_BUDGET_ATTEMPTS = 3
… [page cut; call history_read again with this cursor, or pass a larger chars for one bigger page]
cursor: c245@97@24000@120
```

```
history_read map checkpoint c245 — shadowed seqs 41-188, 96 events, ~18422 tokens
showing 40 lines (seqs 41-96); 44 more in this range; budget 24000 chars / 120 lines
seq 41 | User | 38 | Fix the failing retry tests.
seq 42 | Assistant | 121 | I will inspect the retry helper first.
seq 44 | Tool result (error) | 1840 | error[E0308]: mismatched types…
… [end of this range]
```

```
history_search "retry budget" — 412 events scanned, 2 matched, showing 2
1. seq 44 | shadowed | c245 | 2026-07-06 12:03Z | Tool result
   …export const RETRY_BUDGET_ATTEMPTS = 3…
2. seq 401 | visible | (visible) | 2026-07-06 12:41Z | Assistant
   …the retry budget is 3 attempts, then it gives up…
scanned 412, matched 2, truncated false
```

## Configuration

Every field is optional; an unknown field, a non-integer, a non-positive value, or one outside its range fails at load with an actionable message. `readDefaultChars` may not exceed `readMaxChars`, and `readDefaultEvents` may not exceed `readMaxEvents`.

| Field | Type | Default | Range | Meaning |
|---|---|---|---|---|
| `readDefaultChars` | integer | `24000` | 1200–1000000 | Character budget of one `history_read` page (or span map) when the call names none. |
| `readMaxChars` | integer | `200000` | 1200–2000000 | Largest character budget a call may request. The same budget caps one `history_search` page after its hit limit. |
| `readDefaultEvents` | integer | `120` | 1–1000 | Event (or map line) budget of one page when the call names none. |
| `readMaxEvents` | integer | `1000` | 1–1000 | Largest event (or map line) budget a call may request. |
| `searchMaxHits` | integer | `20` | 1–200 | Maximum matches one `history_search` call reports, and the ceiling its `limit` argument is clamped to. |
| `searchDefaultContext` | integer | `600` | 80–4000 | Snippet width around one search hit when the call names none. |
| `outlineMaxChars` | integer | `4000` | 200–1000000 | Character budget for `history_outline`. The checkpoint list is kept complete even when it alone exceeds the budget. |
| `pointer` | `'inject'` \| `'off'` | `'inject'` | — | Whether a completed compaction pass injects the pointer described below. |

## The post-compaction pointer

On a completed compaction pass (`compaction/end` with no `error`) for a session that still has a live agent, the plugin first registers its three tools into that agent's scope and then stages one short message with `Agent.inject`:

```
Context was condensed into checkpoint c245: 96 earlier events (~18422 tokens) were replaced by its summary.
The originals are still recorded in this session — call history_read (checkpoint "c245") or history_search to retrieve them; do not read or decompress session files.
```

Delivery is deduped per `compactionId`, so one completed pass produces one pointer even if the event feed repeats; a failed pass (`compaction/end` carrying `error`) produces none; and a session with no live agent is skipped. The listener never throws into the host: a disposed agent's rejection is logged and dropped. The message carries `source: { kind: 'history-access' }` and appears in the session log like any other injected context.

Delivery is deferred by one microtask past the publishing append. A `session/event` listener runs inside `Session.append()`, whose append lock is still held, so splicing the inbox synchronously is refused with `session append cannot reenter while another append is being published`; the pass is recorded as delivered only once the splice succeeded, so a failed delivery is retried by the same pass's next `compaction/end`.

The pointer costs roughly 40 tokens of context per completed pass, and it is the only context this plugin ever supplies.

## Lazy tool registration

`apply()` registers no tools. Each agent that needs recall gets them in its own scope (`agent.ctx.tools.register`) at one of two moments:

| Moment | Trigger | Covers |
|---|---|---|
| A completed compaction pass | `compaction/end` with no `error` for a session with a live agent | The ordinary case: this session has just condensed something. |
| Agent creation | `agent/created`, when the session's derived index already holds a checkpoint | A resume, whose earlier condensation happened before this plugin was loaded. The check reads the feed's index, which the projection service folds from the in-memory log the resume already loaded — no service query and no disk read. |

Three consequences are worth stating explicitly:

- **The step that triggered the compaction still runs with the old schema.** Automatic compaction runs in the `agent/pre-step` waterfall (context pressure) or on `agent/request-error` (overflow recovery), both after that step's assembly has already been taken. The tools appear in the next step's request, which the `tool-addition` developer message announces in the same breath.
- **Registration is idempotent and per session.** A second checkpoint, a repeated `agent/created`, or a hot reload must not collide with a name already present in the scope, so a name the scope already resolves is skipped.
- **Nothing needs teardown.** Registration is owned by the agent's own fiber, so it unwinds when the agent is disposed. Because a scope's own layer is exempt from `tools.restrict()`, a preset that masks global tools cannot strip recall from its agents.

A hot reload runs `apply()` again on a fresh fiber, which subscribes its own listeners and registers a fresh projection feed; the previous registration is disposed with its fiber. An agent created before the reload already holds its tools and is skipped by that idempotence check.

## Install and wiring

Three steps: install the package into the profile, add the row to the profile's live patch layer, and (when developing the plugin) add the source files to `hmr.root`.

### 1. Install as a `link:` dependency

From the directory that contains your checkout of this repository:

```sh
dsh plugin --profile web add ./dsh-history-access
```

A `link:` dependency resolves to the real directory, so the host runs the files in that tree. Install a stable checkout, not a development worktree. A **new** dependency is normally read at startup, so restart the host after installing.

This package declares no `dsh.bundle` manifest, so `dsh plugin add` installs it as a plain dependency and activates no layer of its own. Step 2 wires the row.

### 2. Wire the row

`~/.dsh/profiles/web/cordis.patch.yml` is watched and reloaded live. A bare top-level row is read as an id-targeted override and warns, so the row must sit in an `insert` list:

```yaml
- insert:
    - id: history-access
      name: 'dsh-history-access'
      config:
        readDefaultChars: 24000
        readMaxChars: 200000
        readDefaultEvents: 120
        readMaxEvents: 1000
        searchMaxHits: 20
        searchDefaultContext: 600
        outlineMaxChars: 4000
        pointer: inject
```

`config` is the whole config object — a later override replaces it rather than merging into it.

The row registers the plugin, not the tools: nothing is visible to any agent until that agent's own session condenses something. Because registration lands in the agent's own scope, a preset whose `tool-restrict` row masks global tools cannot hide recall from its agents — the scope's own layer is exempt from restrictions. Mounting the same row inside a preset works too, and the plugin's two listeners are subscribed globally either way, so a per-preset row still serves every session that preset owns.

### 3. Add the source files to `hmr.root`

To edit the plugin while the host runs, list the files (not the directory) in the `hmr` row's config. An override replaces the whole `config`, so restate every key:

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    # The directory that contains your dsh-history-access checkout.
    base: '/path/to/parent'
    root:
      - '/path/to/parent/dsh-history-access/index.js'
      - '/path/to/parent/dsh-history-access/lib/config.js'
      - '/path/to/parent/dsh-history-access/lib/event-text.js'
      - '/path/to/parent/dsh-history-access/lib/pointer.js'
      - '/path/to/parent/dsh-history-access/lib/query.js'
      - '/path/to/parent/dsh-history-access/lib/recall-index.js'
      - '/path/to/parent/dsh-history-access/lib/render.js'
```

`base` accepts a relative path or a `file://` URL (an absolute drive path parses as a URL scheme and fails activation), and it must be an ancestor of every root. A reload disposes the plugin and imports it again, so `apply()` re-runs; the listeners and the projection feed ride the fiber, so nothing is duplicated, and an already-armed agent keeps the registration it owns.

## Verification

```sh
node probe/probe.mjs
```

The probe needs no host and no dependency. It drives `apply()` against an in-memory fake `ctx` whose `sessionProjections` service folds a synthetic log the way the real registry does (a registered definition is advanced with `init`/`apply`, and every tool reads it through `stateOf`). The log has four turns, an assistant message carrying a tool call, matching tool results, two compaction checkpoints where the second supersedes the first, and the replacement `user/message` events carrying `surfaceOp: { op: 'replace', … }`. 47 probes pass, covering lazy registration (nothing at `apply()`, arming on a completed pass and at `agent/created`, idempotence across passes, per-agent ownership, a failed pass and an agentless pass arming nothing), the outline and turn visibility, transcript pagination with a cursor that keeps its budgets, checkpoint-plus-seq composition, explicit truncation and every page's character budget, the span map and its line budget, literal search with role and snippet width, limit clamping, the executing-step exclusion, every rejection path, configuration validation including the cross-field rules, and the pointer's text, dedupe, deferral, and failure containment.

A second probe replays a real session log through the same path and reports the millisecond cost of each tool, so the performance claim stays measured:

```sh
node probe/bench.mjs <session-log|sessions-root> [limit] [query]
```

On a 59k-event session (204 MB decoded, 22 checkpoints, 1,964-event largest span) the first index fold takes ~10 ms, a subsequent call ~50 µs, `history_outline` ~2 ms, a 24k-char transcript page under 1 ms, a 24k-char span map under 1 ms, a whole-log literal search ~40 ms, and a full 1,964-position paging walk 21 pages / ~9 ms with no duplicated position. The same log takes ~950 ms for one deep clone, which is what a single `sessionQuery` structure read cost before this path.

A third, read-only probe reports what a real session log proves, for acceptance runs against a live host:

```sh
node probe/session-inspect.mjs <session-log|sessions-root> [limit]
```

It decodes the zstd-framed log and prints, per session, the first request header that offered the history tools (the arming moment) and the tool count of the latest header, every compaction pass with the span it shadowed, every pointer this plugin injected, and every call the tools received with its result size.

## Known Limitations

- **Recall is a learned behavior.** Untrained models under-use any new tool, and this plugin ships no system-prompt section, so the tool descriptions are the entire teaching surface. Expect misses that are the model's choice, not a read failure. Lazy registration adds one wrinkle: the model has never seen these tools before the step where they appear, so the `tool-addition` announcement is the whole introduction.
- **The tool that would do the work is still missing on the step that triggers the compaction.** A model that runs out of context mid-turn cannot call `history_read` in that same step, because the step's request was assembled before the compaction; the tools arrive on the next one. Nothing the plugin can do changes that — the schema for a running request is already frozen.
- **A session that is already running when the plugin is hot-loaded stays unarmed until it compacts again.** The `agent/created` bootstrap covers a session that is created or resumed while the plugin is loaded, but a live session never re-fires that event, so a session that already carried checkpoints before the reload waits for its next completed pass — or for a resume.
- **Literal search only.** `history_search` is a case-insensitive literal phrase match (words may match across whitespace). No regex, no fuzzy match, no semantic search. It also inherits this plugin's text extraction: reasoning blocks and `system`/`developer` messages contribute no searchable text, so a phrase that appears only there is not findable — read the span with `history_read` instead.
- **Single-session scope.** Only the calling agent's own session is reachable. Parent, child, and sibling sessions are out of scope, and there is no cross-session search.
- **The pointer arrives on the following step, not the request that carries the summary.** The pointer is staged at `compaction/end` with `Agent.inject`, and injected context is claimed at the next step boundary. A pass that runs at the end of a turn therefore delivers the pointer at the next turn's first request, and `inject` never wakes an idle agent, so a session that stays idle sees it only when something else wakes it. This was observed in a one-shot host run: every completed pass delivered its pointer to the next step, and the model then read the condensed span with `history_read`.
- **Injected attribution is admitted by the format reader and was observed in a real log.** The V4 admission rule (`packages/session/session-format-v3-to-v4/src/message-sources.ts`) requires a non-empty `source.kind` other than the retired `'plugin'`, which an out-of-tree plugin cannot use; `'history-access'` satisfies it. A `--session-id` resume of a session carrying 20 delivered pointers passed the query service's replay validation before driving its task.
- **A superseded checkpoint's own node renders at its own log position.** Transcript events are ordered by raw seq. When one compaction replaced an earlier checkpoint's replacement node, that node's text (the earlier summary) appears where its seq falls rather than at the head of the restored span. The text is complete; only the ordering differs from what the model originally saw.
- **`outlineMaxChars` can be exceeded by the checkpoint list.** The list is kept complete on purpose — a checkpoint a model cannot see is one it cannot read — so only turn detail is elided.
- **The index is derived, not persisted.** A host restart or a plugin reload refolds the in-memory log on the first recall call: ~10 ms for 59k events, and it never touches disk because the session is already live in memory.
- **The feed retains one event reference per live session.** Payloads are shared with the session's own log, so the added memory is proportional to the number of events, not to their text. A deployment that mounts no `sessionProjections` service keeps the tools unregistered.
- **A page never splits an event, so a page can end well under its budget.** The status line reports the remaining event count and the cut marker names the larger `chars` that would fetch it; the model decides whether to include the large event.
- **A span map is bounded like any other page.** A 1,964-event span needs a handful of map pages at the default budgets (fewer with a larger `chars` or `events`), because each line carries a preview and the line budget is the page budget.
- **`readMaxEvents` counts rendered events.** A page may read further raw events to find enough renderable ones, so the raw-read count is not bounded by that field; the character budget still bounds the returned page.
- **The plugin performs no workspace authorization.** It reads only the caller's own session, so there is no second session to authorize against and no `cwd` check.
- **A detail that no summary and no literal phrase points at stays unreachable.** Recall converts "unreachable even when suspected" into "reachable when suspected"; it cannot surface a fact the model has no reason to look for.

## License

MIT
