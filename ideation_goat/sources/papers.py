"""arXiv and Semantic Scholar paper search."""

from __future__ import annotations

from typing import Any
from xml.etree.ElementTree import Element  # noqa: S405 - type only; parsing uses defusedxml

from defusedxml import ElementTree

from ideation_goat.cache import DAY
from ideation_goat.fetch import Fetcher
from ideation_goat.models import Paper, Signal, Source

ARXIV_API = "https://export.arxiv.org/api/query"
S2_API = "https://api.semanticscholar.org/graph/v1/paper/search"
_NS = {"atom": "http://www.w3.org/2005/Atom"}


async def search_arxiv(fetch: Fetcher, topic: str, limit: int) -> tuple[list[Paper], Source]:
    response = await fetch.get(
        ARXIV_API,
        params={"search_query": f"all:{topic}", "max_results": limit, "sortBy": "relevance"},
        ttl=DAY,
    )
    if not response.ok:
        raise RuntimeError(f"arXiv returned HTTP {response.status}")
    return parse_arxiv(response.text), response.source


def parse_arxiv(xml_text: str) -> list[Paper]:
    root = ElementTree.fromstring(xml_text)
    papers = []
    for entry in root.findall("atom:entry", _NS):
        title = _text(entry, "atom:title")
        abs_url = _text(entry, "atom:id")
        if not title or not abs_url:
            continue
        pdf_url = None
        for link in entry.findall("atom:link", _NS):
            if link.get("title") == "pdf" or link.get("type") == "application/pdf":
                pdf_url = link.get("href")
        published = _text(entry, "atom:published")
        papers.append(
            Paper(
                title=" ".join(title.split()),
                authors=[_text(a, "atom:name") for a in entry.findall("atom:author", _NS)][:8],
                year=int(published[:4]) if published and published[:4].isdigit() else None,
                url=abs_url.replace("http://", "https://", 1),
                pdf_url=pdf_url.replace("http://", "https://", 1) if pdf_url else None,
                found_in=["arxiv"],
            )
        )
    return papers


def _text(element: Element, path: str) -> str:
    found = element.find(path, _NS)
    return (found.text or "").strip() if found is not None else ""


async def search_semantic_scholar(fetch: Fetcher, topic: str, limit: int) -> tuple[list[Paper], Source]:
    headers = {}
    if fetch.settings.semantic_scholar_api_key:
        headers["x-api-key"] = fetch.settings.semantic_scholar_api_key
    response = await fetch.get(
        S2_API,
        params={
            "query": topic,
            "limit": limit,
            "fields": "title,authors,year,url,externalIds,openAccessPdf,citationCount",
        },
        headers=headers,
        ttl=DAY,
    )
    if not response.ok:
        raise RuntimeError(f"Semantic Scholar returned HTTP {response.status}")
    return parse_semantic_scholar(response.json(), response.source), response.source


def parse_semantic_scholar(data: dict[str, Any], source: Source) -> list[Paper]:
    papers = []
    for item in data.get("data") or []:
        if not item.get("title") or not item.get("paperId"):
            continue
        external = item.get("externalIds") or {}
        url = item.get("url") or f"https://www.semanticscholar.org/paper/{item['paperId']}"
        if external.get("ArXiv"):
            url = f"https://arxiv.org/abs/{external['ArXiv']}"
        citations = item.get("citationCount")
        papers.append(
            Paper(
                title=" ".join(item["title"].split()),
                authors=[a.get("name", "") for a in item.get("authors") or []][:8],
                year=item.get("year"),
                url=url,
                pdf_url=(item.get("openAccessPdf") or {}).get("url") or None,
                citations=Signal(
                    value=citations,
                    source=Source(
                        url=f"https://www.semanticscholar.org/paper/{item['paperId']}",
                        fetched_at=source.fetched_at,
                    ),
                )
                if citations is not None
                else Signal(),
                found_in=["semantic-scholar"],
            )
        )
    return papers
