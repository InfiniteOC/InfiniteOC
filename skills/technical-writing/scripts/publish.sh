#!/usr/bin/env bash
# ============================================================================
# publish.sh — Multi-format documentation publisher
#
# Converts Markdown documentation to HTML, PDF, and EPUB using Pandoc.
#
# Usage:
#   publish.sh <source-dir> [output-dir] [--formats=html,pdf,epub] [--template=eisvogel]
#
# Arguments:
#   source-dir    Directory containing .md files (and optional metadata.yaml)
#   output-dir    Output directory (default: ./dist)
#
# Options:
#   --formats=LIST    Comma-separated formats: html,pdf,epub,docx,slides,man
#                     (default: html,pdf,epub)
#   --template=NAME   LaTeX template for PDF: eisvogel, default
#                     (default: default)
#   --css=PATH        Custom CSS file for HTML output
#   --cover=PATH      Cover image for EPUB
#   --title=TEXT       Override document title
#   --self-contained  Embed all assets in HTML (single-file output)
#
# Prerequisites:
#   - pandoc (https://pandoc.org/installing.html)
#   - For PDF: texlive-xetex or MacTeX
#   - For Eisvogel template: install separately (see publishing-guide.md)
#
# Examples:
#   publish.sh docs/
#   publish.sh docs/ build/ --formats=pdf
#   publish.sh docs/ dist/ --formats=html,pdf,epub --template=eisvogel
#   publish.sh docs/ dist/ --self-contained --css=custom.css
# ============================================================================

set -euo pipefail

# ---------- Argument parsing ----------

SRC_DIR=""
OUT_DIR="dist"
FORMATS="html,pdf,epub"
TEMPLATE="default"
CSS_FILE=""
COVER_IMAGE=""
TITLE_OVERRIDE=""
SELF_CONTAINED=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --formats=*)  FORMATS="${1#*=}"; shift ;;
    --template=*) TEMPLATE="${1#*=}"; shift ;;
    --css=*)      CSS_FILE="${1#*=}"; shift ;;
    --cover=*)    COVER_IMAGE="${1#*=}"; shift ;;
    --title=*)    TITLE_OVERRIDE="${1#*=}"; shift ;;
    --self-contained) SELF_CONTAINED="--self-contained"; shift ;;
    --help|-h)
      head -35 "$0" | tail -32
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$SRC_DIR" ]]; then SRC_DIR="$1"
      elif [[ "$OUT_DIR" == "dist" ]]; then OUT_DIR="$1"
      fi
      shift ;;
  esac
done

if [[ -z "$SRC_DIR" ]]; then
  echo "Usage: publish.sh <source-dir> [output-dir] [options]" >&2
  echo "Run with --help for full usage." >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Error: Source directory '$SRC_DIR' not found." >&2
  exit 1
fi

# ---------- Check dependencies ----------

if ! command -v pandoc &>/dev/null; then
  echo "Error: pandoc is not installed." >&2
  echo "Install: brew install pandoc (macOS) or apt install pandoc (Linux)" >&2
  exit 1
fi

# ---------- Collect sources ----------

mkdir -p "$OUT_DIR"

METADATA=""
if [[ -f "$SRC_DIR/metadata.yaml" ]]; then
  METADATA="--metadata-file=$SRC_DIR/metadata.yaml"
fi

# Collect .md files in sorted order, excluding metadata.yaml
SOURCES=()
while IFS= read -r -d '' file; do
  SOURCES+=("$file")
done < <(find "$SRC_DIR" -name '*.md' -not -name 'metadata.yaml' -print0 | sort -z)

