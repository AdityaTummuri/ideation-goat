from datetime import UTC, datetime

import pytest
import respx

from ideation_goat.fetch import Fetcher
from ideation_goat.models import Source, Vulnerability
from ideation_goat.sources import community, github, osv, papers

ARXIV_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1234.5678v1</id>
    <published>2021-03-04T00:00:00Z</published>
    <title>Cuckoo   Filters
      in Practice</title>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/1234.5678v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1234.5678v1" rel="related" type="application/pdf"/>
  </entry>
  <entry><title></title></entry>
</feed>"""


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("fastapi/fastapi", "fastapi/fastapi"),
        ("https://github.com/pallets/flask", "pallets/flask"),
        ("https://github.com/pallets/flask.git", "pallets/flask"),
        ("github.com/psf/requests/tree/main/src", "psf/requests"),
        ("www.github.com/a-b/c.d_e", "a-b/c.d_e"),
        ("not a repo", None),
        ("owner/..", None),
        ("-bad/name", None),
        ("a/b/c", None),
    ],
)
def test_parse_repo(text: str, expected: str | None) -> None:
    assert github.parse_repo(text) == expected


def test_osv_parse_and_dedupe() -> None:
    data = {
        "id": "PYSEC-2024-1",
        "aliases": ["GHSA-aaaa", "CVE-2024-1"],
        "summary": "Bad thing",
        "affected": [
            {
                "package": {"name": "requests"},
                "ranges": [{"events": [{"introduced": "0"}, {"fixed": "2.32.0"}]}],
            },
            {"package": {"name": "other"}, "ranges": [{"events": [{"fixed": "9.9.9"}]}]},
        ],
        "database_specific": {"severity": "MODERATE"},
    }
    vuln = osv.parse_vulnerability(data, "Requests")
    assert vuln.fixed_in == ["2.32.0"] and vuln.severity == "MODERATE"
    ghsa = Vulnerability(id="GHSA-aaaa", aliases=["PYSEC-2024-1", "CVE-2024-1"], url="u")
    other = Vulnerability(id="GHSA-bbbb", url="u")
    assert [v.id for v in osv.dedupe([vuln, ghsa, other])] == ["GHSA-aaaa", "GHSA-bbbb"]


@pytest.mark.anyio
async def test_osv_sends_versions_in_batch(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    route = mock.post(f"{osv.API}/querybatch").respond(
        200, json={"results": [{"vulns": [{"id": "X-1"}]}, {}]}
    )
    async with fetcher as f:
        ids, source = await osv.query_batch(f, [("pypi", "requests", "2.31.0"), ("npm", "left-pad", "1.3.0")])
    assert ids == [["X-1"], []]
    sent = route.calls[0].request.read().decode()
    assert '"version": "2.31.0"' in sent and '"ecosystem": "PyPI"' in sent
    assert source is not None


def test_arxiv_parse_uses_https_and_collapses_whitespace() -> None:
    [paper] = papers.parse_arxiv(ARXIV_XML)
    assert paper.title == "Cuckoo Filters in Practice"
    assert paper.url == "https://arxiv.org/abs/1234.5678v1"
    assert paper.pdf_url == "https://arxiv.org/pdf/1234.5678v1"
    assert paper.year == 2021 and paper.authors == ["Ada Lovelace", "Alan Turing"]


def test_arxiv_parser_rejects_entity_expansion() -> None:
    bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><feed>&a;</feed>'
    with pytest.raises(Exception):  # noqa: B017 - defusedxml raises its own error type
        papers.parse_arxiv(bomb)


def test_semantic_scholar_parse() -> None:
    source = Source(url="https://api.semanticscholar.org/x", fetched_at=datetime.now(UTC))
    data = {
        "data": [
            {"paperId": "p1", "title": "A", "year": 2020, "citationCount": 12, "externalIds": {"ArXiv": "2001.1"},
             "openAccessPdf": {"url": "https://x/a.pdf"}, "authors": [{"name": "Z"}]},
            {"paperId": "p2", "title": "B", "citationCount": None},
            {"title": "no id"},
        ]
    }  # fmt: skip
    first, second = papers.parse_semantic_scholar(data, source)
    assert first.url == "https://arxiv.org/abs/2001.1" and first.citations.value == 12
    assert first.citations.source is not None
    assert second.citations.value is None and second.url == "https://www.semanticscholar.org/paper/p2"


@pytest.mark.anyio
async def test_scorecard_missing_is_unknown_not_zero(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    mock.get(f"{community.SCORECARD_API}/o/r").respond(404)
    async with fetcher as f:
        signal = await community.scorecard(f, "o/r")
    assert signal.value is None and "not scanned" in (signal.note or "")


@pytest.mark.anyio
async def test_hn_counts_stories_linking_the_repo(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    route = mock.get(community.HN_API).respond(200, json={"nbHits": 7, "hits": []})
    async with fetcher as f:
        signal = await community.hn_stories(f, "o/r")
    assert signal.value == 7 and signal.source is not None
    assert "restrictSearchableAttributes=url" in str(route.calls[0].request.url)


@pytest.mark.anyio
async def test_contributor_count_from_link_header(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    link = '<https://api.github.com/repos/o/r/contributors?per_page=1&page=2>; rel="next", ' \
           '<https://api.github.com/repos/o/r/contributors?per_page=1&page=321>; rel="last"'  # fmt: skip
    mock.get(f"{github.API}/repos/o/r/contributors").respond(200, json=[{}], headers={"link": link})
    mock.get(f"{github.API}/repos/o/one/contributors").respond(200, json=[{}])
    mock.get(f"{github.API}/repos/o/big/contributors").respond(403)
    async with fetcher as f:
        assert (await github.get_contributor_count(f, "o/r"))[0] == 321
        assert (await github.get_contributor_count(f, "o/one"))[0] == 1
        assert (await github.get_contributor_count(f, "o/big")) == (None, None)
