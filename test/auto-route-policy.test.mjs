import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../skills/auto-route/scripts/route.py", import.meta.url))
const MAX_BYTES = 64 * 1024
const SECRET = "secret-that-must-not-be-echoed"
const message = "Facts are agent-reported; no tests/tools run and no completion certified. "
  + "An available browser skill is not proof its executable exists. "
  + "Checks are requirements, not permissions; read-only permits only non-mutating investigation/verification."
const outputKeys = ["phase", "mode", "risk", "skills", "checks", "holds", "references", "advisory", "message"]
const skillIDs = new Set([
  "systematic-debugging", "test-driven-development", "impeccable", "code-review-excellence",
  "verification-before-completion", "playwright-cli", "webapp-testing",
])
const checkTags = new Set([
  "baseline", "acceptance", "preservation", "regression", "root-cause", "browser-runtime",
  "tui-runtime", "cli-runtime", "integration-contract", "consider-independent-review",
])
const holdTags = new Set([
  "restore-state", "no-edits", "investigate-before-more-edits", "browser-unverified",
  "evidence-missing", "evidence-stale",
])

function python(args, input, options = {}) {
  const child = spawnSync("python3", args, {
    input, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, ...options,
  })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  return child
}

function cli(input, args = ["--facts", "-"], options = {}) {
  return python([script, ...args], input, options)
}

function success(child) {
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, "")
  assert.equal(child.stdout.trim().split("\n").length, 1)
  const result = JSON.parse(child.stdout)
  assert.deepEqual(Object.keys(result), outputKeys)
  assert.ok(["inspect", "implement", "debug", "verify", "recover"].includes(result.phase))
  assert.ok(["act", "read-only"].includes(result.mode))
  assert.ok(["low", "normal", "high"].includes(result.risk))
  assert.ok(result.skills.length <= 3)
  for (const [key, allowed] of [["skills", skillIDs], ["checks", checkTags], ["holds", holdTags]]) {
    assert.ok(Array.isArray(result[key]))
    assert.equal(new Set(result[key]).size, result[key].length)
    for (const item of result[key]) assert.ok(allowed.has(item), `${key}: ${item}`)
  }
  assert.ok(Array.isArray(result.references))
  for (const reference of result.references) {
    assert.ok(["references/reliability.md", "references/session-state.md"].includes(reference))
  }
  assert.equal(result.advisory, true)
  assert.ok(result.message.startsWith(message))
  if (result.phase === "verify" && result.references.includes("references/reliability.md")) {
    assert.equal(result.skills[0], "verification-before-completion")
  }
  return result
}

function route(facts) {
  return success(cli(JSON.stringify({ mode: "act", ...facts })))
}

function rejected(child, expected) {
  assert.equal(child.status, 2)
  assert.equal(child.stdout, "")
  assert.equal(child.stderr.trim().split("\n").length, 1)
  assert.ok(child.stderr.length < 160)
  assert.ok(!child.stderr.includes(SECRET))
  assert.ok(!child.stderr.includes("Traceback"))
  const error = JSON.parse(child.stderr)
  assert.deepEqual(Object.keys(error), ["error"])
  if (expected) assert.equal(error.error, expected)
}

test("empty object has the exact deterministic default output", () => {
  const child = cli("{}")
  assert.deepEqual(success(child), {
    phase: "inspect", mode: "read-only", risk: "normal", skills: [],
    checks: ["baseline", "acceptance", "preservation"], holds: ["no-edits", "evidence-missing"],
    references: ["references/reliability.md"], advisory: true, message,
  })
  assert.equal(cli("{}\n").stdout, child.stdout)
})

