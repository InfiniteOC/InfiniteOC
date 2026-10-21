Build a complete expense tracker web app in this directory. No build step, no frameworks, no external libraries or CDNs: plain HTML, CSS and ES modules.

Requirements:
1. index.html, styles.css, app.js (UI) and logic.js (pure functions only, no DOM).
2. Add, edit and delete expenses: amount (positive, max 2 decimals), description (required, max 100 chars), category (Food, Transport, Housing, Fun, Other), date (defaults to today).
3. Validate input and show inline, accessible error messages (no alert()).
4. Filter the list by month (YYYY-MM select built from the data) and by category; sort by date or amount.
5. Show the total for the current filter and a per-category bar chart drawn on <canvas> (no libraries).
6. Persist to localStorage; survive reloads; handle corrupt storage gracefully.
7. Export the current filtered list as CSV (proper quoting of commas/quotes/newlines).
8. Responsive (works at 375px wide), keyboard accessible, labelled form controls, dark mode via prefers-color-scheme.
9. Write tests for logic.js in logic.test.mjs using node:test (validation, filtering, totals, CSV escaping, month list). They must pass with: node --test
10. A short README.md explaining how to run it (e.g. npx serve or python -m http.server) and the tests.

When finished, run the tests yourself and fix any failures.
