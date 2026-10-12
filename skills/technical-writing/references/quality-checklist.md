# Documentation Quality Checklist

A systematic evaluation framework for technical documentation, based on IBM's nine quality characteristics from *Developing Quality Technical Information* and supplemented with criteria from the Google Developer Documentation Style Guide, the Microsoft Writing Style Guide, and docs-as-code best practices.

Use this checklist when reviewing documentation. For each characteristic, rate as **Pass**, **Needs Work**, or **Fail**, and provide specific, actionable feedback.

---

## 1. Task Orientation

The documentation helps the reader accomplish real tasks.

### Criteria

- [ ] Instructions are organised around tasks the reader actually performs, not around product features or system architecture
- [ ] Each procedural topic answers a clear "How do I...?" question
- [ ] Steps are in the correct order and no steps are missing
- [ ] Prerequisites are stated before the first step, not discovered mid-procedure
- [ ] The reader can identify what to do, how to do it, and how to verify it worked
- [ ] Conceptual information supports task completion rather than existing for its own sake
- [ ] The scope of each topic matches a single, coherent task

### Common Problems

| Problem | Fix |
|---------|-----|
| Feature-oriented structure ("The Settings Panel") | Reorganise around tasks ("How to configure authentication") |
| Instructions embedded in paragraphs of explanation | Extract steps into numbered lists; move explanation before or after |
| Missing verification step | Add "You should see..." or "Verify by running..." after critical steps |
| Mixed audience in one topic | Split into separate topics for different roles or skill levels |

---

## 2. Accuracy

The information is correct and up to date.

### Criteria

- [ ] All technical facts (commands, APIs, configuration options, UI labels) are verified against the current version of the product
- [ ] Code examples compile/run without errors and produce the documented output
- [ ] Screenshots match the current UI
- [ ] Links resolve to the correct destination
- [ ] Version numbers, dates, and other time-sensitive information are current
- [ ] No contradictions between different parts of the documentation
- [ ] Edge cases and limitations are documented honestly

### Common Problems

| Problem | Fix |
|---------|-----|
| Code example doesn't work | Test every code example in a clean environment; automate testing where possible |
| Documentation describes old version | Review at every release; tag docs with product version |
| Screenshot shows outdated UI | Regenerate screenshots from current version; consider using text descriptions for rapidly changing UIs |
| Broken links | Run link checker (`markdown-link-check`, `lychee`) in CI |

---

## 3. Completeness

The documentation covers what the reader needs — no more, no less.

### Criteria

- [ ] All parameters, options, and configuration values are documented (for reference docs)
- [ ] Error messages and their resolutions are covered
- [ ] Common use cases are addressed with examples
- [ ] Edge cases and limitations are noted
- [ ] The documentation doesn't include unnecessary information that obscures what the reader needs
- [ ] "What's next" links guide the reader to related content
- [ ] The documentation acknowledges what it doesn't cover and points elsewhere

### Common Problems

| Problem | Fix |
|---------|-----|
| Undocumented parameters or options | Audit against source code or API spec; auto-generate reference docs from code where possible |
| Too much detail for the reader's level | Use progressive disclosure — basic info first, advanced details in expandable sections or linked pages |
| Missing error handling guidance | Document every error the reader might encounter, organised by symptom |
| Scope creep (trying to cover everything) | Define the topic's scope in the first sentence; link to related topics |

---

## 4. Clarity

The reader can understand the information on first reading.

### Criteria

- [ ] Sentences average 15–25 words; no sentence exceeds 40 words
- [ ] Active voice is used for instructions; passive is used only when the actor is irrelevant
- [ ] Technical terms are defined on first use
- [ ] Pronouns have clear antecedents (no ambiguous "it," "this," or "they")
- [ ] Instructions use imperative mood ("Click **Save**" not "You should click Save")
- [ ] Conditions precede actions ("If X, do Y" not "Do Y if X")
- [ ] Negatives are minimised ("Use version 3.0 or later" not "Do not use versions earlier than 3.0")
- [ ] Lists are parallel in structure (all items follow the same grammatical pattern)

### Common Problems

| Problem | Fix |
|---------|-----|
| Long, complex sentences | Split into two sentences; one idea per sentence |
| Undefined jargon | Add inline definition on first use, or link to a glossary |
| Ambiguous pronouns | Replace "it" or "this" with the specific noun |
| Passive instructions | Rewrite: "The file should be saved" → "Save the file" |

---

## 5. Concreteness

The documentation uses specific examples rather than abstractions.

### Criteria

- [ ] Every non-trivial concept or instruction is illustrated with a concrete example
- [ ] Code examples use realistic values (not `foo`, `bar`, `xxx`)
- [ ] Examples show expected output or results
- [ ] Abstract descriptions are accompanied by specific instances
- [ ] Diagrams illustrate complex systems, data flows, or architectures
- [ ] Tables present structured data (parameters, options, comparisons) rather than prose

### Common Problems

| Problem | Fix |
|---------|-----|
| Instruction without example | Add a code block, screenshot, or concrete scenario |
| Placeholder values (`foo`, `xxx`) | Use realistic values (`user@example.com`, `api.acme.com`) |
| No expected output shown | Add "Output:" or "You should see:" after commands |
| Abstract explanation without grounding | Add "For example, ..." with a specific scenario |

---

## 6. Organisation

The reader can find and follow the information.

### Criteria

- [ ] The document type is clear (tutorial, how-to, reference, explanation) and doesn't mix types
- [ ] Headings form a logical hierarchy (H1 → H2 → H3; no skipped levels)
- [ ] The table of contents accurately reflects the document's structure
- [ ] Related information is grouped together; unrelated information is in separate topics
- [ ] The most important or most common information comes first
- [ ] Transitions between sections are logical and explicit
- [ ] The document follows a consistent structure across similar topics

