#!/usr/bin/env python3
"""
Pre-build candidates.json from Wikidata + Wikipedia.

Two-stage source:

  Stage 1 — Wikidata SPARQL: female adult-film performers
            (P106 = Q488111, P21 = Q6581072) that already have a P18
            image attached. ~1100 entries.

  Stage 2 — Wikidata SPARQL again, this time for the same population
            *without* a P18 image but with an English Wikipedia article.
            We then call the Wikipedia REST `summary` endpoint in
            parallel, parse out the page image, and attach it as
            image_url. Adds several hundred more entries that were
            previously invisible to the game.

The output JSON shape is unchanged — every entry is
{id, name, gender, workStart, birth, image_url}.

Usage:
    python3 build_candidates.py > candidates.json
"""

from __future__ import annotations

import concurrent.futures
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---- SPARQL --------------------------------------------------------------

SPARQL_PRIMARY = """
SELECT ?item ?itemLabel ?image ?workStart ?birth WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
}
ORDER BY DESC(?sl)
LIMIT 1500
"""

# Same population, without an image on Wikidata but linked to an English
# Wikipedia article — Wikipedia's pageimages cover many performers Wikidata
# doesn't.
SPARQL_NO_IMAGE = """
SELECT ?item ?itemLabel ?article ?workStart ?birth WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  FILTER NOT EXISTS { ?item wdt:P18 ?_img }
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
}
ORDER BY DESC(?sl)
LIMIT 1500
"""

WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIPEDIA_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"

USER_AGENT = (
    "guess-the-pornstar/1.1 "
    "(https://github.com/finaldzn/pornstar-guesser; build_candidates.py)"
)

BACKFILL_CAP        = 1200    # cap Wikipedia REST hits per build
BACKFILL_WORKERS    = 8       # parallel Wikipedia fetches
SPARQL_TIMEOUT_S    = 90
WIKIPEDIA_TIMEOUT_S = 15

# ---- HTTP helpers --------------------------------------------------------

