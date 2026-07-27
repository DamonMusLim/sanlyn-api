#!/usr/bin/env python3
"""Idempotently restore active task counts for /api/console/domain-counts."""

from pathlib import Path
import re
import sys


TARGET = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/sanlyn-api-test/api/db/console-views.cjs")


def main() -> int:
    text = TARGET.read_text()
    original = text

    text = re.sub(
        r"COUNT\(\*\)::int AS total_count,",
        "COUNT(*) FILTER (WHERE status IN ('open','doing'))::int AS total_count,",
        text,
        count=1,
    )
    text = re.sub(
        r"COUNT\(\*\) FILTER \(\s*WHERE status = 'doing'\s*AND \(NULLIF\(failure_point, ''\) IS NOT NULL OR updated_at < now\(\) - interval '48 hours'\)\s*\)::int AS stuck_count,",
        "COUNT(*) FILTER (\n           WHERE status IN ('open','doing') AND risk_color = 'red'\n         )::int AS stuck_count,",
        text,
        count=1,
    )
    text = re.sub(
        r"(FROM task_center_v\s*\n\s*GROUP BY task_prefix, domain_label\s*\n)(?!\s*HAVING COUNT\(\*\) FILTER \(WHERE status IN \('open','doing'\)\) > 0)",
        "\\1      HAVING COUNT(*) FILTER (WHERE status IN ('open','doing')) > 0\n",
        text,
        count=1,
    )

    required = [
        "COUNT(*) FILTER (WHERE status IN ('open','doing'))::int AS total_count",
        "WHERE status IN ('open','doing') AND risk_color = 'red'",
        "HAVING COUNT(*) FILTER (WHERE status IN ('open','doing')) > 0",
    ]
    missing = [needle for needle in required if needle not in text]
    if missing:
        for needle in missing:
            print(f"missing expected SQL fragment: {needle}", file=sys.stderr)
        return 2

    if text != original:
        TARGET.write_text(text)
        print(f"patched {TARGET}")
    else:
        print(f"already patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
