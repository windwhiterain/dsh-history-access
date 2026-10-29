# recall-v2: windowed, indexed history recall

Status: implemented in `feat/recall-v2` (2026-10-29).
Supersedes the per-call `sessionQuery` data path and the fixed 8,000-character
page of the first version.

## The complaint

> "the history read plugin is very bad — it actually requires the agent to make
> chained calls over and over again"

The chain was not a model quirk. It was the only behavior the tool allowed.

## What one real session showed

Sample: `session-19ac76ce-c5b2-48ad-a729-e6f7ba89d0ac` (lichen-vm), 57,901 events
at measurement time, 40 hours, 22 compaction checkpoints. It was the only
session in `~/.dsh/sessions` that ever armed the tools.

| Measure | Value |
|---|---|
| history tool calls | 126 (read 64, search 60, outline 2) |
| `history_read` pages | 60 successful, **60 of 60 cut** |
| events per page | median 7 (max 21) |
| page size | median 6,005 chars against an 8,000-char budget |
| failed reads | 4 — the model passed `checkpoint` + `seq` and was rejected |
| failed searches | 1 — `limit: 30` against a hard maximum of 20 |
| median latency | read 20.7 s, search 18.1 s, outline 16.9 s |
| total tool time | ~38 minutes; 323 KB of transcript returned |
| same-session comparison | `read` 11 ms, `grep` 178 ms, `edit` 27 ms |

The model's reasoning in the log shows what it was doing: "history_read seq 900?
… 930? … 960?" — guessing positions and reading forward, because a page showed
about seven events and nothing told it what was in the span.

## Root causes

1. **Every call rebuilt the whole session structure.** `structure()` issued one
   `listEvents`, one `readEvent` per checkpoint (22 at the end), and one
   `filterEvents` for turn previews. Every one of those `sessionQuery` calls
   deep-clones the entire live log (`snapshotLive` in
   `dsh-session-query/lib/index.js`); measured on this log, one clone is
   ~0.9–1.2 s and ~1 GB of heap. About 24 clones per call is the observed 20 s.
   The cost also grows with the number of checkpoints, so the tool got slower as
   the session aged.
2. **The page size was a plugin constant and far too small.** 8,000 chars is
   ~7 events for this session's messages; a 1,964-event span cannot be read in
   fewer than dozens of calls. The caller could not ask for more.
3. **The selectors were mutually exclusive.** "Read inside checkpoint c43336
   from seq 42500" is the most common intent; `checkpoint` + `seq` was a hard
   error. Four calls in this session were exactly that.
4. **Navigation was blind.** The only map was a 180-character snippet search, so
   the model guessed seqs and read pages to see what was there.
5. **Out-of-range arguments failed instead of clamping.** A model asking for
   30 search hits got an error, not 20 hits plus `truncated`.

## Decision

The operator approved the full scope ("全部做到最好，不设限制") and wanted the
span map as well. Three layers, all implemented:

- **A. Windowed pages.** `chars` / `events` are caller arguments, clamped into
  the deployment's range; defaults are 24,000 chars / 120 events, ceilings
  200,000 / 1,000. `checkpoint` + `seq` combine. The cursor carries the range,
  the resume position, and the budgets it was produced under. The status line
  reports how many events remain in the range; the cut marker names the larger
  `chars` that would fetch more.
- **B. An indexed data path.** A `sessionProjections` unit with no wire view
  ("history-access.events.v1") appends each committed event reference; the
  plugin advances a derived index (checkpoints, shadowed owner, turns,
  per-turn surface counts) over the events appended since the previous call.
  A tool call is O(new events). No `sessionQuery` call remains, so no
  whole-session clone.
- **C. A span map.** `history_read` with `view: "map"` renders one line per
  navigation event (`seq | role | size | preview`) for the same range, with the
  same budgets and cursor. A successful tool result is not a map entry.

Rejected alternatives:

- **Keep `sessionQuery`, cache only the structure.** Reads still need one
  `readEvent` per window and searches two `filterEvents`, each cloning the whole
  log: ~1–2 s per call instead of milliseconds. Rejected as not enough.
- **Read `Session.snapshotEvents()` / `eventAt()` directly.** The harness marks
  these synchronous readers deprecated and prohibits new production calls.
  A registered projection is the sanctioned incremental seam.
- **Put the span map on `history_outline`.** `history_read` already owns range,
  position, budget, and cursor semantics; a second argument vocabulary on the
  outline would duplicate them. `view` on the read reuses one engine.
- **Return the whole span in one call.** Impossible for this session: the
  largest span is ~623k tokens. The goal is any single answer in one call, not
  the whole history in one call.

## Measurements after the change

`node probe/bench.mjs <the log>` on 59k events (204 MB decoded, 22 checkpoints):

| Work | Cost |
|---|---|
| first index fold (59k events) | ~10 ms |
| subsequent tool call (index advance) | ~50 µs |
| `history_outline` | ~2 ms |
| transcript page, 24k chars (30 events) | ~0.8 ms |
| transcript page, 100k chars (99k chars returned) | ~0.5 ms |
| span map, 24k chars (120 lines) | ~0.6 ms |
| literal search over the whole log (20,785 searchable events) | ~40 ms |
| full 1,964-position paging walk | 21 pages, ~9 ms, 0 duplicates |
| reference: one deep clone of the log | ~950 ms |

`node probe/probe.mjs`: 47 offline probes pass.

## Invariants of the data path

- The feed is append-only and holds event references, never event copies: the
  projection service builds it from the in-memory log, so it adds no payload
  memory.
- The derived index is folded in seq order and assumes `event.seq` equals its
  position in the feed; the session log guarantees that contiguity.
- `stateOf` is called per tool call; `materializeCells` advances every registered
  projection, so the per-call cost is O(events appended), not O(log size).
- The index is not persisted. A reload or restart refolds once (~10 ms for 59k
  events) from the live session.
- The feed key is versioned (`…v1`). The feed's state shape is trivial, so a
  code change does not require a new key; a future shape change does.
