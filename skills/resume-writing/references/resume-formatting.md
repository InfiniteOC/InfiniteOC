# Resume Document Formatting and Production

Detailed guide to producing professional resume documents in multiple formats.

## Table of Contents

1. [Markdown Source Format](#1-markdown-source-format)
2. [PDF via Pandoc](#2-pdf-via-pandoc)
3. [PDF via Typst](#3-pdf-via-typst)
4. [PDF via LaTeX](#4-pdf-via-latex)
5. [DOCX for ATS Submission](#5-docx-for-ats-submission)
6. [HTML with Print Stylesheet](#6-html-with-print-stylesheet)
7. [ATS-Safe Formatting Rules](#7-ats-safe-formatting-rules)
8. [Typography and Layout](#8-typography-and-layout)

---

## 1. Markdown Source Format

Write the resume in Markdown for maximum portability. Convert to any target format via Pandoc, Typst, or LaTeX.

```markdown
---
title: "Jane Smith"
subtitle: "Senior Operations Manager"
author: "Jane Smith"
geometry: margin=0.75in
fontsize: 11pt
mainfont: "Garamond"
colorlinks: true
linkcolor: NavyBlue
---

# Jane Smith

**jane.smith@email.com** | **(555) 123-4567** | **linkedin.com/in/janesmith** | **Melbourne, VIC**

---

## Professional Summary

Operations leader with 12 years driving efficiency in manufacturing environments.
Reduced production costs by $4.2M at Acme Corp through lean process redesign.
Six Sigma Black Belt. Experienced leading teams of 50+ across 24/7 operations.

## Core Competencies

Lean Manufacturing • Six Sigma (Black Belt) • ERP Implementation • Team Leadership •
Continuous Improvement • Supply Chain Optimization • Change Management •
Budget Management ($15M+) • Stakeholder Engagement • Data-Driven Decision Making

## Professional Experience

### **Operations Manager** | Acme Corp, Melbourne | Jan 2019 – Present

Led 45-person operations team across three shifts in 24/7 manufacturing facility.

- Redesigned assembly line workflow, reducing cycle time by 35% and eliminating $1.2M in annual waste
- Led ERP transition for 2,000 users, delivered on schedule with zero production days lost
- Improved staff engagement scores by 15 points through change champion network
- Reduced safety incidents by 60% via behavioural safety program

### **Production Supervisor** | Beta Manufacturing, Sydney | Mar 2014 – Dec 2018

Supervised 20-person production team in high-volume consumer goods facility.

- Increased throughput by 22% through bottleneck analysis and process redesign
- Achieved 99.2% on-time delivery rate (up from 91%)
- Mentored 3 team leads who were subsequently promoted to supervisory roles

## Education

**Bachelor of Engineering (Industrial)** | University of Melbourne | 2013

## Certifications

- Six Sigma Black Belt (ASQ) — 2020
- Lean Manufacturing Professional — 2018
- Certificate IV in Training and Assessment — 2017
```

---

## 2. PDF via Pandoc

### Basic Professional PDF

```bash
pandoc resume.md -o resume.pdf \
  --pdf-engine=xelatex \
  -V geometry:margin=0.75in \
  -V fontsize=11pt \
  -V mainfont="Garamond" \
  -V sansfont="Calibri" \
  -V colorlinks=true \
  -V linkcolor=NavyBlue \
  -V urlcolor=NavyBlue
```

### Polished PDF with Custom Styling

Create a `resume-header.tex` for fine-tuned control:

```latex
\usepackage{titlesec}
\usepackage{enumitem}

% Compact section headings
\titleformat{\section}{\large\bfseries\color{NavyBlue}}{}{0em}{}[\titlerule]
\titlespacing*{\section}{0pt}{12pt}{6pt}

% Compact subsection (job titles)
\titleformat{\subsection}[runin]{\bfseries}{}{0em}{}
\titlespacing*{\subsection}{0pt}{8pt}{4pt}

% Tight bullet lists
\setlist[itemize]{nosep, leftmargin=1.5em, label=\textbullet}

% No paragraph indent
\setlength{\parindent}{0pt}

% Reduce spacing
\setlength{\parskip}{4pt}
```

```bash
pandoc resume.md -o resume.pdf \
  --pdf-engine=xelatex \
  -H resume-header.tex \
  -V geometry:margin=0.75in \
  -V fontsize=11pt \
  -V mainfont="Garamond" \
  -V pagestyle=empty
```

### Multi-File (Resume + Cover Letter)

```bash
# Build resume
pandoc resume.md -o resume.pdf --pdf-engine=xelatex -V geometry:margin=0.75in

# Build cover letter
pandoc cover-letter.md -o cover-letter.pdf --pdf-engine=xelatex -V geometry:margin=1in

# Combine into single PDF
pdftk resume.pdf cover-letter.pdf cat output application-complete.pdf
```

---

## 3. PDF via Typst

Typst is a modern alternative to LaTeX — faster compilation, simpler syntax, excellent typography.

```bash
# Install Typst
brew install typst   # macOS
# or: cargo install typst-cli
```

### Typst Resume Template

```typst
// resume.typ
#set document(title: "Jane Smith — Resume", author: "Jane Smith")
#set page(margin: (x: 0.75in, y: 0.75in), paper: "a4")
#set text(font: "Linux Libertine", size: 10.5pt)
#set par(leading: 0.6em)

// Header
#align(center)[
  #text(size: 20pt, weight: "bold")[Jane Smith] \
  #text(size: 10pt, fill: rgb("#555"))[
    jane.smith\@email.com · (555) 123-4567 · linkedin.com/in/janesmith · Melbourne, VIC
  ]
]

#line(length: 100%, stroke: 0.5pt + rgb("#ccc"))

// Section heading helper
#let section(title) = {
  v(10pt)
  text(size: 12pt, weight: "bold", fill: rgb("#2b4162"))[#title]
  v(2pt)
  line(length: 100%, stroke: 0.4pt + rgb("#ddd"))
  v(4pt)
}

// Job entry helper
#let job(title, company, location, dates, bullets) = {
  grid(
    columns: (1fr, auto),
    text(weight: "bold")[#title] + [ — ] + text(style: "italic")[#company, #location],
    text(fill: rgb("#555"))[#dates],
  )
  v(2pt)
  for bullet in bullets {
    [• #bullet \ ]
  }
  v(6pt)
}

#section("Professional Summary")

Operations leader with 12 years driving efficiency in manufacturing environments.
Reduced production costs by \$4.2M at Acme Corp through lean process redesign.
Six Sigma Black Belt. Experienced leading teams of 50+ across 24/7 operations.

#section("Professional Experience")

#job(
  "Operations Manager",
  "Acme Corp",
  "Melbourne",
  "Jan 2019 – Present",
  (
    "Redesigned assembly line workflow, reducing cycle time by 35% and eliminating $1.2M in annual waste",
    "Led ERP transition for 2,000 users, delivered on schedule with zero production days lost",
    "Improved staff engagement scores by 15 points through change champion network",
  ),
)

#job(
  "Production Supervisor",
  "Beta Manufacturing",
  "Sydney",
  "Mar 2014 – Dec 2018",
  (
    "Increased throughput by 22% through bottleneck analysis and process redesign",
    "Achieved 99.2% on-time delivery rate (up from 91%)",
  ),
)

#section("Education")

*Bachelor of Engineering (Industrial)* — University of Melbourne, 2013

#section("Certifications")

• Six Sigma Black Belt (ASQ) — 2020 \
• Lean Manufacturing Professional — 2018
```

```bash
typst compile resume.typ resume.pdf
```

---

## 4. PDF via LaTeX

For maximum typographic control, use a LaTeX resume class.

### moderncv

```latex
\documentclass[11pt,a4paper]{moderncv}
\moderncvstyle{classic}
\moderncvcolor{blue}

\usepackage[margin=0.75in]{geometry}

\name{Jane}{Smith}
\title{Senior Operations Manager}
\phone[mobile]{(555) 123-4567}
\email{jane.smith@email.com}
\social[linkedin]{janesmith}

\begin{document}
\makecvtitle

\section{Professional Experience}
\cventry{2019--Present}{Operations Manager}{Acme Corp}{Melbourne}{}{%
\begin{itemize}
\item Redesigned assembly line workflow, reducing cycle time by 35\%
\item Led ERP transition for 2,000 users, delivered on schedule
\end{itemize}}

\section{Education}
\cventry{2013}{B.Eng (Industrial)}{University of Melbourne}{}{}{}

\section{Certifications}
\cvlistitem{Six Sigma Black Belt (ASQ) -- 2020}
\end{document}
```

```bash
xelatex resume.tex
```

---

## 5. DOCX for ATS Submission

When submitting to an ATS, DOCX parses more reliably than PDF.

```bash
# Create a clean DOCX from Markdown
pandoc resume.md -o resume.docx

# With a branded reference template
pandoc resume.md --reference-doc=resume-template.docx -o resume.docx
```

To create a reference template:
1. Generate default: `pandoc -o ref.docx --print-default-data-file reference.docx`
2. Open in Word, modify styles (Heading 1, Body Text, List Bullet)
3. Save as `resume-template.docx`
4. Use with `--reference-doc`

---

## 6. HTML with Print Stylesheet

For web portfolios or printing from browser:

```bash
pandoc resume.md -s --self-contained -c resume-print.css -o resume.html
```

### Print-Optimised CSS

```css
/* resume-print.css */
@page {
  size: A4;
  margin: 0.75in;
}

body {
  font-family: Garamond, Georgia, "Times New Roman", serif;
  font-size: 11pt;
  line-height: 1.35;
  color: #222;
  max-width: 8.5in;
  margin: 0 auto;
  padding: 0.75in;
}

h1 {
  font-size: 20pt;
  text-align: center;
  margin-bottom: 0.25em;
  color: #1a1a1a;
}

h2 {
  font-size: 12pt;
  color: #2b4162;
  border-bottom: 1px solid #ddd;
  padding-bottom: 3pt;
  margin-top: 14pt;
  margin-bottom: 6pt;
  text-transform: uppercase;
  letter-spacing: 1pt;
}

h3 {
  font-size: 11pt;
  font-weight: bold;
  margin-bottom: 2pt;
}

ul {
  margin: 4pt 0;
  padding-left: 1.5em;
}

li {
  margin-bottom: 2pt;
}

hr {
  border: none;
  border-top: 1px solid #ccc;
  margin: 8pt 0;
}

a { color: #2b4162; text-decoration: none; }

@media print {
  body { padding: 0; }
  a { color: #000; }
  h2 { page-break-after: avoid; }
}
```

---

## 7. ATS-Safe Formatting Rules

| Rule | Do | Don't |
|------|-----|-------|
| **Layout** | Single column, linear flow | Multi-column, tables, text boxes |
| **Headings** | "Experience", "Education", "Skills" | "My Journey", "What I Know", custom labels |
| **Font** | Calibri, Arial, Garamond, Georgia, Cambria | Decorative, script, or obscure fonts |
| **Font size** | 10.5–12pt body, 14–20pt name | Below 10pt or above 14pt for body |
| **Bullets** | Standard bullet (•) or hyphen (-) | Custom icons, emojis, images |
| **File format** | .docx for ATS, .pdf for human review | .pages, .odt, image-based PDF |
| **Dates** | "Jan 2019 – Present" or "2019 – Present" | "1/19 – now" or non-standard formats |
| **Headers/Footers** | Keep critical info in body | Name/contact info only in header |
| **Links** | Full URL visible as text | Hyperlinked text with hidden URL |

---

## 8. Typography and Layout

### Font Recommendations

| Font | Category | Character | Best For |
|------|----------|-----------|----------|
| **Garamond** | Serif | Elegant, traditional | Senior roles, consulting, finance |
| **Georgia** | Serif | Readable, warm | Most professional roles |
| **Calibri** | Sans-serif | Clean, modern, familiar | Corporate, tech, default safe choice |
| **Helvetica Neue** | Sans-serif | Crisp, authoritative | Design, tech, modern industries |
| **Cambria** | Serif | Professional, dense | Academic, government |

### Layout Dimensions

| Element | Specification |
|---------|--------------|
| **Page margins** | 0.5"–1.0" all sides (0.75" recommended) |
| **Name** | 16–20pt, bold, centred or left-aligned |
| **Section headings** | 12–14pt, bold, uppercase or title case, with rule below |
| **Body text** | 10.5–11.5pt |
| **Line spacing** | 1.0–1.15 |
| **Space between sections** | 10–14pt |
| **Space between job entries** | 6–10pt |
| **Bullet indentation** | 0.25"–0.4" from left margin |
