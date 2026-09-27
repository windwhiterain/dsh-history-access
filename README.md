# dsh-history-access

Model-facing recall of a session's own pre-compaction history for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Compaction replaces earlier conversation with a summary. The originals stay in the session's append-only log, but nothing told the model they were reachable, so recovering a condensed detail meant remembering it or shelling out to read and decompress a `session.vN.jsonl.zstd` file by hand. This plugin registers three tools over the durable log — an outline, a paginated transcript read, and a literal search — and injects one short pointer after a compaction pass so the model knows what was condensed and how to get it back.

Everything is read from the log through `ctx.sessionQuery`. There is no index, no embedding, no sidecar file, no disk read, and no second model call, so a recall result is a pure function of what the session recorded. The plugin declares no dependency and imports no harness package: it talks to the injected `ctx` services only.

## The three tools

| Tool | Arguments | Returns |
|---|---|---|
| `history_outline` | none | The session's event count, every compaction checkpoint (id `c<summarySeq>`, summary seq, shadowed event count, shadowed seq range, shadowed token count, time, whether a later checkpoint superseded it, and a one-line summary preview), and the turn list (index, seq range, event count, visible or shadowed, and the turn's first user message). Bounded by `outlineMaxChars`; the checkpoint list stays complete and turn detail is elided behind an explicit marker. |
| `history_read` | `checkpoint` (optional), `seq` (optional), `cursor` (optional) | A page of the role-labeled transcript (`User:`, `Assistant:`, `Tool result:`, each carrying its event seq). `checkpoint` reads the exact span that checkpoint replaced, including superseded checkpoints; `seq` reads forward from that position; `cursor` reads the next page of a previous result. Bounded by `readMaxChars` and `readMaxEvents`; a cut event or page is marked explicitly. |
| `history_search` | `query` (required), `checkpoint` (optional), `limit` (optional) | Numbered matches over this session's message text — every shadowed span plus currently visible history, or one checkpoint's span — each with `seq`, `surface`, the owning checkpoint id (or `(visible)`), its time, and a snippet around the match, followed by `scanned`, `matched`, and `truncated`. |

`history_read` and `history_search` both state in their own descriptions that they are the supported way to recover condensed history, and that session files must not be read or decompressed. The plugin ships no system-prompt section, so those descriptions are the only standing hint the model gets.

Examples of the returned text:

```
history_read checkpoint c245 — shadowed seqs 41-188, 96 events, ~18422 tokens
User (seq 41): Fix the failing retry tests.
Assistant (seq 42): I will inspect the retry helper first.
  [tool call] read {"path":"src/retry.ts"}
Tool result (seq 44): export const RETRY_BUDGET_ATTEMPTS = 3
… [page cut; more events follow — call history_read again with this cursor]
cursor: c245@45
```

```
history_search "retry budget" — 412 events scanned, 2 matched, showing 2
1. seq 44 | shadowed | c245 | 2026-07-06 12:03Z
   …export const RETRY_BUDGET_ATTEMPTS = 3…
2. seq 401 | visible | (visible) | 2026-07-06 12:41Z
   …the retry budget is 3 attempts, then it gives up…
scanned 412, matched 2, truncated false
```

## Configuration

Every field is optional; an unknown field, a non-integer, a non-positive value, or one outside its range fails at load with an actionable message.

| Field | Type | Default | Range | Meaning |
|---|---|---|---|---|
| `readMaxChars` | integer | `8000` | 400–1000000 | Character budget for one `history_read` page. The same budget caps one `history_search` page after its hit limit. |
| `readMaxEvents` | integer | `80` | 1–1000 | Maximum events one `history_read` page renders. |
| `searchMaxHits` | integer | `20` | 1–200 | Maximum matches one `history_search` call reports, and the ceiling its `limit` argument may request. |
| `outlineMaxChars` | integer | `4000` | 200–1000000 | Character budget for `history_outline`. The checkpoint list is kept complete even when it alone exceeds the budget. |
| `pointer` | `'inject'` \| `'off'` | `'inject'` | — | Whether a completed compaction pass injects the pointer described below. |

## The post-compaction pointer

On a completed compaction pass (`compaction/end` with no `error`) for a session that still has a live agent, the plugin stages one short message with `Agent.inject`:

```
Context was condensed into checkpoint c245: 96 earlier events (~18422 tokens) were replaced by its summary.
The originals are still recorded in this session — call history_read (checkpoint "c245") or history_search to retrieve them; do not read or decompress session files.
```

Delivery is deduped per `compactionId`, so one completed pass produces one pointer even if the event feed repeats; a failed pass (`compaction/end` carrying `error`) produces none; and a session with no live agent is skipped. The listener never throws into the host: a disposed agent's rejection is logged and dropped. The message carries `source: { kind: 'history-access' }` and appears in the session log like any other injected context.

Delivery is deferred by one microtask past the publishing append. A `session/event` listener runs inside `Session.append()`, whose append lock is still held, so splicing the inbox synchronously is refused with `session append cannot reenter while another append is being published`; the pass is recorded as delivered only once the splice succeeded, so a failed delivery is retried by the same pass's next `compaction/end`.

The pointer costs roughly 40 tokens of context per completed pass, and only while `pointer: inject` is set.

## Install and wiring

Three steps: install the package into the profile, add the row to the profile's live patch layer, and (when developing the plugin) add the source files to `hmr.root`.

### 1. Install as a `link:` dependency

```sh
cd ~/.dsh/profiles/web
pnpm add link:C:/resource/dsh-history-access
```

