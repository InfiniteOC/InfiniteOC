# Third-party notices

InfiniteOC contains no vendored copy of OpenCode. At setup it clones the
pinned tag from the official upstream repository
(`https://github.com/sst/opencode.git`) into the git-ignored `.upstream/`
directory, copies that tree to the git-ignored `.runtime/opencode`, applies
local source mods at build time, and builds a separate binary. OpenCode
remains under its own license:

- OpenCode — MIT License, Copyright (c) 2025 opencode
  (https://github.com/sst/opencode). The MIT text ships with the fetched
  source; InfiniteOC does not redistribute it.

Bundled third-party material in this repository keeps its own license,
which governs that material:

- `skills/ponytail`, `skills/ponytail-*` — MIT License,
  Copyright (c) 2026 DietrichGebert (see `skills/ponytail/LICENSE`).
  Referenced from the README with the author's link.
- `skills/frontend-design` — adapted from Anthropic's frontend-design skill;
  Apache License 2.0 (see `skills/frontend-design/LICENSE.txt`).
  Modifications for InfiniteOC: existing-product mode, a required written
  plan, a measurable quality floor, build rules, a render-and-inspect
  verification loop, a completion checklist, and pointers to bundled skills.
- `skills/` otherwise: each skill carrying a `LICENSE.txt` or a `license:`
  front-matter field is governed by the license stated there. Skills with no
  license statement grant no rights beyond viewing unless their provenance is
  otherwise documented; do not assume they are MIT-licensed with this
  repository. Unmarked skills that are original to this repository fall under
  the root `LICENSE`.
- Not bundled (license forbids redistribution): Anthropic's `docx`, `pdf`,
  `pptx` and `xlsx` document skills. Their license prohibits extracting,
  copying or distributing them outside Anthropic's services, so this
  repository must not and does not include them. The auto-router points
  office-document work at local tools instead.

InfiniteOC is an independent community project. It is not affiliated with,
endorsed by, or sponsored by the OpenCode authors. "OpenCode" belongs to
its respective owner; this repository uses the name only to describe
interoperability (a launcher/mod framework for OpenCode) and claims no
trademark rights.
