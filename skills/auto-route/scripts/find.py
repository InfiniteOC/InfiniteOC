#!/usr/bin/env python3
"""Read-only metadata search. Ranking is discovery, not phase/quality inference."""
import argparse
import json
import math
import re
import sys
from pathlib import Path

DEFAULT_CATALOG = Path(__file__).resolve().parents[1] / "references/catalog.json"
STOP = {"a", "an", "the", "and", "or", "with", "for", "to", "in", "of", "my", "help", "me", "use", "using"}
LANGUAGES = {"rust", "python", "go", "java", "javascript", "typescript", "react", "kubernetes", "swiftui"}


def words(text):
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def load_catalog(file):
    rows = json.loads(Path(file).read_text())
    if not isinstance(rows, list):
        raise ValueError("Invalid catalog")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or any(not isinstance(row.get(k), str) or not row[k].strip()
                                            for k in ("id", "description", "category", "installed")):
            raise ValueError("Invalid catalog entry")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9:_-]*", row["id"]) or row["id"] in seen:
            raise ValueError("Duplicate or invalid skill ID")
        if not Path(row["installed"]).is_absolute():
            raise ValueError("Skill paths must be absolute")
        seen.add(row["id"])
    return rows


def search(rows, query, category=None, include_missing=False):
    terms = words(query) - STOP
    indexed = [(row, words(row["id"]), words(row["category"]), words(row["description"])) for row in rows]
    df = {term: sum(term in ident | cat | desc for _, ident, cat, desc in indexed) for term in terms}
    ranked = []
    for row, ident, cat, desc in indexed:
        if category and row["category"] != category:
            continue
        skill_file = Path(row["installed"]) / "SKILL.md"
        present = skill_file.is_file()
        if not present and not include_missing:
            continue
        score = sum(math.log(1 + len(rows) / (1 + df[t])) *
                    (8 * (t in ident) + 2 * (t in cat) + (t in desc)) for t in terms)
        if "advanced" not in terms and "advanced" in ident:
            score *= 0.8
        if query.strip().lower() == row["id"].lower():
            score += 100
        score += 30 * len(LANGUAGES & terms & ident)
        if score or not terms:
            ranked.append((score, {
                "id": row["id"], "category": row["category"],
                "description": row["description"][:500], "path": str(skill_file),
                "status": "file-present" if present else "missing",
            }))
    ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [row for _, row in ranked]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?", default="")
    parser.add_argument("--category")
    parser.add_argument("--categories", action="store_true")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--json", action="store_true", help="machine-readable results; no skill bodies loaded")
    parser.add_argument("--include-missing", action="store_true", help="diagnose stale catalog paths")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    args = parser.parse_args()
    if not 1 <= args.limit <= 25 or len(args.query) > 1024:
        parser.error("limit must be 1..25 and query at most 1024 characters")
    try:
        rows = load_catalog(args.catalog)
        categories = sorted({row["category"] for row in rows})
        if args.category and args.category not in categories:
            raise ValueError("Unknown category")
        result = categories if args.categories else search(rows, args.query, args.category, args.include_missing)[:args.limit]
    except (OSError, ValueError, TypeError):
        print("auto-route: cannot search catalog; check schema, paths, and category", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.categories:
        print("\n".join(result))
    else:
        for row in result:
            print(f"{row['id']} [{row['category']}; {row['status']}]\n  {row['description']}\n  {row['path']}")
        if not result:
            print("No matching installed skill. Try different terms, --include-missing, or native capabilities.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
