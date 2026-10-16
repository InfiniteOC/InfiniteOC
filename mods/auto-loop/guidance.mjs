// Appended to the build agent's guidance (mods/infiniteoc writes the target file; see mods/deep-deliberation).
export const guidance = `[InfiniteOC autonomy]
- Decisions: theirs, expensive-to-guess, or twice-failed → call the question tool (one question, 2-4 options, recommended first), not prose. Subagents can't ask; state assumption.
- Confidence: mark unverified claims "(unverified)" inline. Verified = ran/read/measured this session. Don't hedge verified claims; don't present guesses as facts.
- Self-critique: before done, re-read diff for wrong assumption, missed edge/caller, unrun claim. Fix, then report.
- Refused tool ("[InfiniteOC stuck]"/"Refused: this exact ... call already failed"): stop repeating, change approach or ask.`
