---
name: technical-writing
description: Expert guidance and automation for writing, structuring, reviewing, and
  publishing technical documentation. Covers topic-based authoring, information architecture,
  audience analysis, document types (tutorials, how-to guides, reference docs, explanations,
  API docs, READMEs, runbooks, release notes), prose style for technical clarity,
  documentation quality evaluation, and multi-format publishing (Markdown, HTML, PDF,
  EPUB, man pages, slide decks). Includes automation scripts for publishing via Pandoc
  and static site generators (MkDocs, Docusaurus, Sphinx). Synthesises techniques
  from IBM's Developing Quality Technical Information, the Google Developer Documentation
  Style Guide, the Microsoft Writing Style Guide, Mark Baker (Every Page is Page One),
  John Carroll (minimalism), Strunk & White, and the docs-as-code movement. Use this
  skill whenever the user is writing, editing, reviewing, structuring, or publishing
  any technical documentation — API docs, user guides, tutorials, READMEs, internal
  runbooks, knowledge bases, release notes, architecture decision records, or any
  prose whose purpose is to help someone understand or use a technical system. Also
  use when the user asks about documentation structure, topic types, style for technical
  writing, docs-as-code, or needs to convert/publish docs to HTML, PDF, EPUB, or other
  formats, even if they don't explicitly say "technical writing."
metadata:
  opencode/autoinvoke: false
---

This skill guides the writing, structuring, reviewing, and publishing of technical documentation. It provides specific, practical technique drawn from the strongest traditions in technical communication, combined with automation for multi-format publishing.

The user may be doing one of several things:

1. **Writing** — drafting technical documentation from scratch
2. **Structuring** — organising information architecture, choosing document types, planning a docs site
3. **Reviewing** — evaluating existing documentation for quality and completeness
4. **Publishing** — converting docs to HTML, PDF, EPUB, or deploying a documentation site
5. **Learning** — asking about technical writing principles, style, or tooling

Adapt your guidance to the task. For writing, be specific and generative. For reviewing, be rigorous against the quality characteristics. For publishing, provide working commands and configurations.

---

## Part I: Core Principles

Technical documentation exists to help someone accomplish a goal. Every decision — structure, style, level of detail, format — flows from the reader's needs and tasks. The following principles govern everything that follows.

### The Reader is Performing, Not Studying

The central insight of minimalist documentation (Carroll, *The Nurnberg Funnel*) is that readers of technical docs do not read linearly. They are trying to *do something* — install software, configure a system, debug an error, understand a concept so they can make a decision. They are impatient, goal-driven, and will abandon your documentation the moment it stops helping.

Design for this reality:
- **Get to the point.** Don't warm up. State what the document covers and who it's for in the first sentence.
- **Support scanning.** Use headings, lists, tables, and code blocks so readers can find what they need without reading every word.
- **Anchor in tasks.** Tie explanations to what the reader is trying to do. "To configure authentication, add the following to `config.yaml`:" is better than "The authentication subsystem supports several configuration options."
- **Support error recognition and recovery.** When something can go wrong, say what it looks like and how to fix it.

### Every Page is Page One (Baker)

Any page in your documentation might be the first page a reader sees — they arrive via search, a link from Stack Overflow, or a colleague's Slack message. Each topic must:
- **Be self-contained.** Provide enough context to be understandable without having read anything else.
- **Declare its purpose.** The reader should know within seconds what this page covers and whether it's what they need.
- **Link to related content.** Don't repeat everything — link to the prerequisite or reference page. But don't *require* the reader to follow the link to understand the current page.
- **Stay in scope.** One topic, one page. If you find yourself covering two distinct subjects, split into two pages.

### The Nine Quality Characteristics (IBM)

IBM's *Developing Quality Technical Information* identifies nine characteristics of high-quality technical documentation. Use these as your evaluation framework:

| Characteristic | Question it Answers |
|---|---|
| **Task Orientation** | Does it help the reader accomplish real tasks? |
| **Accuracy** | Is the information correct and up to date? |
| **Completeness** | Does it cover what the reader needs — no more, no less? |
| **Clarity** | Can the reader understand it on first reading? |
| **Concreteness** | Does it use specific examples rather than abstractions? |
| **Organisation** | Can the reader find and follow the information? |
| **Retrievability** | Can the reader locate the specific piece they need? |
| **Style** | Is the prose clean, consistent, and professional? |
| **Visual Effectiveness** | Do formatting, diagrams, and layout aid comprehension? |

