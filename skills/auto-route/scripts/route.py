#!/usr/bin/env python3
"""Deterministic advice from explicit facts; never classify prose or execute skills.

Only --facts FILE (or --facts - for stdin) is accepted. Read at most 64 KiB
plus one overflow byte, with no I/O beyond that input and JSON output. Success
is one object on stdout (exit 0); errors are one redacted object on stderr
(exit 2). Importing this module does not read input or execute the CLI.

Reference targets are relative to the auto-route skill directory, not cwd.
They are advisory links, not read/probed by this policy. The caller resolves
them; the test suite checks that the local reference documents exist.
"""

import json
import sys


MAX_BYTES = 64 * 1024
DEFAULTS = {
    "domain": "code",
    "task": "feature",
    "phase": "inspect",
    "mode": "read-only",
    "surface": "none",
    "risk": "normal",
    "failure": False,
    "resumed": False,
    "shared_change": False,
    "external_integration": False,
    "failed_attempts": 0,
    "new_evidence": False,
    "evidence": "missing",
    "browser": "unknown",
}
ENUMS = {
    "domain": ("code", "other"),
    "task": ("feature", "bug", "design", "review"),
    "phase": ("inspect", "implement", "debug", "verify", "finish"),
    "mode": ("act", "read-only"),
    "surface": ("web", "tui", "cli", "library", "none"),
    "risk": ("low", "normal", "high"),
    "evidence": ("missing", "stale", "fresh"),
    "browser": ("available", "unavailable", "unknown"),
}
MESSAGE = (
    "Facts are agent-reported; no tests/tools run and no completion certified. "
    "An available browser skill is not proof its executable exists. "
    "Checks are requirements, not permissions; read-only permits only "
    "non-mutating investigation/verification."
)


class PolicyError(Exception):
    """Only fixed messages or schema-owned field names may reach the CLI."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise PolicyError("invalid JSON constant")


def parse_facts(raw):
    if len(raw) > MAX_BYTES:
        raise PolicyError("facts exceed 64 KiB")
    try:
        supplied = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except (UnicodeError, ValueError, RecursionError):
        raise PolicyError("invalid UTF-8 JSON") from None
    if type(supplied) is not dict:
        raise PolicyError("facts must be a JSON object")
    if any(key not in DEFAULTS for key in supplied):
        raise PolicyError("unknown fact key")
    facts = {**DEFAULTS, **supplied}
    for key, value in facts.items():
        if key in ENUMS:
            valid = type(value) is str and value in ENUMS[key]
        elif key == "failed_attempts":
            valid = type(value) is int and 0 <= value <= 100
        else:
            valid = type(value) is bool
        if not valid:
            raise PolicyError("invalid fact: " + key)
    return facts


def route(facts):
    """Return requirements, not results, for one immediate phase of valid facts."""
    code = facts["domain"] == "code"
    phase = facts["phase"]
    if facts["resumed"]:
        phase = "recover"
    elif code and (facts["failure"] or phase == "debug" or
                   (facts["task"] == "bug" and phase not in ("verify", "finish"))):
        phase = "debug"
    elif phase == "finish":
        phase = "verify"

    risk = facts["risk"]
    cross_boundary = code and (facts["shared_change"] or facts["external_integration"])
    if cross_boundary and risk == "low":
        risk = "normal"
    elevated = code and (risk == "high" or cross_boundary)
    stalled = code and phase == "debug" and facts["failed_attempts"] >= 2 and not facts["new_evidence"]
    no_edits = facts["mode"] == "read-only" or phase == "recover" or stalled

    checks = ["baseline", "acceptance"]
    if code and (risk != "low" or phase == "debug"):
        checks.append("preservation")
    if elevated:
        checks.append("regression")
    if code and phase == "debug":
        checks.append("root-cause")
    if code and facts["surface"] in ("web", "tui", "cli"):
        runtime = {"web": "browser-runtime", "tui": "tui-runtime", "cli": "cli-runtime"}
        checks.append(runtime[facts["surface"]])
    if code and facts["external_integration"]:
        checks.append("integration-contract")
    if elevated or stalled or (code and facts["task"] == "review"):
        checks.append("consider-independent-review")

    holds = []
    if phase == "recover":
        holds.append("restore-state")
    if no_edits:
        holds.append("no-edits")
    if stalled:
        holds.append("investigate-before-more-edits")
    if code and facts["surface"] == "web" and facts["browser"] != "available":
        holds.append("browser-unverified")
    if facts["evidence"] != "fresh":
        holds.append("evidence-" + facts["evidence"])

    # Phase-first selection, rather than truncating a bag of skills, reserves
    # verification's first slot. At most three skills can be selected by design.
    skills = []
    if code:
        if phase == "verify":
            skills.append("verification-before-completion")
            if risk == "high" or facts["task"] == "review":
                skills.append("code-review-excellence")
        elif phase == "debug":
            skills.append("systematic-debugging")
        elif phase != "recover":
            if phase == "implement" and risk != "low" and not no_edits:
                skills.append("test-driven-development")
            if facts["task"] == "design":
                skills.append("impeccable")
            elif facts["task"] == "review":
                skills.append("code-review-excellence")
        if phase in ("debug", "verify") and facts["surface"] == "web":
            if facts["browser"] == "available":
                skills.append("playwright-cli")
            elif facts["browser"] == "unknown":
                skills.append("webapp-testing")

    references = ["references/reliability.md"] if code else []
    if phase == "recover":
        references.append("references/session-state.md")
    message = MESSAGE
    if stalled:
        message += " Continue read-only root-cause investigation; escalate if blocked. Resume a targeted fix only after recording new discriminating evidence; keep the attempt history."
    return {
        "phase": phase,
        "mode": facts["mode"],
        "risk": risk,
        "skills": skills,
        "checks": checks,
        "holds": holds,
        "references": references,
        "advisory": True,
        "message": message,
    }


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 2 or args[0] != "--facts":
            raise PolicyError("usage: route.py --facts JSON_FILE (or - for stdin)")
        try:
            if args[1] == "-":
                raw = sys.stdin.buffer.read(MAX_BYTES + 1)
            else:
                with open(args[1], "rb") as source:
                    raw = source.read(MAX_BYTES + 1)
        except (OSError, ValueError):
            raise PolicyError("cannot read facts") from None
        result = route(parse_facts(raw))
    except PolicyError as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())