### Common Problems

| Problem | Fix |
|---------|-----|
| Mixed document types (tutorial steps mixed with reference tables) | Separate into distinct documents by type |
| No clear hierarchy (flat list of H2s) | Restructure with H2 sections and H3 subsections that reflect logical grouping |
| Burying critical information | Move the most important content to the top; use admonitions for critical warnings |
| Inconsistent structure across similar pages | Create a template; apply it to all pages of the same type |

---

## 7. Retrievability

The reader can locate the specific piece of information they need.

### Criteria

- [ ] Page titles accurately describe the content and are search-friendly
- [ ] Headings are descriptive enough to be useful in a table of contents or search result
- [ ] The documentation supports search (full-text search on docs site; keywords in headings)
- [ ] Navigation (sidebar, breadcrumbs, next/prev links) helps the reader orient themselves
- [ ] Cross-references and "See also" links connect related topics
- [ ] Frequently needed information (e.g., config reference) is reachable in ≤2 clicks from the home page
- [ ] Index entries or tags exist for key topics (where the format supports them)

### Common Problems

| Problem | Fix |
|---------|-----|
| Generic page titles ("Configuration") | Use specific titles ("Database Configuration Options") |
| No cross-references | Add "See also" links to related topics |
| Poor search results | Ensure headings contain the terms readers search for |
| Deep nesting (5+ clicks to find content) | Flatten navigation; add shortcuts to frequently accessed pages |

---

## 8. Style

The prose is clean, consistent, and professional.

### Criteria

- [ ] Second person ("you") is used for instructions
- [ ] Present tense is used ("The command creates..." not "The command will create...")
- [ ] Tone is direct and helpful, not condescending or overly casual
- [ ] Terminology is consistent throughout (the same concept uses the same term everywhere)
- [ ] Formatting conventions are applied consistently (bold for UI, code font for code, etc.)
- [ ] No unnecessary hedging ("simply," "just," "easy") — these words frustrate readers when things aren't simple
- [ ] Gender-neutral and inclusive language is used throughout
- [ ] Abbreviations are expanded on first use

### Common Problems

| Problem | Fix |
|---------|-----|
| Inconsistent terminology (switching between "server," "instance," "node") | Pick one term and use it consistently; add a glossary if needed |
| Hedging words ("simply run the command") | Remove "simply" — if it's simple, the reader will see that; if it's not, the word is condescending |
| First person ("I recommend") or third person ("the user should") | Rewrite in second person ("you") |
| Inconsistent formatting (sometimes bold for UI, sometimes quotes) | Define and apply a formatting convention |

---

## 9. Visual Effectiveness

Formatting, diagrams, and layout aid comprehension.

### Criteria

- [ ] Code blocks use syntax highlighting appropriate to the language
- [ ] Long code blocks have relevant lines highlighted or annotated
- [ ] Tables are used for structured data (not prose paragraphs describing options)
- [ ] Diagrams are used for system architecture, data flows, and complex relationships
- [ ] Admonitions (notes, warnings, tips) are used sparingly and reserved for genuinely important callouts
- [ ] White space, headings, and list formatting create visual hierarchy
- [ ] Images have alt text for accessibility
- [ ] The document renders correctly in all target formats (web, PDF, mobile)

### Common Problems

| Problem | Fix |
|---------|-----|
| Wall of text with no visual breaks | Add headings, lists, code blocks, and tables |
| Overuse of admonitions (everything is a "note") | Reserve admonitions for genuinely important callouts; integrate routine information into the main text |
| Missing diagrams for complex systems | Add architecture or flow diagrams; use Mermaid, PlantUML, or draw.io |
| Code without syntax highlighting | Specify the language in fenced code blocks (` ```python `) |

---

## 10. Technical Accuracy (Additional)

Beyond IBM's nine, these criteria address technical documentation specifically:

- [ ] All URLs, endpoints, and file paths are correct and tested
- [ ] Environment-specific instructions note which OS/platform they apply to
- [ ] Version dependencies are explicit ("Requires Node.js 18 or later")
- [ ] Security implications are noted where relevant (e.g., "This grants admin access")
- [ ] Performance implications are noted where relevant
- [ ] Deprecated features are clearly marked with migration guidance

---

## 11. Accessibility (Additional)

- [ ] Images have descriptive alt text
- [ ] Colour is not the sole means of conveying information
- [ ] Tables have header rows and are not used for layout
- [ ] Heading hierarchy is logical (no skipped levels)
- [ ] Links have descriptive text ("See the configuration reference" not "click here")
- [ ] Code examples are in text (not images of code)

---

## Summary Scorecard

Use this to produce a quick summary after a full review:

| Characteristic | Rating | Key Finding |
|---|---|---|
| Task Orientation | Pass / Needs Work / Fail | |
| Accuracy | Pass / Needs Work / Fail | |
| Completeness | Pass / Needs Work / Fail | |
| Clarity | Pass / Needs Work / Fail | |
| Concreteness | Pass / Needs Work / Fail | |
| Organisation | Pass / Needs Work / Fail | |
| Retrievability | Pass / Needs Work / Fail | |
| Style | Pass / Needs Work / Fail | |
| Visual Effectiveness | Pass / Needs Work / Fail | |
| Technical Accuracy | Pass / Needs Work / Fail | |
| Accessibility | Pass / Needs Work / Fail | |

**Overall Assessment:** [Summary paragraph with top 3 priorities for improvement.]
