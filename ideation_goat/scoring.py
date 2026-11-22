"""One documented health score for a GitHub repo.

| Part        | Max | Input                                   |
|-------------|-----|-----------------------------------------|
| Maintenance |  30 | days since the last push                |
| Releases    |  15 | days since the latest GitHub release    |
| Community   |  15 | number of contributors                  |
| Adoption    |  15 | stars, log scale (15 at 50,000)         |
| Security    |  25 | OpenSSF Scorecard (0-10) x 2.5          |

Unknown inputs are left out and the score is rescaled over the known parts.
With under half the weight known, there is no score. Archived repos are capped at 20.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from ideation_goat.models import HealthScore, RepoReport, ScorePart

MIN_COVERAGE = 0.5
ARCHIVED_CAP = 20


def _days_since(iso: object, now: datetime) -> int | None:
    if not isinstance(iso, str) or not iso:
        return None
    try:
        when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0, (now - when).days)


def _step(value: float, steps: list[tuple[float, float]], floor: float) -> float:
    """Return the points of the first step whose threshold ``value`` is within."""
    for threshold, points in steps:
        if value <= threshold:
            return points
    return floor


def maintenance(report: RepoReport, now: datetime) -> ScorePart:
    days = _days_since(report.last_push.value, now)
    if days is None:
        return ScorePart(name="Maintenance", points=None, max_points=30, reason="last push unknown")
    points = _step(days, [(30, 30), (90, 24), (180, 15), (365, 6)], 0)
    return ScorePart(name="Maintenance", points=points, max_points=30, reason=f"last push {days} days ago")


def releases(report: RepoReport, now: datetime) -> ScorePart:
    days = _days_since(report.last_release.value, now)
    if days is None:
        return ScorePart(name="Releases", points=None, max_points=15, reason="no GitHub release found")
    points = _step(days, [(90, 15), (180, 11), (365, 6)], 2)
    return ScorePart(name="Releases", points=points, max_points=15, reason=f"latest release {days} days ago")


def community(report: RepoReport) -> ScorePart:
    count = report.contributors.value
    if not isinstance(count, int):
        return ScorePart(name="Community", points=None, max_points=15, reason="contributor count unknown")
    points = 15 if count >= 100 else 12 if count >= 30 else 8 if count >= 10 else 4 if count >= 3 else 1
    return ScorePart(name="Community", points=points, max_points=15, reason=f"{count} contributors")


def adoption(report: RepoReport) -> ScorePart:
    stars = report.stars.value
    if not isinstance(stars, int):
        return ScorePart(name="Adoption", points=None, max_points=15, reason="star count unknown")
    points = round(15 * min(1.0, math.log10(max(stars, 1)) / math.log10(50_000)), 1)
    return ScorePart(name="Adoption", points=points, max_points=15, reason=f"{stars:,} stars")


def security(report: RepoReport) -> ScorePart:
    score = report.scorecard.value
    if not isinstance(score, int | float) or isinstance(score, bool):
        return ScorePart(
            name="Security", points=None, max_points=25, reason=report.scorecard.note or "unknown"
        )
    return ScorePart(
        name="Security",
        points=round(float(score) * 2.5, 1),
        max_points=25,
        reason=f"OpenSSF Scorecard {score}/10",
    )


def health_score(report: RepoReport, now: datetime | None = None) -> HealthScore:
    now = now or datetime.now(UTC)
    parts = [
        maintenance(report, now),
        releases(report, now),
        community(report),
        adoption(report),
        security(report),
    ]
    known = [p for p in parts if p.points is not None]
    known_weight = sum(p.max_points for p in known)
    coverage = round(known_weight / sum(p.max_points for p in parts), 2)
    flags: list[str] = []
    if coverage < MIN_COVERAGE:
        return HealthScore(score=None, coverage=coverage, parts=parts, flags=["not enough data for a score"])
    score = round(100 * sum(p.points or 0 for p in known) / known_weight)
    if report.archived.value is True:
        score = min(score, ARCHIVED_CAP)
        flags.append("archived: read-only, no further maintenance")
    return HealthScore(score=score, coverage=coverage, parts=parts, flags=flags)
