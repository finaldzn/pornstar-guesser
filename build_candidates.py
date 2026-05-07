#!/usr/bin/env python3
"""
Pre-build candidates.json from Wikidata.

The web game can fetch Wikidata at runtime, but shipping a static
candidates.json removes that round-trip and lets the game work even
if Wikidata is rate-limiting.

Usage:
    python3 build_candidates.py > candidates.json
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SPARQL = """
SELECT ?item ?itemLabel ?image ?gender ?workStart ?birth WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  BIND(wd:Q6581072 AS ?gender)
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
}
ORDER BY DESC(?sl)
LIMIT 1500
"""

GENDER_FEMALE = "Q6581072"
GENDER_MALE = "Q6581097"

ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = (
    "guess-the-pornstar/1.0 "
    "(https://github.com/finaldzn/pornstar-guesser; build_candidates.py)"
)


def fetch_once() -> dict:
    url = ENDPOINT + "?format=json&query=" + urllib.parse.quote(SPARQL)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/sparql-results+json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def fetch(max_attempts: int = 6) -> dict:
    """Wikidata Query Service rate-limits aggressively, and shared CI IPs
    hit it often enough to get the occasional 429. Honor Retry-After when
    present, otherwise back off exponentially."""
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fetch_once()
        except urllib.error.HTTPError as e:
            last = e
            retryable = e.code in (429, 502, 503, 504)
            if not retryable or attempt == max_attempts:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            try:
                wait = int(retry_after) if retry_after else 0
            except ValueError:
                wait = 0
            wait = max(wait, 2 ** attempt)  # 2,4,8,16,32,64
            print(
                f"WDQS returned {e.code}; sleeping {wait}s before "
                f"retry {attempt + 1}/{max_attempts}",
                file=sys.stderr,
            )
            time.sleep(wait)
        except urllib.error.URLError as e:
            # Transient network blip (DNS, reset, timeout) — same backoff.
            last = e
            if attempt == max_attempts:
                raise
            wait = 2 ** attempt
            print(
                f"Network error from WDQS ({e}); sleeping {wait}s before "
                f"retry {attempt + 1}/{max_attempts}",
                file=sys.stderr,
            )
            time.sleep(wait)
    # unreachable; the loop either returns or raises
    raise RuntimeError("fetch retries exhausted") from last


def thumbify(commons_url: str, width: int = 480) -> str:
    u = commons_url.replace("http://", "https://", 1)
    if "Special:FilePath" in u:
        sep = "&" if "?" in u else "?"
        u = f"{u}{sep}width={width}"
    return u


def gender_bucket(gender_url: str) -> str:
    qid = gender_url.rsplit("/", 1)[-1]
    if qid == GENDER_FEMALE:
        return "f"
    if qid == GENDER_MALE:
        return "m"
    return "x"


def year_of(iso: str) -> int | None:
    import re
    m = re.search(r"-?(\d{4})", iso or "")
    return int(m.group(1)) if m else None


def dedupe_by_name(items: list[dict]) -> list[dict]:
    """Drop entries that share a display name with an earlier entry.

    Wikidata occasionally has two QIDs with the same English label
    (different people, same stage name). The earlier entry wins, which
    means the more popular one (we sort by sitelinks descending in SPARQL)
    survives. Deduping at build time guarantees the game can never put
    two identical names on the same 4-button choice card."""
    seen: set[str] = set()
    out: list[dict] = []
    for c in items:
        key = (c.get("name") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def main() -> None:
    data = fetch()
    seen: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "").strip()
        img = b.get("image", {}).get("value", "").strip()
        gender = gender_bucket(b.get("gender", {}).get("value", ""))
        ws = year_of(b.get("workStart", {}).get("value", ""))
        bd = year_of(b.get("birth", {}).get("value", ""))
        if not (qid and name and img):
            continue
        if name == qid:           # SPARQL falls back to QID when no label exists
            continue
        if qid in seen:
            prev = seen[qid]
            if ws and (not prev.get("workStart") or ws < prev["workStart"]):
                prev["workStart"] = ws
            if bd and not prev.get("birth"):
                prev["birth"] = bd
            continue
        seen[qid] = {
            "id": qid, "name": name, "gender": gender,
            "workStart": ws, "birth": bd,
            "image_url": thumbify(img),
        }

    # SPARQL is sorted by sitelinks DESC. dedupe_by_name keeps the first
    # entry per name, so the most-cited survives. Then sort by name for
    # human-readable output.
    deduped = dedupe_by_name(list(seen.values()))
    out = sorted(deduped, key=lambda c: c["name"].lower())
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    raw = len(seen)
    print(f"# {len(out)} candidates ({raw - len(out)} duplicate names dropped)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