def _request(url: str, timeout: int) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_with_retry(url: str, timeout: int, max_attempts: int = 6) -> dict:
    """Wikidata + Wikipedia both rate-limit shared CI IPs occasionally."""
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return _request(url, timeout)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 502, 503, 504) and attempt < max_attempts:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                wait = 0
                try:
                    wait = int(retry_after) if retry_after else 0
                except ValueError:
                    pass
                wait = max(wait, 2 ** attempt)
                print(
                    f"  HTTP {e.code}; sleeping {wait}s "
                    f"(attempt {attempt}/{max_attempts})",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError as e:
            last = e
            if attempt < max_attempts:
                wait = 2 ** attempt
                print(
                    f"  network error: {e}; sleeping {wait}s "
                    f"(attempt {attempt}/{max_attempts})",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            raise
    raise RuntimeError("retries exhausted") from last


def fetch_sparql(query: str) -> dict:
    url = WIKIDATA_ENDPOINT + "?format=json&query=" + urllib.parse.quote(query)
    return fetch_with_retry(url, timeout=SPARQL_TIMEOUT_S)

# ---- Parsing helpers -----------------------------------------------------

def year_of(iso: str) -> int | None:
    m = re.search(r"-?(\d{4})", iso or "")
    return int(m.group(1)) if m else None


def thumbify(url: str, width: int = 480) -> str:
    """Normalize the various image URL shapes we collect into a sized
    thumbnail URL when possible. Wikipedia thumbnails encode the width
    inside the path (`/320px-File.jpg`); we just rewrite to the target."""
    u = url.replace("http://", "https://", 1)
    if "Special:FilePath" in u:
        sep = "&" if "?" in u else "?"
        return f"{u}{sep}width={width}"
    if "/thumb/" in u:
        return re.sub(r"/(\d+)px-", f"/{width}px-", u)
    return u


def _merge_dates(prev: dict, ws: int | None, bd: int | None) -> None:
    if ws and (not prev.get("workStart") or ws < prev["workStart"]):
        prev["workStart"] = ws
    if bd and not prev.get("birth"):
        prev["birth"] = bd


def parse_primary(data: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "").strip()
        img = b.get("image", {}).get("value", "").strip()
        ws = year_of(b.get("workStart", {}).get("value", ""))
        bd = year_of(b.get("birth", {}).get("value", ""))
        if not (qid and name and img):
            continue
        if name == qid:           # SPARQL falls back to the QID when no label
            continue
        if qid in seen:
            _merge_dates(seen[qid], ws, bd)
            continue
        seen[qid] = {
            "id": qid, "name": name, "gender": "f",
            "workStart": ws, "birth": bd,
            "image_url": thumbify(img),
        }
    return list(seen.values())


def parse_no_image(data: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "").strip()
        article = b.get("article", {}).get("value", "")
        ws = year_of(b.get("workStart", {}).get("value", ""))
        bd = year_of(b.get("birth", {}).get("value", ""))
        if not (qid and name and article):
            continue
        if name == qid:
            continue
        if qid in seen:
            _merge_dates(seen[qid], ws, bd)
            continue
        seen[qid] = {
            "id": qid, "name": name, "gender": "f",
            "workStart": ws, "birth": bd,
            "_article": article,
        }
    return list(seen.values())

# ---- Wikipedia summary lookups ------------------------------------------

def wikipedia_image(article_url: str) -> str | None:
    """Fetch Wikipedia's REST summary for the article URL, return the
    largest available image (originalimage > thumbnail), or None."""
    title = article_url.rsplit("/wiki/", 1)[-1]
    title = urllib.parse.unquote(title)
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe=":/()")
    url = WIKIPEDIA_SUMMARY + encoded
    try:
        data = _request(url, timeout=WIKIPEDIA_TIMEOUT_S)
    except Exception:
        return None
    orig = (data.get("originalimage") or {}).get("source")
    thumb = (data.get("thumbnail") or {}).get("source")
    return orig or thumb


def backfill_images(entries: list[dict]) -> list[dict]:
    """Take entries that have _article set, fetch a Wikipedia thumbnail
    for each, return the subset that got an image (with image_url filled)."""
    pool_in = entries[:BACKFILL_CAP]
    out: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=BACKFILL_WORKERS) as ex:
        futures = {ex.submit(wikipedia_image, e["_article"]): e for e in pool_in}
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            e = futures[fut]
            done += 1
            if done % 100 == 0:
                print(f"  Wikipedia backfill: {done}/{len(pool_in)}",
                      file=sys.stderr)
            img = fut.result()
            if not img:
                continue
            e["image_url"] = thumbify(img)
            e.pop("_article", None)
            out.append(e)
    return out

# ---- Dedupe -------------------------------------------------------------

def dedupe_by_name(items: list[dict]) -> list[dict]:
    """Drop entries that share a display name with an earlier entry.

    Wikidata occasionally has two QIDs with the same English label; the
    primary stage is sorted by sitelinks DESC so the more popular one
    wins. Then we add Wikipedia-backfilled entries — these only land if
    their name doesn't collide with an existing primary entry."""
    seen: set[str] = set()
    out: list[dict] = []
    for c in items:
        key = (c.get("name") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out

# ---- Main ----------------------------------------------------------------

def main() -> None:
    print("Stage 1: SPARQL — performers with a Wikidata P18 image",
          file=sys.stderr)
    primary = parse_primary(fetch_sparql(SPARQL_PRIMARY))
    print(f"  -> {len(primary)} entries", file=sys.stderr)

    print("Stage 2: SPARQL — performers without P18 but with English Wikipedia",
          file=sys.stderr)
    candidates_for_backfill = parse_no_image(fetch_sparql(SPARQL_NO_IMAGE))
    print(f"  -> {len(candidates_for_backfill)} candidates to try",
          file=sys.stderr)

    print("Stage 3: Wikipedia REST summaries — fetching thumbnails",
          file=sys.stderr)
    backfilled = backfill_images(candidates_for_backfill)
    print(f"  -> {len(backfilled)} got an image", file=sys.stderr)

    combined = primary + backfilled
    deduped = dedupe_by_name(combined)
    out = sorted(deduped, key=lambda c: c["name"].lower())
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")

    dropped = len(combined) - len(deduped)
    print(
        f"# {len(out)} candidates "
        f"({len(primary)} from Wikidata P18 + {len(backfilled)} from Wikipedia, "
        f"{dropped} duplicate names dropped)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
