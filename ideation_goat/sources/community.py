"""OpenSSF Scorecard and Hacker News (Algolia) signals for a GitHub repo."""

from __future__ import annotations

from urllib.parse import urlencode

from ideation_goat.cache import DAY
from ideation_goat.fetch import Fetcher
from ideation_goat.models import Signal, Source

SCORECARD_API = "https://api.securityscorecards.dev/projects/github.com"
HN_API = "https://hn.algolia.com/api/v1/search"


async def scorecard(fetch: Fetcher, repo: str) -> Signal:
    response = await fetch.get(f"{SCORECARD_API}/{repo}", ttl=DAY)
    if response.status == 404:
        return Signal(note="not scanned by OpenSSF Scorecard")
    if not response.ok:
        return Signal(note=f"Scorecard API returned HTTP {response.status}")
    data = response.json()
    viewer = f"https://scorecard.dev/viewer/?uri=github.com/{repo}"
    return Signal(
        value=data.get("score"),
        source=Source(url=viewer, fetched_at=response.fetched_at),
        note=f"scan dated {data.get('date', 'unknown')}",
    )


async def hn_stories(fetch: Fetcher, repo: str) -> Signal:
    """Count HN stories whose link points at the repo."""
    params = {"query": f"github.com/{repo}", "tags": "story", "restrictSearchableAttributes": "url"}
    response = await fetch.get(HN_API, params={**params, "hitsPerPage": 0}, ttl=DAY)
    if not response.ok:
        return Signal(note=f"HN search returned HTTP {response.status}")
    page = "https://hn.algolia.com/?" + urlencode({"query": f"github.com/{repo}", "type": "story"})
    return Signal(
        value=int(response.json().get("nbHits", 0)),
        source=Source(url=page, fetched_at=response.fetched_at),
        note="stories linking to the repo",
    )