test("file and stdin facts agree, leave the file untouched, and work outside the repo", () => {
  const directory = mkdtempSync(join(tmpdir(), "auto-route-policy-"))
  try {
    const path = join(directory, "facts with spaces.json")
    const raw = JSON.stringify({ phase: "verify", surface: "web", browser: "available", risk: "high" })
    writeFileSync(path, raw)
    const fromFile = cli(undefined, ["--facts", path], { cwd: directory })
    success(fromFile)
    assert.equal(fromFile.stdout, cli(raw).stdout)
    assert.equal(readFileSync(path, "utf8"), raw)
    assert.deepEqual(readdirSync(directory), ["facts with spaces.json"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const phase of ["inspect", "implement", "debug", "verify"]) {
  test(`ordinary ${phase} phase is preserved`, () => {
    assert.equal(route({ phase }).phase, phase)
  })
}

const phaseCases = [
  ["a bug outranks a design-oriented surface", { task: "bug", surface: "web" }, "debug", ["systematic-debugging", "webapp-testing"]],
  ["failure outranks design", { task: "design", phase: "implement", failure: true }, "debug", ["systematic-debugging"]],
  ["debug phase outranks design", { task: "design", phase: "debug" }, "debug", ["systematic-debugging"]],
  ["repaired bug can reach final verification", { task: "bug", phase: "finish" }, "verify", ["verification-before-completion"]],
  ["unresolved bug still outranks finish", { task: "bug", phase: "finish", failure: true }, "debug", ["systematic-debugging"]],
  ["failure outranks finish", { failure: true, phase: "finish" }, "debug", ["systematic-debugging"]],
  ["resumption outranks failure", { resumed: true, failure: true, phase: "implement" }, "recover", []],
  ["resumption outranks bug and repeated failures", { resumed: true, task: "bug", phase: "finish", failed_attempts: 2 }, "recover", []],
  ["resumption outranks design", { resumed: true, task: "design" }, "recover", []],
  ["non-failing design selects impeccable", { task: "design" }, "inspect", ["impeccable"]],
  ["design implementation retains risk-based TDD", { task: "design", phase: "implement" }, "implement", ["test-driven-development", "impeccable"]],
  ["design finish reserves verification instead of polish", { task: "design", phase: "finish" }, "verify", ["verification-before-completion"]],
  ["review selects code review", { task: "review" }, "inspect", ["code-review-excellence"]],
  ["review verification retains essential verification", { task: "review", phase: "verify" }, "verify", ["verification-before-completion", "code-review-excellence"]],
]
for (const [name, facts, phase, skills] of phaseCases) {
  test(name, () => {
    const result = route(facts)
    assert.equal(result.phase, phase)
    assert.deepEqual(result.skills, skills)
  })
}

test("recover holds all edits and points to session restoration, even with fresh evidence", () => {
  const result = route({ resumed: true, evidence: "fresh", failure: true })
  assert.deepEqual(result.holds, ["restore-state", "no-edits"])
  assert.deepEqual(result.references, ["references/reliability.md", "references/session-state.md"])
})

test("reference targets resolve to existing local documents relative to the skill", () => {
  const skillDirectory = new URL("../skills/auto-route/", import.meta.url)
  for (const reference of route({ resumed: true }).references) {
    assert.ok(statSync(new URL(reference, skillDirectory)).isFile())
  }
})

for (const facts of [
  { phase: "implement" }, { phase: "debug" }, { phase: "verify", surface: "web", browser: "available" },
  { task: "review" }, { task: "design" }, { resumed: true },
]) {
  test(`read-only constrains edits without disabling safe work: ${JSON.stringify(facts)}`, () => {
    const result = route({ ...facts, mode: "read-only" })
    assert.equal(result.mode, "read-only")
    assert.ok(result.holds.includes("no-edits"))
    assert.ok(!result.skills.includes("test-driven-development"))
    if (facts.phase === "debug") assert.ok(result.skills.includes("systematic-debugging"))
    if (facts.phase === "verify") assert.ok(result.skills.includes("verification-before-completion"))
    assert.match(result.message, /non-mutating investigation\/verification/)
  })
}

for (const risk of ["low", "normal", "high"]) {
  test(`implementation with ${risk} risk has proportional TDD`, () => {
    const result = route({ phase: "implement", risk })
    assert.deepEqual(result.skills, risk === "low" ? [] : ["test-driven-development"])
  })
}

for (const flags of [
  { risk: "high" }, { risk: "low", shared_change: true },
  { risk: "low", external_integration: true },
  { risk: "high", shared_change: true, external_integration: true },
]) {
  test(`raised regression requirements: ${JSON.stringify(flags)}`, () => {
    const result = route({ phase: "implement", ...flags })
    assert.equal(result.risk, flags.risk === "high" ? "high" : "normal")
    for (const tag of ["baseline", "acceptance", "preservation", "regression", "consider-independent-review"]) {
      assert.ok(result.checks.includes(tag), tag)
    }
    assert.equal(result.checks.includes("integration-contract"), Boolean(flags.external_integration))
    assert.ok(result.skills.includes("test-driven-development"))
  })
}

test("high-risk browser verification uses exactly three slots without dropping verification", () => {
  const result = route({ task: "design", phase: "finish", risk: "high", surface: "web", browser: "available" })
  assert.deepEqual(result.skills, ["verification-before-completion", "code-review-excellence", "playwright-cli"])
  assert.ok(result.checks.includes("consider-independent-review"))
})

for (const surface of ["web", "tui", "cli", "library", "none"]) {
  test(`${surface} has only its own runtime checks (TUI is not DOM)`, () => {
    const result = route({ phase: "verify", surface, browser: "available" })
    const runtime = { web: "browser-runtime", tui: "tui-runtime", cli: "cli-runtime" }[surface]
    assert.deepEqual(result.checks.filter((tag) => tag.endsWith("-runtime")), runtime ? [runtime] : [])
    assert.equal(result.skills.includes("playwright-cli"), surface === "web")
    assert.ok(!result.skills.includes("webapp-testing"))
  })
}

for (const phase of ["debug", "verify"]) {
  for (const browser of ["available", "unknown", "unavailable"]) {
    test(`${phase} with ${browser} browser never invents runtime availability`, () => {
      const result = route({ phase, browser, surface: "web", evidence: "fresh" })
      assert.ok(result.checks.includes("browser-runtime"))
      assert.equal(result.skills.includes("playwright-cli"), browser === "available")
      assert.equal(result.skills.includes("webapp-testing"), browser === "unknown")
      assert.equal(result.holds.includes("browser-unverified"), browser !== "available")
      assert.match(result.message, /not proof its executable exists/)
    })
  }
}

test("inspect and implement do not preload browser skills", () => {
  for (const phase of ["inspect", "implement"]) {
    const result = route({ phase, surface: "web", browser: "available" })
    assert.ok(!result.skills.includes("playwright-cli"))
    assert.ok(!result.skills.includes("webapp-testing"))
  }
})

for (const evidence of ["missing", "stale", "fresh"]) {
  test(`finish with ${evidence} evidence routes to verification, never completion`, () => {
    const result = route({ phase: "finish", evidence })
    assert.equal(result.phase, "verify")
    assert.deepEqual(result.holds, evidence === "fresh" ? [] : [`evidence-${evidence}`])
    assert.deepEqual(result.skills, ["verification-before-completion"])
    assert.equal(result.advisory, true)
    assert.match(result.message, /no completion certified/)
    assert.ok(!Object.hasOwn(result, "completed"))
  })
}

for (const failed_attempts of [0, 1, 2, 100]) {
  test(`${failed_attempts} debug attempts respects the two-attempt stop`, () => {
    const result = route({ task: "bug", failed_attempts })
    assert.equal(result.phase, "debug")
    assert.deepEqual(result.skills, ["systematic-debugging"])
    assert.ok(result.checks.includes("root-cause"))
    for (const hold of ["no-edits", "investigate-before-more-edits"]) {
      assert.equal(result.holds.includes(hold), failed_attempts >= 2)
    }
    assert.equal(result.checks.includes("consider-independent-review"), failed_attempts >= 2)
    if (failed_attempts >= 2) assert.match(result.message, /read-only root-cause investigation; escalate/)
  })
}

test("attempt count alone is not a natural-language failure inference", () => {
  const result = route({ phase: "implement", failed_attempts: 2 })
  assert.equal(result.phase, "implement")
  assert.ok(!result.holds.includes("investigate-before-more-edits"))
})

for (const facts of [
  {}, { task: "design" }, { task: "review", phase: "implement" },
  { task: "bug", failed_attempts: 2 },
  { phase: "finish", risk: "high", surface: "web", browser: "available", external_integration: true },
  { resumed: true, mode: "read-only", failure: true },
]) {
  test(`other domain never receives engineering skills: ${JSON.stringify(facts)}`, () => {
    const result = route({ ...facts, domain: "other" })
    assert.deepEqual(result.skills, [])
    assert.ok(!result.checks.some((tag) => tag.endsWith("-runtime") || tag === "integration-contract"))
    assert.ok(!result.references.includes("references/reliability.md"))
    if (facts.phase === "finish") assert.equal(result.phase, "verify")
    if (facts.resumed) assert.ok(result.holds.includes("restore-state"))
  })
}

test("fact property order cannot change output or route order", () => {
  const facts = { phase: "verify", risk: "high", surface: "web", shared_change: true, browser: "unknown", evidence: "stale" }
  const reversed = Object.fromEntries(Object.entries(facts).reverse())
  assert.equal(cli(JSON.stringify(facts)).stdout, cli(JSON.stringify(reversed)).stdout)
})

const enums = {
  domain: ["code", "other"], task: ["feature", "bug", "design", "review"],
  phase: ["inspect", "implement", "debug", "verify", "finish"], mode: ["act", "read-only"],
  surface: ["web", "tui", "cli", "library", "none"], risk: ["low", "normal", "high"],
  evidence: ["missing", "stale", "fresh"], browser: ["available", "unavailable", "unknown"],
}
for (const [key, values] of Object.entries(enums)) {
  test(`${key}: all enum members accepted and non-members/types rejected`, () => {
    for (const value of values) route({ [key]: value })
    for (const value of [SECRET, "", values[0].toUpperCase(), null, false, true, 0, 1, [], {}]) {
      rejected(cli(JSON.stringify({ [key]: value })), `invalid fact: ${key}`)
    }
  })
}

for (const key of ["failure", "resumed", "shared_change", "external_integration"]) {
  test(`${key}: only actual booleans accepted`, () => {
    for (const value of [true, false]) route({ [key]: value })
    for (const value of [0, 1, "true", "false", null, [], {}]) {
      rejected(cli(JSON.stringify({ [key]: value })), `invalid fact: ${key}`)
    }
  })
}

test("failed_attempts rejects booleans, fractional/float encodings and out-of-range integers", () => {
  for (const raw of ["true", "false", "null", '"2"', "[]", "{}", "-1", "101", "1.5", "0.0", "2e0", "1e400", "9".repeat(5000)]) {
    rejected(cli(`{"failed_attempts":${raw}}`))
  }
})

let invalidCase = 1
for (const raw of [
  "", " ", "{", '{"task":"feature",}', '{} {}', `{"task":${SECRET}}`,
  `{"${SECRET}":true}`, `{"task":"feature","${SECRET}":1}`,
  'null', '[]', '"feature"', 'true', '1',
  '{"risk":"normal","risk":"high"}', '{"risk":"normal","r\\u0069sk":"low"}',
  '{"failure":NaN}', '{"failed_attempts":Infinity}', '{"failed_attempts":-Infinity}',
  '{"phase":"recover"}', '{"model":"secret-that-must-not-be-echoed"}',
  '{"provider":"secret-that-must-not-be-echoed"}', '{"__proto__":{}}',
  "[".repeat(2000) + "0" + "]".repeat(2000),
  '\uFEFF{}', Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
]) {
  // Numbered labels avoid dumping adversarial raw payloads in test logs.
  test(`malformed/unknown facts are rejected safely (case ${invalidCase++})`, () => {
    rejected(cli(raw))
  })
}

test("stdin accepts exactly 64 KiB and rejects one byte more before parsing", () => {
  const exact = "{}" + " ".repeat(MAX_BYTES - 2)
  success(cli(exact))
  rejected(cli(exact + " "), "facts exceed 64 KiB")
  rejected(cli("x".repeat(MAX_BYTES + 1)), "facts exceed 64 KiB")
  const multibyte = `{"${SECRET}":"${"é".repeat(MAX_BYTES / 2)}"}`
  assert.ok(multibyte.length < MAX_BYTES)
  assert.ok(Buffer.byteLength(multibyte) > MAX_BYTES)
  rejected(cli(multibyte), "facts exceed 64 KiB")
})

test("file input enforces the same byte limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "auto-route-limit-"))
  const path = join(directory, "facts.json")
  try {
    writeFileSync(path, "{}" + " ".repeat(MAX_BYTES - 2))
    success(cli(undefined, ["--facts", path]))
    writeFileSync(path, "{}" + " ".repeat(MAX_BYTES - 1))
    rejected(cli(undefined, ["--facts", path]), "facts exceed 64 KiB")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const args of [
  [], ["--facts"], [SECRET], ["--help"], ["--fac", "-"], ["--facts=-"],
  ["--facts", "-", SECRET], ["--facts", "-", "--facts", "-"],
  ["--facts", "-", "--model", SECRET], ["--facts", "-", "--provider", SECRET],
]) {
  test(`strict CLI arguments reject extras without echoing (case ${invalidCase++})`, () => {
    rejected(cli("{}", args), "usage: route.py --facts JSON_FILE (or - for stdin)")
  })
}

test("unreadable file and directory errors do not expose paths or secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "auto-route-unreadable-"))
  try {
    for (const path of [directory, join(directory, SECRET)]) {
      const child = cli(undefined, ["--facts", path])
      rejected(child, "cannot read facts")
      assert.ok(!child.stderr.includes(directory))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("import has no CLI side effects and policy calculation performs no I/O or imports", () => {
  // Import using stdlib runpy, then audit the actual parser/router, not source
  // strings. This is not an OS sandbox or proof against a hostile Python setup.
  const probe = `
import runpy
import sys
module = runpy.run_path(sys.argv[1], run_name="policy_import_test")
def deny_io(event, args):
    if event == "open" or event == "import" or event.startswith(("socket.", "subprocess.", "os.")):
        raise RuntimeError("unexpected policy side effect")
sys.addaudithook(deny_io)
for raw in (
    b'{}',
    b'{"phase":"finish","risk":"high","surface":"web","browser":"available"}',
    b'{"resumed":true,"failure":true}',
    b'{"task":"bug","failed_attempts":2,"mode":"read-only"}',
):
    result = module["route"](module["parse_facts"](raw))
    assert result["advisory"] is True
print("policy-only")
`
  const child = python(["-B", "-c", probe, script, "--facts", SECRET], "not JSON")
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, "")
  assert.equal(child.stdout, "policy-only\n")
})

test("behavioral sequence returns from debugging to verification without certifying completion", () => {
  const plan = route({ task: "design", phase: "implement", surface: "web" })
  assert.ok(plan.skills.includes("impeccable"))
  const failure = route({ task: "design", phase: "implement", surface: "web", failure: true })
  assert.equal(failure.phase, "debug")
  assert.ok(!failure.skills.includes("impeccable"))
  for (const phase of ["verify", "finish"]) {
    const repaired = route({ task: "bug", phase, failed_attempts: 2, evidence: "fresh" })
    assert.equal(repaired.phase, "verify")
    assert.equal(repaired.skills[0], "verification-before-completion")
    assert.equal(repaired.advisory, true)
    assert.equal(route({ task: "bug", phase, failure: true }).phase, "debug")
  }
})

test("new discriminating evidence releases guesswork hold but never authorization or recovery", () => {
  const facts = { task: "bug", failed_attempts: 3, new_evidence: true, evidence: "fresh" }
  assert.ok(!route(facts).holds.includes("no-edits"))
  assert.ok(!route(facts).holds.includes("investigate-before-more-edits"))
  assert.ok(route({ ...facts, new_evidence: false }).holds.includes("investigate-before-more-edits"))
  assert.ok(route({ ...facts, mode: "read-only" }).holds.includes("no-edits"))
  assert.ok(route({ ...facts, resumed: true }).holds.includes("no-edits"))
  rejected(cli('{"new_evidence":"yes"}'), "invalid fact: new_evidence")
})

test("non-code facts never acquire engineering gates even with risk and integration flags", () => {
  const result = route({ domain: "other", risk: "high", shared_change: true, external_integration: true, task: "bug", failed_attempts: 5, failure: true })
  assert.deepEqual(result.skills, [])
  assert.deepEqual(result.checks, ["baseline", "acceptance"])
  assert.ok(!result.holds.includes("investigate-before-more-edits"))
})

test("normal-risk additions retain preservation checks without forcing independent agents", () => {
  const result = route({ phase: "implement" })
  assert.ok(result.checks.includes("preservation"))
  assert.ok(!result.checks.includes("consider-independent-review"))
  assert.ok(route({ shared_change: true }).checks.includes("consider-independent-review"))
})