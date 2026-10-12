import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import mod, { reaGuidance, REA_PACKAGE } from "./index.mjs";

const modDir = import.meta.dirname;
const marker = "// infiniteoc:guidance-extensions";
const baseGuidance = `export const infiniteocGuidance: Record<string, string[]> = {"build": []}\n${marker}\n`;

function stubApi(files, commands) {
  return {
    root: "/tmp/rea-test",
    options: {},
    tui: { command: (input) => commands.push(input) },
    on() {},
    async patch(file, transform) {
      const before = files.get(file) ?? baseGuidance;
      files.set(file, await transform(before));
    },
    async write() {},
  };
}

test("guidance names the pinned package and safe setup flow", () => {
  for (const phrase of [
    "rea-agents@4.0.1",
    "doctor --client opencode --json",
    "setup --client opencode --dry-run --json",
    "obtain approval",
    "never add --install-hopper",
    "analyze-javascript-application",
    "observations/inferences/unknowns",
    "reverse-engineer-anything",
  ]) {
    assert.ok(reaGuidance.includes(phrase), `Missing guidance phrase: ${phrase}`);
  }
  assert.ok(!reaGuidance.includes("/home/rize/rea"), "Guidance must not point at the local checkout");
  assert.equal(REA_PACKAGE, "rea-agents@4.0.1");
});

test("command is read-only and version-pinned", async () => {
  const source = await readFile(path.join(modDir, "command.tsx"), "utf8");
  assert.match(source, /export\s+async\s+function\s+run\s*\(/);
  assert.ok(source.includes(REA_PACKAGE), "Command must use the pinned package");
  assert.ok(!source.includes("/home/rize/rea"), "Command must not reference the local checkout path");
  assert.ok(!source.includes("REA_SOURCE") || !source.includes("/home"), "No local path wiring");
  for (const token of ["child_process", "spawn(", "execSync", "writeFile", "writeFileSync"]) {
    assert.ok(!source.includes(token), `Command must stay read-only (found ${token})`);
  }
  assert.ok(source.includes("--yes"), "Setup text should show the approved apply step");
  assert.match(source, /ctx\.ui\.select/);
  assert.match(source, /ctx\.ui\.alert/);
});

test("registers /rea and patches guidance once, fails closed", async () => {
  const files = new Map();
  const commands = [];
  await mod.setup(stubApi(files, commands));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].slash, "rea");
  assert.match(commands[0].source, /export async function run\(/);
  const patched = files.get("packages/core/src/infiniteoc/guidance.ts");
  assert.ok(patched.includes("[REA reverse engineering]"), "Guidance not applied");
  assert.ok(patched.includes(marker), "Marker must be preserved");
  await assert.rejects(mod.setup(stubApi(files, [])), /already applied/);
});

test("missing guidance marker fails closed", async () => {
  const commands = [];
  const api = {
    root: "/tmp/rea-test",
    options: {},
    tui: { command: (input) => commands.push(input) },
    on() {},
    async patch(file, transform) {
      await transform("no marker here");
    },
    async write() {},
  };
  await assert.rejects(mod.setup(api), /anchor|marker/);
});

test("README documents approval flow and untouched repo", async () => {
  const readme = await readFile(path.join(modDir, "README.md"), "utf8");
  for (const phrase of ["dry-run", "approval", "untouched", "rea-agents@4.0.1", "feature check rea", "feature disable rea"]) {
    assert.ok(readme.toLowerCase().includes(phrase.toLowerCase()), `README missing: ${phrase}`);
  }
});
