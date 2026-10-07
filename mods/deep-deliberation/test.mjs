import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMods } from "../../src/mod-loader.mjs";
import mod, { deepDeliberation, } from "./index.mjs";

const TARGET = "packages/core/src/config/plugin/agent.ts";

function postInfiniteocSource() {
  return `      // InfiniteOC finalizes presentation after config; never change permission rules.
      const build = editor.get(Agent.defaultID)
      if (build) editor.update(Agent.defaultID, (agent) => {
        agent.name = Agent.Name.make("InfiniteOC")
        agent.permissions.push(...permissions)
        if (!agent.system?.includes("[InfiniteOC unified workflow]")) {
          agent.system = [agent.system, instruction].filter(Boolean).join("\\n\\n")
        }
      })
`;
}

test("appends deep deliberation after the InfiniteOC workflow block", async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-deliberation-"));
  try {
    // Use the real loader with a minimal tree containing only the target file.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "packages/core/src/config/plugin"), { recursive: true });
    const before = postInfiniteocSource();
    await writeFile(join(root, TARGET), before);
    const result = await applyMods([mod], root);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].mod, "deep-deliberation");
    const after = await readFile(join(root, TARGET), "utf8");
    assert.ok(after.includes("[Deep deliberation]"));
    assert.ok(after.includes("at least three approaches"));
    assert.ok(after.includes("[Orchestration]"));
    assert.ok(after.includes("exclusive file ownership"));
    assert.ok(after.includes("at most two active workers"));
    assert.ok(after.includes("verify the combined result"));
    assert.ok(after.includes("never change permission rules"));
    assert.ok(after.includes('agent.permissions.push(...permissions)'));
    // Permission line preserved exactly once.
    assert.equal(after.split("agent.permissions.push(...permissions)").length - 1, 1);
    // Marker guard present so runtime re-application is idempotent.
    assert.ok(after.includes('includes("[Deep deliberation]")'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on missing anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-deliberation-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "packages/core/src/config/plugin"), { recursive: true });
    await writeFile(join(root, TARGET), "unrelated source\n");
    await assert.rejects(applyMods([mod], root), /expected one source anchor/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on duplicate anchor and on repeated application", async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-deliberation-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "packages/core/src/config/plugin"), { recursive: true });
    const anchor = `        if (!agent.system?.includes("[InfiniteOC unified workflow]")) {
          agent.system = [agent.system, instruction].filter(Boolean).join("\\n\\n")
        }`;
    await writeFile(join(root, TARGET), `${anchor}\n${anchor}\n`);
    await assert.rejects(applyMods([mod], root), /expected one source anchor/);
    await writeFile(join(root, TARGET), postInfiniteocSource());
    await applyMods([mod], root);
    await assert.rejects(applyMods([mod], root), /already applied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deliberation text stays bounded and grants nothing", async () => {
  assert.ok(deepDeliberation.startsWith("[Deep deliberation]"));
  assert.ok(deepDeliberation.length < 1200);
  assert.ok(deepDeliberation.includes("never grant tool access"));
  assert.ok(deepDeliberation.includes("final replies stay concise"));
  assert.doesNotMatch(deepDeliberation, /permission.*allow|effect.*allow|apiKey|secret/i);
});