A `link:` dependency resolves to the real directory, so the host runs the files in that tree. Install the stable checkout, not a development worktree. A **new** dependency is normally read at startup, so a restart is the safe expectation; on a host that resolved the profile live, adding the row after the install loaded it without one.

### 2. Wire the row

`~/.dsh/profiles/web/cordis.patch.yml` is watched and reloaded live. A bare top-level row is read as an id-targeted override and warns, so the row must sit in an `insert` list:

```yaml
- insert:
    - id: history-access
      name: 'dsh-history-access'
      config:
        readMaxChars: 8000
        readMaxEvents: 80
        searchMaxHits: 20
        outlineMaxChars: 4000
        pointer: inject
```

`config` is the whole config object — a later override replaces it rather than merging into it.

A row here registers the three tools deployment-wide, so every agent sees them. A preset whose `tool-restrict` row masks global tools must keep `history_outline`, `history_read`, and `history_search` visible, or mount this plugin inside the preset instead (the same row, placed in the preset's plugin list) so the registration lands in that preset's own scope.

### 3. Add the source files to `hmr.root`

To edit the plugin while the host runs, list the files (not the directory) in the `hmr` row's config. An override replaces the whole `config`, so restate every key:

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    base: 'file:///C:/resource'
    root:
      - 'C:/resource/dsh-history-access/index.js'
      - 'C:/resource/dsh-history-access/lib/config.js'
      - 'C:/resource/dsh-history-access/lib/render.js'
      - 'C:/resource/dsh-history-access/lib/query.js'
      - 'C:/resource/dsh-history-access/lib/pointer.js'
```

`base` accepts a relative path or a `file://` URL (an absolute drive path parses as a URL scheme and fails activation), and it must be an ancestor of every root. A reload disposes the plugin and imports it again, so `apply()` re-runs; registrations ride the fiber, so nothing is duplicated.

## Verification

```sh
node probe/probe.mjs
```

The probe needs no host and no dependency. It drives `apply()` against an in-memory fake `ctx` and a fake `sessionQuery` serving a synthetic log with four turns, an assistant message carrying a tool call, matching tool results, two compaction checkpoints where the second supersedes the first, and the replacement `user/message` events carrying `surfaceOp: { op: 'replace', … }`. 36 probes pass, covering registration, the outline, transcript pagination (a working cursor with no duplicated or skipped event), explicit truncation and every page's character budget, literal search that names the owning checkpoint, the executing-step exclusion, every rejection path, configuration validation, service-failure translation, exact cancellation, and the pointer's text, dedupe, deferral, and failure containment.

A second, read-only probe reports what a real session log proves, for acceptance runs against a live host:

```sh
node probe/session-inspect.mjs <session-log|sessions-root> [limit]
```

It decodes the zstd-framed log and prints, per session, whether the request header carries the three tools, every compaction pass with the span it shadowed, every pointer this plugin injected, and every call the tools received with its result size.

## Known Limitations

- **Recall is a learned behavior.** Untrained models under-use any new tool, and this plugin ships no system-prompt section, so the tool descriptions are the entire teaching surface. Expect misses that are the model's choice, not a read failure.
- **Literal search only.** `history_search` is a case-insensitive literal phrase match (words may match across whitespace). No regex, no fuzzy match, no semantic search. It also inherits the harness's text extraction: reasoning blocks and `system`/`developer` messages contribute no searchable text, so a phrase that appears only there is not findable — read the span with `history_read` instead.
- **Single-session scope.** Only the calling agent's own session is reachable. Parent, child, and sibling sessions are out of scope, and there is no cross-session search.
- **The pointer arrives on the following step, not the request that carries the summary.** The pointer is staged at `compaction/end` with `Agent.inject`, and injected context is claimed at the next step boundary. A pass that runs at the end of a turn therefore delivers the pointer at the next turn's first request, and `inject` never wakes an idle agent, so a session that stays idle sees it only when something else wakes it. This was observed in a one-shot host run: every completed pass delivered its pointer to the next step, and the model then read the condensed span with `history_read`.
- **Injected attribution is admitted by the format reader and was observed in a real log.** The V4 admission rule (`packages/session/session-format-v3-to-v4/src/message-sources.ts`) requires a non-empty `source.kind` other than the retired `'plugin'`, which an out-of-tree plugin cannot use; `'history-access'` satisfies it. A `--session-id` resume of a session carrying 20 delivered pointers passed the query service's replay validation before driving its task.
- **A superseded checkpoint's own node renders at its own log position.** Transcript events are ordered by raw seq. When one compaction replaced an earlier checkpoint's replacement node, that node's text (the earlier summary) appears where its seq falls rather than at the head of the restored span. The text is complete; only the ordering differs from what the model originally saw.
- **`outlineMaxChars` can be exceeded by the checkpoint list.** The list is kept complete on purpose — a checkpoint a model cannot see is one it cannot read — so only turn detail is elided.
- **Every read goes through `ctx.sessionQuery`.** Without that service mounted, all three tools fail with a model-safe message. The plugin itself performs no I/O; the service may load a persisted log for a session that is not live, which for the intended caller (its own live session) does not arise.
- **`readMaxEvents` counts rendered events, not read events.** A page may read further raw events to find enough renderable ones, so the raw-read count is not bounded by that field; the character budget still bounds the returned page.
- **The plugin performs no workspace authorization.** It reads only the caller's own session, so there is no second session to authorize against and no `cwd` check.
- **A detail that no summary and no literal phrase points at stays unreachable.** Recall converts "unreachable even when suspected" into "reachable when suspected"; it cannot surface a fact the model has no reason to look for.

## License

MIT