When reviewing documentation, evaluate against all nine. When writing, keep all nine in mind — but prioritise task orientation, accuracy, and clarity.

---

## Part II: Document Types and Information Architecture

### The Four Document Types (Diátaxis)

The Diátaxis framework (Daniele Procida) identifies four types of documentation, each serving a different reader need. Mixing types in a single document is the most common structural mistake in technical writing.

**Tutorial** — *Learning-oriented*
- Teaches the reader by guiding them through a series of steps to complete a meaningful exercise.
- The reader is a beginner. They don't yet know what questions to ask.
- Structure: Numbered steps with concrete outcomes at each stage. Explain what the reader will build and why. Minimise explanation during the tutorial — link to explanations elsewhere.
- Tone: Encouraging, patient. "Now we'll set up the database" not "The database must be configured."
- Test: Can a beginner follow this from start to finish and succeed?

**How-To Guide** — *Task-oriented*
- Shows how to solve a specific problem or accomplish a specific task.
- The reader knows what they want to do but not how to do it.
- Structure: Problem statement → prerequisites → steps → result. Don't teach concepts — the reader already understands the basics.
- Tone: Direct, efficient. "To rotate TLS certificates: 1. Generate a new certificate..."
- Test: Can someone with basic knowledge follow this to solve their specific problem?

**Reference** — *Information-oriented*
- Describes the system's machinery — APIs, configuration options, CLI flags, data models.
- The reader knows what they're looking for and needs precise, complete, accurate information.
- Structure: Consistent, predictable layout. Every API endpoint documented the same way. Every config option in the same format. Alphabetical or logical ordering.
- Tone: Neutral, precise, complete. No narrative — just the facts.
- Test: Can a developer look up any specific item and find complete, accurate information?

**Explanation** — *Understanding-oriented*
- Provides background, context, rationale, and conceptual understanding.
- The reader wants to understand *why* — why the system is designed this way, how concepts relate, what the trade-offs are.
- Structure: Discursive. Can use analogies, comparisons, historical context. No steps.
- Tone: Reflective, informative. "The system uses eventual consistency because..."
- Test: Does the reader come away with a deeper understanding of the subject?

### Additional Document Types

Beyond the Diátaxis four, these specialised types are common in technical practice:

**API Reference** — A specific form of reference documentation. For REST APIs, document: endpoint, method, URL, parameters (path, query, body), request/response examples, status codes, authentication, rate limits. Use OpenAPI/Swagger as the source of truth where possible. Always include working code examples.

**README** — The front door of a project. Must answer in order: What is this? Why would I use it? How do I install it? How do I use it (quickstart)? Where do I find more? Keep it short — link to full docs.

**Runbook / Playbook** — Step-by-step operational procedures for incidents or routine tasks. Must be followable under stress at 3 AM. Short sentences. Numbered steps. Expected outputs at each step. What to do when something unexpected happens.

**Architecture Decision Record (ADR)** — Documents a significant design decision. Structure: Title, Status, Context, Decision, Consequences. Brief and immutable once accepted.

**Release Notes / Changelog** — What changed, why, and what the reader needs to do about it. Group by: breaking changes, new features, bug fixes, deprecations. Link to relevant docs.

**Troubleshooting Guide** — Organised by symptom, not by cause. Reader arrives with "I see error X" — they need to find it instantly. Structure: Symptom → Possible causes → Resolution for each cause.

### Information Architecture

When planning a documentation site or library:

1. **Audit existing content.** What exists? What's outdated? What's missing? What's duplicated?
2. **Map reader journeys.** What are the top 5 tasks readers come to your docs for? Build navigation around those.
3. **Separate the four types.** Tutorials, how-to guides, reference, and explanations should be in distinct sections — not intermixed.
4. **Design navigation for scanning.** Sidebar navigation should be scannable in 5 seconds. Use consistent naming. Group logically.
5. **Use progressive disclosure.** Surface the most common information first. Put advanced details in expandable sections, deeper pages, or appendices.
6. **Plan for findability.** Good search, good titles, good headings. A reader should be able to find any specific piece of information within 30 seconds.

