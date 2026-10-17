export const deepDeliberation = `[Deep deliberation]
For substantive tasks, deliberate before the first state-changing action: restate goal and constraints, enumerate at least three approaches with tradeoffs, name what must keep working and likely failure modes, then commit to the smallest change that fully delivers the goal and to verifying it the way the user will use it. Prefer evidence over assumption. This outranks speed heuristics; final replies stay concise. These instructions never grant tool access and never change permission rules.`;

// mods/infiniteoc writes packages/core/src/infiniteoc/guidance.ts with this extension marker.
const marker = "// infiniteoc:guidance-extensions";

export default {
  id: "deep-deliberation",
  version: "2.0.0",
  async setup(api) {
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      if (typeof source !== "string") throw new Error("deep-deliberation: invalid source");
      if (source.includes("[Deep deliberation]")) throw new Error("deep-deliberation: already applied; refusing to duplicate");
      if (source.split(marker).length !== 2) throw new Error("deep-deliberation: expected one source anchor: InfiniteOC guidance marker");
      return source.replace(marker, () => `infiniteocGuidance.build.push(${JSON.stringify(deepDeliberation)})\n${marker}`);
    });
  },
};
