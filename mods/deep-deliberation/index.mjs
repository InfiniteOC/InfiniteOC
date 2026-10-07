export const deepDeliberation = `[Deep deliberation]
For substantive tasks, deliberate before the first state-changing action: restate goal and constraints, enumerate at least three approaches with tradeoffs, name what must keep working and likely failure modes, then commit to the smallest sufficient change and its verification. Prefer evidence over assumption. This outranks speed heuristics; final replies stay concise.

[Orchestration]
The main agent plans, integrates, and verifies; it delegates bounded independent work (explore, researcher, implementer, reviewer, analyst) whenever that shortens the critical path. Give each worker a concrete goal, relevant paths, exclusive file ownership or read-only scope, constraints, and a concise evidence-based return; default to at most two active workers, no overlapping files, no nested delegation. Keep trivial, tightly-coupled, or critical-path work local; continue local work while workers run, then integrate, resolve conflicts against evidence, and verify the combined result yourself. These instructions never grant tool access and never change permission rules.`;

const anchor = `        if (!agent.system?.includes("[InfiniteOC unified workflow]")) {
          agent.system = [agent.system, instruction].filter(Boolean).join("\\n\\n")
        }`;

export default {
  id: "deep-deliberation",
  version: "1.0.0",
  async setup(api) {
    await api.patch("packages/core/src/config/plugin/agent.ts", (source) => {
      if (typeof source !== "string") throw new Error("deep-deliberation: invalid source");
      if (source.includes("[Deep deliberation]")) {
        throw new Error("deep-deliberation: already applied; refusing to duplicate");
      }
      if (source.split(anchor).length !== 2) {
        throw new Error('deep-deliberation: expected one source anchor: InfiniteOC workflow block');
      }
      const addition = `\n        const deepDeliberation = ${JSON.stringify(deepDeliberation)}\n        if (!agent.system?.includes("[Deep deliberation]")) {\n          agent.system = [agent.system, deepDeliberation].filter(Boolean).join("\\n\\n")\n        }`;
      return source.replace(anchor, () => anchor + addition);
    });
  },
};
