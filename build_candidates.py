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
import urllib.parse
import urllib.request

SPARQL = """
SELECT ?item ?itemLabel ?image ?gender WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 ?gender .
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
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


def fetch() -> dict:
    url = ENDPOINT + "?format=json&query=" + urllib.parse.quote(SPARQL)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/sparql-results+json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


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


def main() -> None:
    data = fetch()
    seen: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        qid = b.get("item", {}).get("value", "").rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "").strip()
        img = b.get("image", {}).get("value", "").strip()
        gender = gender_bucket(b.get("gender", {}).get("value", ""))
        if not (qid and name and img):
            continue
        if name == qid:           # SPARQL falls back to QID when no label exists
            continue
        if qid in seen:
            continue
        seen[qid] = {"id": qid, "name": name, "gender": gender, "image_url": thumbify(img)}

    out = sorted(seen.values(), key=lambda c: c["name"].lower())
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    print(f"# {len(out)} candidates", file=sys.stderr)


if __name__ == "__main__":
    main()
