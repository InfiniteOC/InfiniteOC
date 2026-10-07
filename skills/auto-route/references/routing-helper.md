# Advisory routing helper

The skill's phase rules normally suffice. For complex/ambiguous software work,
use `scripts/route.py` to get a small, reproducible recommendation from explicit
facts. It uses only Python's standard library, reads at most 64 KiB of JSON, and
does not execute commands, read project files, load skills, send network requests,
or write state. No prompt-classification model or keyword router is involved.

```sh
python3 /home/rize/.config/opencode/skill-library/auto-route/scripts/route.py --facts - <<'JSON'
{"mode":"act","task":"design","phase":"implement","surface":"web","failure":true,"shared_change":true,"browser":"available"}
JSON
```

This represents a UI addition that broke existing behavior. It must route to
debugging, not more design polish. It does **not** establish the root cause.
The agent must gather the facts; a successful helper exit is not a passed test.

## Input

Provide an object via `--facts /absolute/path/facts.json` or `--facts -` (stdin).
Omitted fields use the defaults below. Unknown keys, duplicate keys, invalid
types/enums, oversized input, and malformed JSON are errors. Keep secrets out of
the input; none of these fields needs source code, prompts, credentials, or URLs.

| Field | Accepted values | Default |
|---|---|---|
| `domain` | `code`, `other` | `code` |
| `task` | `feature`, `bug`, `design`, `review` | `feature` |
| `phase` | `inspect`, `implement`, `debug`, `verify`, `finish` | `inspect` |
| `mode` | `act`, `read-only`; mirror actual authorization | `read-only` |
| `surface` | `web`, `tui`, `cli`, `library`, `none` | `none` |
| `risk` | `low`, `normal`, `high` | `normal` |
| `failure` | boolean: observed unresolved failure | `false` |
| `resumed` | boolean: context recovery not yet completed | `false` |
| `shared_change` | boolean: affected shared behavior/contract | `false` |
| `external_integration` | boolean: affected external contract | `false` |
| `failed_attempts` | integer 0–100: unsuccessful fix hypotheses | `0` |
| `new_evidence` | boolean: recorded new discriminating evidence after failed hypotheses | `false` |
| `evidence` | `missing`, `stale`, `fresh` | `missing` |
| `browser` | `available`, `unavailable`, `unknown` | `unknown` |

Set `domain: "other"` for prose/research/data/documents and follow the skill's
medium-specific route. This helper does not choose those domains' expertise.
`fresh` is an agent-reported fact, never a certificate of completion. Clear
`resumed` only after reconciling state; clear `failure` only with reproduction
evidence. Carry unsuccessful hypotheses across compaction.
`new_evidence` releases the repeated-attempt hold only for a targeted next fix;
it does not reset history or override read-only/recovery. Set it only after
recording what changed the hypothesis, and clear it if that new hypothesis fails.

## Output and limits

JSON includes `phase`, `mode`, `risk`, up to three immediate `skills`, `checks`,
`holds`, and on-demand `references`. It is explicitly marked `advisory`.

- Recovery precedes editing; known failures precede implementation or polish.
- Read-only mode and repeated failed hypotheses constrain actions, not legitimate
  evidence gathering. No field authorizes destructive operations or external costs.
- Shared changes and integrations add preservation/contract checks.
- `consider-independent-review` means assess whether a separate reviewer helps;
  it is not a mandate to launch subagents. Review the final diff in all cases.
- Web, TUI, and CLI verification use distinct runtime checks. A browser that is
  unavailable/unchecked cannot yield verified UI claims.
- After repair, `task: "bug"` with `phase: "verify"` or `"finish"` and no remaining
  observed failure can reach verification; an unresolved failure still wins.
- `finish` routes to verification even with `evidence: "fresh"`. The helper never
  returns a completed/healthy verdict.

Resolve suggested IDs through the native skill tool or catalog; check actual
permissions and prerequisites. A recommendation cannot guarantee tools are
installed or usable, and a skill file existing proves neither. Preserve the
one-primary-plus-complements context budget, loading later-phase guidance only
when needed. For simple work, do not create JSON just to satisfy a ceremony.