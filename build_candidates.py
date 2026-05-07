#!/usr/bin/env python3
"""
Pre-build candidates.json from Wikidata + Wikipedia.

Four-stage source — each one strictly grows coverage:

  Stage 1 — Wikidata SPARQL: female adult-film performers
            (P106 = Q488111, P21 = Q6581072) that already have a P18
            image attached.

  Stage 2 — Wikidata SPARQL again, same population without P18 but
            linked to an English Wikipedia article.

  Stage 3 — Wikipedia REST `summary` endpoint, called in parallel for
            stage 2 entries, to pull the page image.

  Stage 4 — Wikipedia categories: walk
            "Category:Pornographic film actresses by nationality"
            (~40 nationality subcategories) and the root
            "Category:Pornographic film actresses". MediaWiki API
            (action=query, prop=pageprops|pageimages) gives us each
            member's Wikidata QID + page image in batched calls.
            Surfaces performers Wikipedia has categorized but Wikidata
            hasn't yet tagged with P106=Q488111.

  Stage 5 — OnlyFans tag: SPARQL for female entries that have an
            OnlyFans username on Wikidata (P10934). The QIDs are
            cross-referenced against the merged candidate list and
            an `onlyfans: true` flag is added in place — no new
            entries are introduced (we want "people we already have
            who also have an OnlyFans"). The game uses this flag for
            the OnlyFans category.

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
SELECT ?item ?itemLabel ?image ?workStart ?birth ?country WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  OPTIONAL { ?item wdt:P27 ?country . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
}
ORDER BY DESC(?sl)
LIMIT 1500
"""

# Same population, without an image on Wikidata but linked to an English
# Wikipedia article — Wikipedia's pageimages cover many performers Wikidata
# doesn't.
SPARQL_NO_IMAGE = """
SELECT ?item ?itemLabel ?article ?workStart ?birth ?country WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  FILTER NOT EXISTS { ?item wdt:P18 ?_img }
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  OPTIONAL { ?item wdt:P27 ?country . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
}
ORDER BY DESC(?sl)
LIMIT 1500
"""

# Female entries on Wikidata that have an OnlyFans username (P10934).
# We don't filter to Q488111 here — many people with an OnlyFans aren't
# tagged as adult performers on Wikidata. We only use these QIDs to add
# an `onlyfans: true` flag to entries we already have from stages 1-4;
# entries unique to this query are discarded (no image / no context).
SPARQL_ONLYFANS = """
SELECT ?item WHERE {
  ?item wdt:P10934 ?onlyfans .
  ?item wdt:P21 wd:Q6581072 .
}
LIMIT 5000
"""

# Wikipedia category names start with a nationality demonym; map the most
# common ones to their Wikidata country QID so we can tag stage 4 entries
# even when Wikidata's P27 is missing. Extend freely.
NATIONALITY_TO_COUNTRY = {
    "American":   "Q30",
    "Australian": "Q408",
    "Austrian":   "Q40",
    "Belgian":    "Q31",
    "Brazilian":  "Q155",
    "British":    "Q145",
    "Canadian":   "Q16",
    "Chinese":    "Q148",
    "Colombian":  "Q739",
    "Croatian":   "Q224",
    "Cuban":      "Q241",
    "Czech":      "Q213",
    "Dutch":      "Q55",
    "Estonian":   "Q191",
    "Finnish":    "Q33",
    "French":     "Q142",
    "German":     "Q183",
    "Greek":      "Q41",
    "Hungarian":  "Q28",
    "Indian":     "Q668",
    "Irish":      "Q22",
    "Israeli":    "Q801",
    "Italian":    "Q38",
    "Japanese":   "Q17",
    "Latvian":    "Q211",
    "Lithuanian": "Q37",
    "Mexican":    "Q96",
    "Polish":     "Q36",
    "Portuguese": "Q45",
    "Romanian":   "Q218",
    "Russian":    "Q159",
    "Serbian":    "Q403",
    "Slovak":     "Q214",
    "Spanish":    "Q29",
    "Swedish":    "Q34",
    "Swiss":      "Q39",
    "Ukrainian":  "Q212",
    "Venezuelan": "Q717",
}

WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIPEDIA_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
WIKIPEDIA_API     = "https://en.wikipedia.org/w/api.php"

USER_AGENT = (
    "guess-the-pornstar/1.2 "
    "(https://github.com/finaldzn/pornstar-guesser; build_candidates.py)"
)

BACKFILL_CAP        = 1200    # cap Wikipedia REST hits per build
BACKFILL_WORKERS    = 8       # parallel Wikipedia fetches
SPARQL_TIMEOUT_S    = 90
WIKIPEDIA_TIMEOUT_S = 30

