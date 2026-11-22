from datetime import UTC, datetime, timedelta

from ideation_goat.models import RepoReport, Signal
from ideation_goat.scoring import health_score

NOW = datetime(2026, 11, 23, tzinfo=UTC)


def days_ago(days: int) -> str:
    return (NOW - timedelta(days=days)).isoformat().replace("+00:00", "Z")


def report(**signals: object) -> RepoReport:
    defaults: dict[str, object] = {
        "last_push": days_ago(5),
        "last_release": days_ago(30),
        "contributors": 150,
        "stars": 50_000,
        "scorecard": 8.0,
        "archived": False,
    }
    defaults.update(signals)
    return RepoReport(
        repo="o/r",
        url="https://github.com/o/r",
        **{k: Signal(value=v) for k, v in defaults.items()},  # type: ignore[arg-type]
    )


def test_full_data_scores_each_part() -> None:
    result = health_score(report(), now=NOW)
    points = {p.name: p.points for p in result.parts}
    assert points == {"Maintenance": 30, "Releases": 15, "Community": 15, "Adoption": 15.0, "Security": 20.0}
    assert result.score == 95
    assert result.coverage == 1.0


def test_unknown_signal_is_excluded_and_rescaled() -> None:
    result = health_score(report(scorecard=None), now=NOW)
    assert result.coverage == 0.75
    assert result.score == 100  # 75 of 75 known points
    security = next(p for p in result.parts if p.name == "Security")
    assert security.points is None


def test_too_little_data_gives_no_score() -> None:
    result = health_score(report(scorecard=None, last_push=None, last_release=None), now=NOW)
    assert result.score is None
    assert result.coverage == 0.3


def test_stale_repo_scores_low_and_archived_is_capped() -> None:
    stale = health_score(report(last_push=days_ago(400), last_release=days_ago(800)), now=NOW)
    assert next(p for p in stale.parts if p.name == "Maintenance").points == 0
    assert next(p for p in stale.parts if p.name == "Releases").points == 2
    archived = health_score(report(archived=True), now=NOW)
    assert archived.score == 20
    assert archived.flags


def test_step_boundaries() -> None:
    assert next(p for p in health_score(report(last_push=days_ago(30)), now=NOW).parts).points == 30
    assert next(p for p in health_score(report(last_push=days_ago(31)), now=NOW).parts).points == 24
    community = next(p for p in health_score(report(contributors=2), now=NOW).parts if p.name == "Community")
    assert community.points == 1


def test_unparseable_date_is_unknown() -> None:
    result = health_score(report(last_push="not-a-date"), now=NOW)
    assert next(p for p in result.parts if p.name == "Maintenance").points is None