---

## Part III: Style for Technical Writing

Good technical prose is invisible — the reader absorbs the information without noticing the writing. Bad technical prose creates friction: the reader re-reads sentences, misinterprets instructions, or gives up.

### Voice and Tone

**Use second person.** Address the reader as "you." ("You can configure the timeout by..." not "The timeout can be configured by the user...")

**Use active voice.** (Google, Microsoft, Strunk & White) Active voice is clearer, shorter, and more direct. "The server rejects the request" not "The request is rejected by the server." Use passive only when the actor is genuinely unknown or irrelevant.

**Use present tense.** "The command creates a directory" not "The command will create a directory." Present tense is simpler and more direct.

**Be direct.** Don't hedge unnecessarily. "This command deletes the file" not "This command should be able to delete the file."

**Be inclusive.** (Microsoft, Google) Avoid gendered language, ableist language, and culturally specific idioms. Write for a global audience.

### Sentence-Level Technique

**Keep sentences short.** Aim for 15–25 words on average. Break complex instructions into multiple sentences. One idea per sentence.

**Put conditions before instructions.** "If the file exists, delete it" not "Delete the file if it exists." The reader needs to check the condition *before* performing the action.

**Lead with the verb in instructions.** "Click **Save**" not "The Save button should be clicked." "Run `npm install`" not "You need to run `npm install`."

**Use parallel structure in lists.** Every item in a list should follow the same grammatical pattern. If the first item starts with a verb, all items start with verbs.

**Define terms on first use.** If you must use a technical term the reader may not know, define it the first time it appears — inline or in a parenthetical. Don't assume the reader shares your vocabulary.

**Avoid jargon inflation.** (Orwell) Don't use a technical term when a plain one will do. "Use" not "utilise." "Start" not "initialise" (unless the technical distinction matters). "Before" not "prior to."

### Code Examples

Code examples are the most-read part of most technical documentation. Treat them with the same care as production code.

- **Make examples complete and runnable.** A snippet the reader can't execute is frustrating. Include imports, setup, and context.
- **Show expected output.** After a command, show what the reader should see.
- **Use realistic values.** `user@example.com` not `foo`. `api.yourcompany.com` not `xxx`.
- **Highlight the important parts.** If only one line in a 20-line block matters, call it out.
- **Keep examples minimal.** Show the simplest case that illustrates the point. Don't combine multiple concepts in one example.
- **Test your examples.** Every code example in documentation should be tested. If it doesn't work, it's worse than no example at all.

### Formatting Conventions

- **Use bold for UI elements:** "Click **Settings** > **Advanced**."
- **Use code font for code:** file names (`config.yaml`), commands (`npm install`), variables (`PORT`), values (`true`), and any text the reader types literally.
- **Use admonitions sparingly:** Notes, warnings, and tips. Reserve warnings for actions that can cause data loss or security issues. Don't overuse — if everything is a note, nothing is.
- **Use tables for structured data.** Parameters, configuration options, comparison matrices. Tables are scannable; paragraphs aren't.
- **Use diagrams for systems.** Architecture, data flow, sequence diagrams. A good diagram replaces a thousand words. A bad diagram adds confusion. If you create a diagram, make sure it's accurate and current.

---

## Part IV: Documentation Review

When reviewing technical documentation — your own or someone else's — use the quality checklist in `references/quality-checklist.md`. It provides a systematic evaluation against all nine IBM quality characteristics plus additional criteria for technical accuracy, code quality, and accessibility.

### Quick Review Protocol

For a fast review pass, check these five things:

1. **Does it work?** Follow the instructions. Run the code examples. Click the links. If anything fails, the document fails.
2. **Can I find what I need?** Navigate to the document as a reader would (search, sidebar). Can you find the specific information you need within 30 seconds?
3. **Do I understand it on first reading?** Read each section once. If you have to re-read to understand, the writing needs improvement.
4. **Is it complete?** Are there steps missing? Edge cases unaddressed? Error conditions unexplained?
5. **Is it current?** Does it reflect the actual state of the system, API, or product?