# Wikipedia category seeds for stage 4. The first one is a parent that
# we walk to enumerate per-nationality subcategories; the rest are
# directly enumerated as page lists.
PARENT_CATEGORY = "Pornographic film actresses by nationality"
ROOT_CATEGORIES = [
    "Pornographic film actresses",
    "American pornographic film actresses",  # belt + braces; usually the largest
]

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


def _qid_from_uri(uri: str) -> str | None:
    if not uri:
        return None
    qid = uri.rsplit("/", 1)[-1]
    return qid if qid.startswith("Q") else None


def parse_primary(data: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "").strip()
        img = b.get("image", {}).get("value", "").strip()
        ws = year_of(b.get("workStart", {}).get("value", ""))
        bd = year_of(b.get("birth", {}).get("value", ""))
        country = _qid_from_uri(b.get("country", {}).get("value", ""))
        if not (qid and name and img):
            continue
        if name == qid:           # SPARQL falls back to the QID when no label
            continue
        if qid in seen:
            _merge_dates(seen[qid], ws, bd)
            if country and not seen[qid].get("country"):
                seen[qid]["country"] = country
            continue
        seen[qid] = {
            "id": qid, "name": name, "gender": "f",
            "workStart": ws, "birth": bd, "country": country,
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
        country = _qid_from_uri(b.get("country", {}).get("value", ""))
        if not (qid and name and article):
            continue
        if name == qid:
            continue
        if qid in seen:
            _merge_dates(seen[qid], ws, bd)
            if country and not seen[qid].get("country"):
                seen[qid]["country"] = country
            continue
        seen[qid] = {
            "id": qid, "name": name, "gender": "f",
            "workStart": ws, "birth": bd, "country": country,
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

# ---- Wikipedia category enumeration -------------------------------------

def _wp_api(params: dict) -> dict:
    qs = "&".join(
        f"{k}={urllib.parse.quote(str(v), safe='|:/')}"
        for k, v in params.items()
    )
    return fetch_with_retry(f"{WIKIPEDIA_API}?{qs}", timeout=WIKIPEDIA_TIMEOUT_S)


def fetch_subcategories(category: str) -> list[str]:
    """Return a list of subcategory titles (without the 'Category:' prefix)."""
    out: list[str] = []
    cont: dict[str, str] = {}
    while True:
        params = {
            "action": "query", "format": "json",
            "list": "categorymembers",
            "cmtitle": f"Category:{category.replace(' ', '_')}",
            "cmtype": "subcat",
            "cmlimit": 500,
            **cont,
        }
        data = _wp_api(params)
        for m in data.get("query", {}).get("categorymembers", []):
            t = m.get("title", "")
            if t.startswith("Category:"):
                out.append(t.split("Category:", 1)[-1])
        cont = data.get("continue") or {}
        if not cont:
            break
    return out


def fetch_category_pages(category: str) -> list[str]:
    """Return article titles (mainspace pages) in a Wikipedia category."""
    out: list[str] = []
    cont: dict[str, str] = {}
    while True:
        params = {
            "action": "query", "format": "json",
            "list": "categorymembers",
            "cmtitle": f"Category:{category.replace(' ', '_')}",
            "cmtype": "page",
            "cmnamespace": 0,
            "cmlimit": 500,
            **cont,
        }
        data = _wp_api(params)
        for m in data.get("query", {}).get("categorymembers", []):
            t = m.get("title", "")
            if t and not t.startswith(("List of ", "Lists of ")):
                out.append(t)
        cont = data.get("continue") or {}
        if not cont:
            break
    return out


def fetch_pages_metadata(titles: list[str],
                         country_by_title: dict[str, str] | None = None,
                         ) -> list[dict]:
    """Batch-fetch Wikidata QID + page image for up to 50 titles per call.

    `country_by_title` (optional) tags each result with the QID of the
    country we inferred from the originating Wikipedia subcategory."""
    country_by_title = country_by_title or {}
    out: list[dict] = []
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        params = {
            "action": "query", "format": "json",
            "prop": "pageprops|pageimages",
            "ppprop": "wikibase_item",
            "pithumbsize": 480,
            "piprop": "thumbnail|original|name",
            "titles": "|".join(batch),
        }
        try:
            data = _wp_api(params)
        except Exception as e:
            print(f"  Wikipedia metadata batch failed: {e}", file=sys.stderr)
            continue
        for p in (data.get("query", {}).get("pages") or {}).values():
            if "missing" in p:
                continue
            qid = (p.get("pageprops") or {}).get("wikibase_item")
            if not qid:
                # No Wikidata link — we'd have no stable id to merge with the
                # SPARQL stages. Skip; almost all real performers have a QID.
                continue
            thumb = (p.get("thumbnail") or {}).get("source")
            orig = (p.get("original") or {}).get("source")
            img = thumb or orig
            if not img:
                continue
            title = (p.get("title") or "").strip()
            out.append({
                "id": qid, "name": title, "gender": "f",
                "workStart": None, "birth": None,
                "country": country_by_title.get(title),
                "image_url": thumbify(img),
            })
    return out


def _country_for_subcat(subcat: str) -> str | None:
    """Map e.g. 'French pornographic film actresses' -> 'Q142'."""
    head = subcat.split(" ", 1)[0] if subcat else ""
    return NATIONALITY_TO_COUNTRY.get(head)


def fetch_onlyfans_qids() -> set[str]:
    """Return QIDs of female people on Wikidata with an OnlyFans username
    (P10934). We use this only to set an `onlyfans: true` flag on entries
    we already have — never to introduce new entries."""
    try:
        data = fetch_sparql(SPARQL_ONLYFANS)
    except Exception as e:
        print(f"  OnlyFans SPARQL failed: {e}", file=sys.stderr)
        return set()
    out: set[str] = set()
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        if qid.startswith("Q"):
            out.add(qid)
    return out


def stage4_categories() -> list[dict]:
    """Walk the nationality subcategories of the parent category, plus a
    couple of root categories, and pull Wikidata QID + image for every
    page member. Tag each entry with the country we inferred from the
    originating subcategory's demonym (when known)."""
    country_by_title: dict[str, str] = {}

    # Per-nationality subcategories under the parent
    try:
        subcats = fetch_subcategories(PARENT_CATEGORY)
        print(f"  {len(subcats)} nationality subcategories of "
              f"'{PARENT_CATEGORY}'", file=sys.stderr)
    except Exception as e:
        print(f"  failed to enumerate subcategories of "
              f"'{PARENT_CATEGORY}': {e}", file=sys.stderr)
        subcats = []

    for subcat in subcats:
        country = _country_for_subcat(subcat)
        try:
            members = fetch_category_pages(subcat)
        except Exception as e:
            print(f"  '{subcat}' failed: {e}", file=sys.stderr)
            continue
        for title in members:
            # First write wins so a more specific category (the one that
            # actually identified the country) sticks even if the page
            # also lives in the un-nationality-tagged root category.
            country_by_title.setdefault(title, country)

    for cat in ROOT_CATEGORIES:
        try:
            members = fetch_category_pages(cat)
        except Exception as e:
            print(f"  '{cat}' failed: {e}", file=sys.stderr)
            continue
        for title in members:
            country_by_title.setdefault(title, None)

    print(f"  {len(country_by_title)} unique pages across "
          f"{len(subcats) + len(ROOT_CATEGORIES)} categories",
          file=sys.stderr)

    # Filter the obvious non-person pages defensively
    skip = ("List ", "Lists ", "Category:", "Category ")
    filtered = sorted(t for t in country_by_title if not t.startswith(skip))

    pages = fetch_pages_metadata(filtered, country_by_title=country_by_title)
    return pages

# ---- Dedupe -------------------------------------------------------------

def merge_by_name(items: list[dict]) -> list[dict]:
    """Dedupe by display name. The first entry per name wins, but later
    entries can fill in missing fields (country in particular — Wikidata
    P27 may be unset on the primary entry while the Wikipedia category
    derivation knows the nationality)."""
    by_key: dict[str, dict] = {}
    order: list[str] = []
    for c in items:
        key = (c.get("name") or "").strip().lower()
        if not key:
            continue
        if key not in by_key:
            by_key[key] = c
            order.append(key)
            continue
        prev = by_key[key]
        for fld in ("country", "workStart", "birth"):
            if not prev.get(fld) and c.get(fld):
                prev[fld] = c[fld]
    return [by_key[k] for k in order]

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

    print("Stage 4: Wikipedia categories — broader coverage", file=sys.stderr)
    cat_entries = stage4_categories()
    print(f"  -> {len(cat_entries)} entries with QID + image", file=sys.stderr)

    combined = primary + backfilled + cat_entries
    deduped = merge_by_name(combined)

    print("Stage 5: OnlyFans tagging via Wikidata P10934", file=sys.stderr)
    of_qids = fetch_onlyfans_qids()
    print(f"  -> {len(of_qids)} QIDs with an OnlyFans username on Wikidata",
          file=sys.stderr)
    of_count = 0
    for c in deduped:
        if c.get("id") in of_qids:
            c["onlyfans"] = True
            of_count += 1
    print(f"  -> {of_count}/{len(deduped)} entries tagged as OnlyFans",
          file=sys.stderr)

    out = sorted(deduped, key=lambda c: c["name"].lower())
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")

    dropped = len(combined) - len(deduped)
    french = sum(1 for c in deduped if c.get("country") == "Q142")
    print(
        f"# {len(out)} candidates "
        f"({len(primary)} P18 + {len(backfilled)} Wikipedia REST + "
        f"{len(cat_entries)} Wikipedia categories, "
        f"{dropped} duplicate names dropped, "
        f"{french} tagged as French, "
        f"{of_count} tagged as OnlyFans)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
