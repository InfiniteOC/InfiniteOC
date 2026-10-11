import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMods } from "../../src/mod-loader.mjs";
import mod, { deepDeliberation } from "./index.mjs";

const TARGET = "packages/core/src/infiniteoc/guidance.ts";
const marker = "// infiniteoc:guidance-extensions";
const guidance = `export const infiniteocGuidance: Record<string, string[]> = { "build": ["[InfiniteOC unified workflow]"] }\n${marker}\n`;

async function tree(t, content) {
  const root = await mkdtemp(join(tmpdir(), "deep-deliberation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/core/src/infiniteoc"), { recursive: true });
  await writeFile(join(root, TARGET), content);
  return root;
}

test("appends deep deliberation to the build guidance and keeps the extension marker", async (t) => {
  const root = await tree(t, guidance);
  const result = await applyMods([mod], root);
  assert.deepEqual(result.changes, [{ mod: "deep-deliberation", path: TARGET, action: "patch" }]);
  const after = await readFile(join(root, TARGET), "utf8");
  assert.ok(after.includes(`infiniteocGuidance.build.push(${JSON.stringify(deepDeliberation)})`));
  assert.equal(after.split(marker).length, 2);
  // The generated module still evaluates and yields both guidance parts in order.
  const code = after.replace(": Record<string, string[]>", "");
  const value = new Function(`${code.replace("export const", "const")}; return infiniteocGuidance`)();
  assert.deepEqual(value.build, ["[InfiniteOC unified workflow]", deepDeliberation]);
});

test("fails closed on a missing or duplicated marker and on repeated application", async (t) => {
  await assert.rejects(applyMods([mod], await tree(t, "unrelated source\n")), /expected one source anchor/);
  await assert.rejects(applyMods([mod], await tree(t, `${marker}\n${marker}\n`)), /expected one source anchor/);
  const root = await tree(t, guidance);
  await applyMods([mod], root);
  await assert.rejects(applyMods([mod], root), /already applied/);
});

test("deliberation text stays bounded and grants nothing", () => {
  assert.ok(deepDeliberation.startsWith("[Deep deliberation]"));
  assert.ok(deepDeliberation.length < 800);
  assert.ok(deepDeliberation.includes("never grant tool access"));
  assert.ok(deepDeliberation.includes("final replies stay concise"));
  assert.doesNotMatch(deepDeliberation, /permission.*allow|effect.*allow|apiKey|secret/i);
});