### Deep Review Protocol

For a thorough review, work through `references/quality-checklist.md` systematically. For each quality characteristic, rate the document and provide specific, actionable feedback with line references.

---

## Part V: Publishing and Format Conversion

Technical documentation is only useful if it reaches the reader in a usable format. This section covers multi-format publishing — converting Markdown source into HTML, PDF, EPUB, man pages, slides, and deploying documentation sites.

The publishing automation guide in `references/publishing-guide.md` provides complete, working commands and configurations for every format. Read it when the user needs to publish or convert documentation.

### The Docs-as-Code Approach

The modern standard for technical documentation:

1. **Author in Markdown** (or MDX, reStructuredText, AsciiDoc). Plain text, version-controlled, diff-friendly.
2. **Store in Git.** Documentation lives alongside the code it describes, in the same repository.
3. **Review via pull requests.** Documentation changes are reviewed like code changes.
4. **Build automatically.** A CI/CD pipeline converts source to publishable formats on every merge.
5. **Deploy automatically.** The built site is deployed to hosting without manual intervention.

### Publishing Tool Selection

| Need | Tool | Why |
|------|------|-----|
| **Markdown → PDF, EPUB, HTML, LaTeX, slides, man pages** | **Pandoc** | The universal document converter. Handles nearly every format. |
| **Documentation site (Python ecosystem)** | **MkDocs + Material theme** | Simple setup, beautiful output, extensive plugin ecosystem. |
| **Documentation site (JS/React ecosystem)** | **Docusaurus** | MDX support, versioning, i18n, full React component support. |
| **Documentation site (Python/C/multi-language)** | **Sphinx** | Most powerful for API auto-docs, cross-referencing, and large doc sets. |
| **Hosted docs (minimal setup)** | **GitBook** | SaaS platform, no build pipeline needed, real-time collaboration. |
| **API documentation** | **Swagger UI / Redoc** | Generate interactive API docs from OpenAPI specs. |
| **Prose linting** | **Vale** | Enforce style guide rules automatically. Understands markup. |
| **Markdown linting** | **markdownlint** | Enforce consistent Markdown formatting. |

### Pandoc: The Universal Converter

Pandoc is the workhorse of documentation publishing. It converts between dozens of formats. The most common conversions for technical docs:

```bash
# Markdown → HTML (standalone, with table of contents and CSS)
pandoc input.md -s --toc -c style.css -o output.html

# Markdown → PDF (via LaTeX, with XeTeX for Unicode/font support)
pandoc input.md --pdf-engine=xelatex -o output.pdf

# Markdown → PDF (with table of contents, numbered sections)
pandoc input.md --pdf-engine=xelatex --toc -N -o output.pdf

# Markdown → EPUB (e-book)
pandoc input.md --toc -o output.epub

# Markdown → DOCX (Word)
pandoc input.md -o output.docx

# Markdown → man page
pandoc input.md -s -t man -o output.1

# Markdown → slide deck (reveal.js)
pandoc slides.md -t revealjs -s -o slides.html

# Markdown → slide deck (PDF via Beamer)
pandoc slides.md -t beamer -o slides.pdf

# Multiple files → single PDF (book-style)
pandoc front-matter.md chapter-01.md chapter-02.md appendix.md \
  --pdf-engine=xelatex --toc -N -o book.pdf
```

For detailed Pandoc configuration including custom templates, metadata, fonts, and styling, see `references/publishing-guide.md`.

### Static Site Generators

For publishing documentation as a website, use a static site generator. The publishing guide covers setup and configuration for each:

**MkDocs + Material** (recommended for most projects):
```bash
pip install mkdocs-material
mkdocs new my-docs && cd my-docs
mkdocs serve        # Local preview at http://localhost:8000
mkdocs build        # Build static site to ./site/
```

**Docusaurus** (for React/JS teams):
```bash
npx create-docusaurus@latest my-docs classic
cd my-docs && npm start   # Local preview at http://localhost:3000
npm run build             # Build static site to ./build/
```

