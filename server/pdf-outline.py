#!/usr/bin/env python3
import json
import sys

from pypdf import PdfReader


def walk(items, reader, level=1):
    rows = []
    for item in items:
        if isinstance(item, list):
            rows.extend(walk(item, reader, level + 1))
            continue

        title = str(getattr(item, "title", "") or "").strip()
        if not title:
            continue
        try:
            page = reader.get_destination_page_number(item) + 1
        except Exception:
            page = 1
        rows.append({
            "title": title,
            "page": page,
            "level": max(1, min(4, level)),
            "type": "section",
        })
    return rows


def main():
    if len(sys.argv) < 2:
        print("[]")
        return
    reader = PdfReader(sys.argv[1])
    outline = getattr(reader, "outline", []) or []
    print(json.dumps(walk(outline, reader), ensure_ascii=False))


if __name__ == "__main__":
    main()