if [[ ${#SOURCES[@]} -eq 0 ]]; then
  echo "Error: No .md files found in '$SRC_DIR'." >&2
  exit 1
fi

echo "Found ${#SOURCES[@]} source file(s) in $SRC_DIR"

# ---------- Common options ----------

COMMON_OPTS="--toc --toc-depth=3"
[[ -n "$METADATA" ]] && COMMON_OPTS="$COMMON_OPTS $METADATA"
[[ -n "$TITLE_OVERRIDE" ]] && COMMON_OPTS="$COMMON_OPTS --metadata title=\"$TITLE_OVERRIDE\""

# ---------- Build functions ----------

build_html() {
  echo "==> Building HTML..."
  local css_opt=""
  [[ -n "$CSS_FILE" ]] && css_opt="-c $CSS_FILE"

  pandoc "${SOURCES[@]}" $COMMON_OPTS -s \
    --highlight-style=tango \
    $css_opt \
    $SELF_CONTAINED \
    -o "$OUT_DIR/documentation.html"

  echo "    ✓ $OUT_DIR/documentation.html ($(du -h "$OUT_DIR/documentation.html" | cut -f1))"
}

build_pdf() {
  echo "==> Building PDF..."

  if ! command -v xelatex &>/dev/null && ! command -v pdflatex &>/dev/null; then
    echo "    ✗ Skipping PDF: LaTeX not installed." >&2
    echo "    Install: brew install --cask mactex-no-gui (macOS)" >&2
    return 1
  fi

  local template_opt=""
  if [[ "$TEMPLATE" == "eisvogel" ]]; then
    template_opt="--template=eisvogel -V titlepage=true -V toc-own-page=true -V listings=true"
  fi

  pandoc "${SOURCES[@]}" $COMMON_OPTS -N \
    --pdf-engine=xelatex \
    --highlight-style=tango \
    -V geometry:margin=2.5cm \
    -V fontsize=11pt \
    -V colorlinks=true \
    -V linkcolor=NavyBlue \
    -V urlcolor=NavyBlue \
    $template_opt \
    -o "$OUT_DIR/documentation.pdf"

  echo "    ✓ $OUT_DIR/documentation.pdf ($(du -h "$OUT_DIR/documentation.pdf" | cut -f1))"
}

build_epub() {
  echo "==> Building EPUB..."

  local cover_opt=""
  [[ -n "$COVER_IMAGE" ]] && cover_opt="--epub-cover-image=$COVER_IMAGE"

  pandoc "${SOURCES[@]}" $COMMON_OPTS \
    --epub-chapter-level=2 \
    $cover_opt \
    -o "$OUT_DIR/documentation.epub"

  echo "    ✓ $OUT_DIR/documentation.epub ($(du -h "$OUT_DIR/documentation.epub" | cut -f1))"
}

build_docx() {
  echo "==> Building DOCX..."

  pandoc "${SOURCES[@]}" $COMMON_OPTS \
    -o "$OUT_DIR/documentation.docx"

  echo "    ✓ $OUT_DIR/documentation.docx ($(du -h "$OUT_DIR/documentation.docx" | cut -f1))"
}

build_slides() {
  echo "==> Building Slides (reveal.js)..."

  pandoc "${SOURCES[@]}" -t revealjs -s \
    -V theme=white \
    -V transition=slide \
    -V slideNumber=true \
    -o "$OUT_DIR/slides.html"

  echo "    ✓ $OUT_DIR/slides.html ($(du -h "$OUT_DIR/slides.html" | cut -f1))"
}

build_man() {
  echo "==> Building Man Page..."

  pandoc "${SOURCES[@]}" -s -t man \
    -o "$OUT_DIR/documentation.1"

  echo "    ✓ $OUT_DIR/documentation.1 ($(du -h "$OUT_DIR/documentation.1" | cut -f1))"
}

# ---------- Execute requested formats ----------

IFS=',' read -ra FMT_ARRAY <<< "$FORMATS"
FAILED=0

for fmt in "${FMT_ARRAY[@]}"; do
  case "$fmt" in
    html)   build_html   || ((FAILED++)) ;;
    pdf)    build_pdf    || ((FAILED++)) ;;
    epub)   build_epub   || ((FAILED++)) ;;
    docx)   build_docx   || ((FAILED++)) ;;
    slides) build_slides || ((FAILED++)) ;;
    man)    build_man    || ((FAILED++)) ;;
    *)      echo "Unknown format: $fmt" >&2; ((FAILED++)) ;;
  esac
done

# ---------- Summary ----------

echo ""
echo "==> Publishing complete."
echo "    Output directory: $OUT_DIR/"
ls -lh "$OUT_DIR/" | tail -n +2

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "    ⚠ $FAILED format(s) failed. Check output above."
  exit 1
fi