**Sphinx** (for large, cross-referenced doc sets):
```bash
pip install sphinx sphinx-rtd-theme
sphinx-quickstart docs
cd docs && make html      # Build to _build/html/
```

### Documentation Linting

Automate style enforcement with Vale:

```bash
# Install Vale
brew install vale   # macOS
# or: choco install vale  # Windows

# Create .vale.ini in your docs root
cat > .vale.ini << 'EOF'
StylesPath = styles
MinAlertLevel = suggestion

Packages = Google, write-good

[*.md]
BasedOnStyles = Vale, Google, write-good
EOF

# Download style packages
vale sync

# Lint your docs
vale docs/
```

Vale can enforce Google's style guide, Microsoft's style guide, or your own custom rules. Integrate it into CI/CD to catch style issues before merge.

---

## Part VI: Templates

When creating documentation, start from these templates rather than from scratch.

### Tutorial Template

```markdown
# Tutorial: [What the Reader Will Build/Learn]

In this tutorial, you'll [concrete outcome]. By the end, you'll have [tangible result].

## Before You Begin

You need:
- [Prerequisite 1]
- [Prerequisite 2]

## Step 1: [Action]

[Brief context — one sentence max.]

[Instruction with code block or screenshot]

You should see: [Expected output]

## Step 2: [Action]

...

## What You've Learned

You've [summary of accomplishments]. Next, you might want to:
- [Link to related how-to guide]
- [Link to reference documentation]
```

### How-To Guide Template

```markdown
# How to [Task]

[One-sentence description of what this guide covers and when you'd need it.]

## Prerequisites

- [Prerequisite with version if relevant]

## Steps

1. [Verb-led instruction]
   ```
   [command or code]
   ```
2. [Verb-led instruction]

## Verify

[How to confirm the task succeeded.]

## Troubleshooting

**[Symptom]:** [Cause and fix.]
```

### API Reference Template (per endpoint)

```markdown
## [Method] [Path]

[One-sentence description.]

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `id` | path | string | Yes | The resource identifier |

### Request Body

```json
{
  "name": "example",
  "enabled": true
}
```

### Response

**200 OK**
```json
{
  "id": "abc-123",
  "name": "example",
  "created_at": "2026-01-15T10:30:00Z"
}
```

**404 Not Found**
```json
{
  "error": "resource_not_found",
  "message": "No resource with id 'abc-123'"
}
```
```

### README Template

```markdown
# Project Name

[One paragraph: what it is, what problem it solves, who it's for.]

## Quick Start

[The absolute fastest path to seeing it work — 3-5 commands max.]

## Installation

[Detailed installation instructions.]

## Usage

[Core usage examples with code.]

## Configuration

[Key configuration options in a table.]

## Documentation

[Link to full docs site.]

## Contributing

[Link to CONTRIBUTING.md or brief instructions.]

## License

[License name and link.]
```

### Architecture Decision Record (ADR) Template

```markdown
# ADR-[NUMBER]: [Title]

- **Status:** [Proposed | Accepted | Deprecated | Superseded by ADR-NNN]
- **Date:** [YYYY-MM-DD]
- **Deciders:** [Names]

## Context

[What is the situation? What forces are at play?]

## Decision

[What did we decide to do?]

## Consequences

**Positive:**
- [Benefit]

**Negative:**
- [Cost or trade-off]

**Risks:**
- [Risk and mitigation]
```

---

## Reference Files

- **`references/publishing-guide.md`** — Complete guide to multi-format publishing: Pandoc configuration (templates, metadata, fonts, styling), static site generator setup (MkDocs, Docusaurus, Sphinx), CI/CD pipelines, PDF theming, EPUB configuration, and documentation linting with Vale. Read when the user needs to publish, convert, or deploy documentation.

- **`references/quality-checklist.md`** — Systematic documentation quality checklist based on IBM's nine quality characteristics. Provides specific evaluation criteria, common problems, and remediation guidance for each characteristic. Read when reviewing documentation or evaluating the quality of existing docs.

- **`scripts/publish.sh`** — Multi-format publishing script. Takes a Markdown source directory and produces HTML, PDF, and EPUB output with a single command. Read the script header for usage instructions.