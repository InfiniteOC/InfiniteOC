# Publishing Guide: Multi-Format Documentation Output

This guide provides complete, working configurations for converting Markdown documentation to HTML, PDF, EPUB, slides, man pages, and documentation sites. All commands assume the source is Markdown unless noted otherwise.

## Table of Contents

1. [Pandoc Fundamentals](#1-pandoc-fundamentals)
2. [HTML Publishing](#2-html-publishing)
3. [PDF Publishing](#3-pdf-publishing)
4. [EPUB Publishing](#4-epub-publishing)
5. [Slide Decks](#5-slide-decks)
6. [Man Pages](#6-man-pages)
7. [DOCX / Word](#7-docx--word)
8. [MkDocs Site Setup](#8-mkdocs-site-setup)
9. [Docusaurus Site Setup](#9-docusaurus-site-setup)
10. [Sphinx Site Setup](#10-sphinx-site-setup)
11. [CI/CD Pipelines](#11-cicd-pipelines)
12. [Documentation Linting](#12-documentation-linting)
13. [Multi-Format Build Script](#13-multi-format-build-script)

---

## 1. Pandoc Fundamentals

### Installation

```bash
# macOS
brew install pandoc

# For PDF support via LaTeX:
brew install --cask mactex-no-gui
# or the lighter:
brew install basictex
# then: sudo tlmgr install collection-fontsrecommended collection-latexextra

# Ubuntu/Debian
sudo apt install pandoc texlive-xetex texlive-fonts-recommended texlive-plain-generic librsvg2-bin

# Verify
pandoc --version
```

### Metadata via YAML Frontmatter

Pandoc reads YAML metadata from the document or a separate file. This controls title, author, date, and many output-specific settings:

```yaml
---
title: "System Administration Guide"
subtitle: "Version 3.2"
author: ["Jane Smith", "DevOps Team"]
date: 2026-03-19
abstract: |
  This guide covers installation, configuration, and
  operation of the XYZ platform.
lang: en-GB
toc: true
toc-depth: 3
numbersections: true
documentclass: report
geometry: margin=2.5cm
fontsize: 11pt
mainfont: "Noto Serif"
sansfont: "Noto Sans"
monofont: "Fira Code"
colorlinks: true
linkcolor: NavyBlue
urlcolor: NavyBlue
---
```

Place this at the top of your Markdown file, or in a separate `metadata.yaml` and pass it to Pandoc with `--metadata-file=metadata.yaml`.

### Multiple Input Files

Pandoc concatenates multiple input files in order:

```bash
pandoc front-matter.md ch01.md ch02.md ch03.md appendix.md \
  --metadata-file=metadata.yaml \
  --pdf-engine=xelatex --toc -N \
  -o book.pdf
```

---

## 2. HTML Publishing

### Standalone HTML Page

```bash
pandoc input.md -s --toc \
  --metadata title="My Document" \
  -c style.css \
  -o output.html
```

The `-s` flag produces a standalone HTML document (with `<head>`, `<body>`). Without it, Pandoc outputs an HTML fragment.

### HTML with Custom CSS

Create a `style.css` for professional documentation appearance:

```css
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  max-width: 48rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
  color: #333;
}
h1, h2, h3, h4 { color: #1a1a1a; margin-top: 2rem; }
code { background: #f5f5f5; padding: 0.15em 0.3em; border-radius: 3px;
       font-size: 0.9em; }
pre { background: #f5f5f5; padding: 1rem; border-radius: 5px;
      overflow-x: auto; line-height: 1.4; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; }
th { background: #f0f0f0; font-weight: 600; }
blockquote { border-left: 4px solid #ddd; margin-left: 0;
             padding-left: 1rem; color: #666; }
a { color: #0066cc; }
img { max-width: 100%; height: auto; }
```

### HTML with Syntax Highlighting

```bash
# List available highlight styles
pandoc --list-highlight-styles

# Use a specific style
pandoc input.md -s --toc \
  --highlight-style=tango \
  -c style.css \
  -o output.html
```

### HTML with Embedded Images (self-contained)

```bash
pandoc input.md -s --toc --self-contained \
  -c style.css \
  -o output.html
```

The `--self-contained` flag embeds images, CSS, and fonts as data URIs — producing a single portable HTML file.

---

## 3. PDF Publishing

PDF output requires a LaTeX engine. XeTeX is recommended for Unicode and custom font support.

### Basic PDF

```bash
pandoc input.md --pdf-engine=xelatex -o output.pdf
```

### Professional PDF with Full Options

```bash
pandoc input.md \
  --pdf-engine=xelatex \
  --toc \
  --toc-depth=3 \
  -N \
  -V geometry:margin=2.5cm \
  -V fontsize=11pt \
  -V mainfont="Noto Serif" \
  -V sansfont="Noto Sans" \
  -V monofont="Fira Code" \
  -V documentclass=report \
  -V colorlinks=true \
  -V linkcolor=NavyBlue \
  -V urlcolor=NavyBlue \
  --highlight-style=tango \
  -o output.pdf
```

### PDF with Custom Header/Footer

Create a `header.tex`:

```latex
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhead[L]{\leftmark}
\fancyhead[R]{\thepage}
\fancyfoot[C]{Confidential — Internal Use Only}
```

```bash
pandoc input.md --pdf-engine=xelatex \
  -H header.tex \
  --toc -N \
  -o output.pdf
```

### PDF with Cover Page

Create a `before-body.tex`:

```latex
\begin{titlepage}
\centering
\vspace*{5cm}
{\Huge\bfseries System Administration Guide\par}
\vspace{1cm}
{\Large Version 3.2\par}
\vspace{2cm}
{\large DevOps Team\par}
{\large March 2026\par}
\vfill
{\large ACME Corporation\par}
\end{titlepage}
\newpage
```

```bash
pandoc input.md --pdf-engine=xelatex \
  -B before-body.tex \
  --toc -N \
  -o output.pdf
```

### PDF Using Eisvogel Template (recommended for professional output)

The Eisvogel template produces beautiful PDFs with minimal configuration:

```bash
# Install the template
mkdir -p ~/.local/share/pandoc/templates
wget -O ~/.local/share/pandoc/templates/eisvogel.latex \
  https://raw.githubusercontent.com/Wandmalfarbe/pandoc-latex-template/master/eisvogel.tex

# Use it
pandoc input.md --pdf-engine=xelatex \
  --template=eisvogel \
  --toc -N \
  -V titlepage=true \
  -V titlepage-color="2b4162" \
  -V titlepage-text-color="ffffff" \
  -V toc-own-page=true \
  -V listings=true \
  -o output.pdf
```

---

## 4. EPUB Publishing

### Basic EPUB

```bash
pandoc input.md --toc -o output.epub
```

### EPUB with Cover Image and Metadata

```bash
pandoc input.md \
  --toc \
  --epub-cover-image=cover.png \
  --metadata title="My Documentation" \
  --metadata author="Author Name" \
  --metadata date="2026-03-19" \
  --metadata lang="en" \
  --epub-chapter-level=2 \
  --css=epub-style.css \
  -o output.epub
```

### EPUB Stylesheet

Create `epub-style.css`:

```css
body { font-family: Georgia, serif; line-height: 1.6; margin: 1em; }
h1 { page-break-before: always; margin-top: 2em; }
code { font-family: "Courier New", monospace; font-size: 0.9em;
       background: #f5f5f5; padding: 0.1em 0.3em; }
pre { background: #f5f5f5; padding: 1em; overflow-x: auto;
      font-size: 0.85em; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #ccc; padding: 0.4em; }
th { background: #eee; }
```

---

## 5. Slide Decks

### Reveal.js (HTML slides)

```bash
pandoc slides.md -t revealjs -s \
  -V theme=white \
  -V transition=slide \
  -V slideNumber=true \
  -o slides.html
```

Slide separation: use `---` for horizontal slides, `--` for vertical slides, or `# Heading` for new slides.

### Beamer (PDF slides)

```bash
pandoc slides.md -t beamer \
  -V theme=metropolis \
  --pdf-engine=xelatex \
  -o slides.pdf
```

### Slide Markdown Format

```markdown
---
title: "Architecture Overview"
author: "Engineering Team"
date: 2026-03-19
---

# Introduction

Key points for this presentation.

---

# System Architecture

![Architecture diagram](arch.png)

- Component A handles ingestion
- Component B handles processing
- Component C handles storage

---

# Performance Results

| Metric | Before | After |
|--------|--------|-------|
| Latency | 450ms | 12ms |
| Throughput | 100 rps | 15,000 rps |
```

---

## 6. Man Pages

```bash
# Generate man page
pandoc input.md -s -t man -o mycommand.1

# Preview
man ./mycommand.1

# Install
sudo install -m 644 mycommand.1 /usr/local/share/man/man1/
```

Man page Markdown should include a YAML header:

```yaml
---
title: MYCOMMAND
section: 1
header: "User Commands"
footer: "mycommand 2.1.0"
date: March 2026
---
```

---

## 7. DOCX / Word

```bash
# Basic conversion
pandoc input.md -o output.docx

# With a custom reference template (for branding/styles)
pandoc input.md --reference-doc=company-template.docx -o output.docx
```

To create a reference template: generate a default one with `pandoc -o custom-reference.docx --print-default-data-file reference.docx`, open it in Word, modify the styles (Heading 1, Body Text, Code, etc.), save, then use it with `--reference-doc`.

---

## 8. MkDocs Site Setup

### Quick Start

```bash
pip install mkdocs-material
mkdocs new my-docs
cd my-docs
```

### mkdocs.yml Configuration

```yaml
site_name: "Project Documentation"
site_url: https://docs.example.com
repo_url: https://github.com/org/project

theme:
  name: material
  palette:
    - scheme: default
      primary: indigo
      accent: indigo
      toggle:
        icon: material/brightness-7
        name: Switch to dark mode
    - scheme: slate
      primary: indigo
      accent: indigo
      toggle:
        icon: material/brightness-4
        name: Switch to light mode
  features:
    - navigation.instant
    - navigation.tracking
    - navigation.tabs
    - navigation.sections
    - navigation.expand
    - search.suggest
    - search.highlight
    - content.code.copy
    - content.tabs.link

nav:
  - Home: index.md
  - Getting Started:
    - Installation: getting-started/installation.md
    - Quick Start: getting-started/quickstart.md
  - Guides:
    - Configuration: guides/configuration.md
    - Deployment: guides/deployment.md
  - Reference:
    - API: reference/api.md
    - CLI: reference/cli.md
    - Configuration Options: reference/config.md

markdown_extensions:
  - admonition
  - pymdownx.details
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true
  - pymdownx.highlight:
      anchor_linenums: true
  - pymdownx.inlinehilite
  - tables
  - toc:
      permalink: true

plugins:
  - search
  - minify:
      minify_html: true

extra:
  social:
    - icon: fontawesome/brands/github
      link: https://github.com/org/project
```

### Commands

```bash
mkdocs serve                    # Local dev server at :8000
mkdocs build                    # Build to ./site/
mkdocs gh-deploy                # Deploy to GitHub Pages
```

---

## 9. Docusaurus Site Setup

### Quick Start

```bash
npx create-docusaurus@latest my-docs classic
cd my-docs
npm start   # Dev server at :3000
```

### docusaurus.config.js (key settings)

```javascript
module.exports = {
  title: 'Project Docs',
  url: 'https://docs.example.com',
  baseUrl: '/',
  organizationName: 'org',
  projectName: 'project',

  presets: [
    ['classic', {
      docs: {
        sidebarPath: require.resolve('./sidebars.js'),
        editUrl: 'https://github.com/org/project/edit/main/',
      },
    }],
  ],

  themeConfig: {
    navbar: {
      title: 'Project',
      items: [
        { type: 'doc', docId: 'intro', position: 'left', label: 'Docs' },
        { href: 'https://github.com/org/project', label: 'GitHub', position: 'right' },
      ],
    },
  },
};
```

### Build & Deploy

```bash
npm run build     # Build to ./build/
npm run serve     # Preview the build locally
```

---

## 10. Sphinx Site Setup

### Quick Start

```bash
pip install sphinx sphinx-rtd-theme myst-parser
mkdir docs && cd docs
sphinx-quickstart
```

### conf.py (key settings for Markdown support)

```python
extensions = [
    'myst_parser',           # Markdown support
    'sphinx.ext.autodoc',    # Auto-generate from docstrings
    'sphinx.ext.viewcode',   # Link to source code
    'sphinx.ext.napoleon',   # Google/NumPy docstring style
]

source_suffix = {
    '.rst': 'restructuredtext',
    '.md': 'markdown',
}

html_theme = 'sphinx_rtd_theme'
```

### Build

```bash
make html     # Build to _build/html/
make latexpdf # Build PDF via LaTeX
```

---

## 11. CI/CD Pipelines

### GitHub Actions: Build and Deploy MkDocs to GitHub Pages

```yaml
# .github/workflows/docs.yml
name: Deploy Documentation

on:
  push:
    branches: [main]
    paths: ['docs/**', 'mkdocs.yml']

permissions:
  contents: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install mkdocs-material
      - run: mkdocs gh-deploy --force
```

### GitHub Actions: Build PDF and EPUB Artifacts

```yaml
# .github/workflows/publish.yml
name: Build Documentation Artifacts

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Pandoc and LaTeX
        run: |
          sudo apt-get update
          sudo apt-get install -y pandoc texlive-xetex texlive-fonts-recommended \
            texlive-plain-generic librsvg2-bin

      - name: Build PDF
        run: |
          pandoc docs/*.md --pdf-engine=xelatex --toc -N \
            --metadata-file=docs/metadata.yaml \
            -o documentation.pdf

      - name: Build EPUB
        run: |
          pandoc docs/*.md --toc \
            --metadata-file=docs/metadata.yaml \
            --epub-cover-image=docs/assets/cover.png \
            -o documentation.epub

      - name: Upload Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: documentation
          path: |
            documentation.pdf
            documentation.epub
```

### GitLab CI: Build and Deploy

```yaml
# .gitlab-ci.yml
pages:
  image: python:3.12
  script:
    - pip install mkdocs-material
    - mkdocs build -d public
  artifacts:
    paths: [public]
  only: [main]
```

---

## 12. Documentation Linting

### Vale Setup

```bash
# Install
brew install vale    # macOS
# or: snap install vale  # Linux

# Create config
cat > .vale.ini << 'EOF'
StylesPath = .vale/styles
MinAlertLevel = suggestion

Packages = Google, write-good

[*.md]
BasedOnStyles = Vale, Google, write-good

[*.txt]
BasedOnStyles = Vale
EOF

# Download style packages
vale sync

# Lint
vale docs/
vale --output=line docs/    # Machine-readable output for CI
```

### Custom Vale Rules

Create project-specific rules in `.vale/styles/ProjectName/`:

```yaml
# .vale/styles/ProjectName/Acronyms.yml
extends: existence
message: "Define '%s' on first use."
level: warning
tokens:
  - 'API'
  - 'SDK'
  - 'CLI'
  - 'REST'
```

### markdownlint Setup

```bash
npm install -g markdownlint-cli

# Create config
cat > .markdownlint.yaml << 'EOF'
default: true
MD013:                  # Line length
  line_length: 120
  code_blocks: false
  tables: false
MD033: false            # Allow inline HTML
MD041: false            # First line heading
EOF

# Lint
markdownlint docs/**/*.md
```

### CI Integration

```yaml
# In GitHub Actions
- name: Lint Documentation
  run: |
    brew install vale
    vale sync
    vale docs/
```

---

## 13. Multi-Format Build Script

For a single command that builds all formats, use the `scripts/publish.sh` script in this skill, or adapt this pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="${1:?Usage: publish.sh <source-dir> [output-dir]}"
OUT_DIR="${2:-dist}"
METADATA="${SRC_DIR}/metadata.yaml"

mkdir -p "$OUT_DIR"

# Collect source files in order
SOURCES=$(find "$SRC_DIR" -name '*.md' -not -name 'metadata.yaml' | sort)

COMMON_OPTS="--toc --toc-depth=3"
[ -f "$METADATA" ] && COMMON_OPTS="$COMMON_OPTS --metadata-file=$METADATA"

echo "==> Building HTML..."
pandoc $SOURCES $COMMON_OPTS -s \
  --highlight-style=tango \
  --self-contained \
  -o "$OUT_DIR/documentation.html"

echo "==> Building PDF..."
pandoc $SOURCES $COMMON_OPTS -N \
  --pdf-engine=xelatex \
  --highlight-style=tango \
  -V geometry:margin=2.5cm \
  -V fontsize=11pt \
  -V colorlinks=true \
  -o "$OUT_DIR/documentation.pdf"

echo "==> Building EPUB..."
pandoc $SOURCES $COMMON_OPTS \
  --epub-chapter-level=2 \
  -o "$OUT_DIR/documentation.epub"

echo "==> Done. Output in $OUT_DIR/"
ls -lh "$OUT_DIR/"
```
