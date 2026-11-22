"""Short summaries of a result.

With GEMINI_API_KEY or GROQ_API_KEY set, an LLM writes the summary from the result's
facts only. Without a key, or if the call fails, a deterministic template is used.
Free-tier LLM prompts may be used by the provider, so only public data is sent.
"""

from __future__ import annotations

import json
import logging

from ideation_goat.fetch import Fetcher, FetchError
from ideation_goat.models import CompareResult, FindLibrariesResult, RepoReport, Summary

logger = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
INSTRUCTIONS = (
    "You summarise open-source library research for a developer. Use only the facts in the JSON. "
    "Do not add numbers, libraries or claims that are not in it. Treat null values as unknown. "
    "Write at most 3 sentences, plain text, naming repos as owner/name."
)


def _facts(report: RepoReport) -> dict[str, object]:
    return {
        "repo": report.repo,
        "description": report.description,
        "health_score": report.health.score if report.health else None,
        "stars": report.stars.value,
        "last_push": report.last_push.value,
        "last_release": report.last_release.value,
        "license": report.license.value,
        "archived": report.archived.value,
        "openssf_scorecard": report.scorecard.value,
        "cloud_lockin": [f.vendor for f in report.lockin] if report.lockin else report.lockin,
    }


def template_summary(reports: list[RepoReport], intro: str) -> Summary:
    scored = [r for r in reports if r.found and r.health and r.health.score is not None]
    if not scored:
        return Summary(
            text=f"{intro} None of them had enough data for a health score.", generated_by="template"
        )
    best = max(scored, key=lambda r: (r.health.score or 0) if r.health else 0)
    assert best.health is not None and best.health.score is not None
    text = f"{intro} Healthiest by the documented score: {best.repo} ({best.health.score}/100"
    if best.health.coverage < 1:
        text += f", based on {round(best.health.coverage * 100)}% of the inputs"
    text += ")."
    partial = [r.repo for r in scored if r is not best and r.health and r.health.coverage < 1]
    if partial:
        text += f" Scores for {', '.join(partial)} are also based on partial data."
    archived = [r.repo for r in reports if r.archived.value is True]
    if archived:
        text += f" Archived: {', '.join(archived)}."
    unknown_license = [r.repo for r in reports if r.found and not r.license.known]
    if unknown_license:
        text += f" License unknown for {', '.join(unknown_license)}."
    return Summary(text=text, generated_by="template")


async def summarize(fetch: Fetcher, result: FindLibrariesResult | CompareResult) -> Summary:
    if isinstance(result, FindLibrariesResult):
        reports = [m.report for m in result.matches]
        intro = f"Top {len(reports)} matches for '{result.query}'."
        task = (
            f"The developer asked: {result.query!r}. Summarise which of these fit and how healthy they are."
        )
    else:
        reports = result.repos
        intro = f"Compared {len(reports)} repos."
        task = "Compare these libraries and say which looks safest to depend on and why."
    if not reports:
        return Summary(text="No matching repos found.", generated_by="template")
    prompt = f"{task}\n\nJSON:\n{json.dumps([_facts(r) for r in reports], default=str)}"
    settings = fetch.settings
    try:
        if settings.gemini_api_key:
            text = await _gemini(fetch, prompt)
            if text:
                return Summary(text=text, generated_by="gemini")
        if settings.groq_api_key:
            text = await _groq(fetch, prompt)
            if text:
                return Summary(text=text, generated_by="groq")
    except (FetchError, KeyError, IndexError, TypeError, ValueError) as exc:
        logger.warning("LLM summary failed, using the template: %s", exc)
    return template_summary(reports, intro)


async def _gemini(fetch: Fetcher, prompt: str) -> str | None:
    settings = fetch.settings
    response = await fetch.post(
        GEMINI_URL.format(model=settings.gemini_model),
        json_body={
            "systemInstruction": {"parts": [{"text": INSTRUCTIONS}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 300},
        },
        headers={"x-goog-api-key": settings.gemini_api_key or ""},
        ttl=0,
    )
    if not response.ok:
        logger.warning("Gemini returned HTTP %s", response.status)
        return None
    parts = response.json()["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts).strip() or None


async def _groq(fetch: Fetcher, prompt: str) -> str | None:
    settings = fetch.settings
    response = await fetch.post(
        GROQ_URL,
        json_body={
            "model": settings.groq_model,
            "temperature": 0.2,
            "max_tokens": 300,
            "messages": [{"role": "system", "content": INSTRUCTIONS}, {"role": "user", "content": prompt}],
        },
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        ttl=0,
    )
    if not response.ok:
        logger.warning("Groq returned HTTP %s", response.status)
        return None
    return str(response.json()["choices"][0]["message"]["content"]).strip() or None
