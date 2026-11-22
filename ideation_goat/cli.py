"""Command line. With no arguments it starts the MCP server on stdio, so
``uvx ideation-goat`` works as an MCP server command."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel


def _print(result: BaseModel, as_json: bool, render: Any) -> None:
    print(result.model_dump_json(indent=2) if as_json else render(result))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ideation-goat", description=__doc__)
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="run the MCP server (default)")
    serve.add_argument("--http", action="store_true", help="use Streamable HTTP instead of stdio")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    find = sub.add_parser("find", help="rank libraries for an idea")
    find.add_argument("idea")
    find.add_argument("-l", "--language")
    find.add_argument("-n", "--limit", type=int, default=5)

    compare = sub.add_parser("compare", help="compare 2-5 GitHub repos")
    compare.add_argument("repos", nargs="+")

    verify = sub.add_parser("verify", help="check a package exists and is safe")
    verify.add_argument("name")
    verify.add_argument("-e", "--ecosystem", default="pypi")
    verify.add_argument("-v", "--version")

    check = sub.add_parser("check", help="scan a project's dependencies")
    check.add_argument("path", nargs="?", default=".")

    paper = sub.add_parser("papers", help="find papers on a topic")
    paper.add_argument("topic")
    paper.add_argument("-n", "--limit", type=int, default=8)

    index = sub.add_parser("index", help="build, download or inspect the search index")
    index.add_argument("action", choices=["build", "pull", "info"])
    index.add_argument("--per-language", type=int, default=800)
    index.add_argument("--languages", nargs="+")
    index.add_argument("--pack", type=Path, help="also write a .tar.gz for publishing")

    evaluate = sub.add_parser("eval", help="measure retrieval quality on the labeled query set")
    evaluate.add_argument("--queries", type=Path, default=Path("evals/queries.yaml"))
    evaluate.add_argument("--out", type=Path, help="write the full JSON report here")
    evaluate.add_argument("--baseline", type=Path, help="fail if Recall@5 drops >2 points below this report")

    for p in (find, compare, verify, check, paper):
        p.add_argument("--json", action="store_true", help="print JSON instead of text")

    args = parser.parse_args(argv)
    if args.command in (None, "serve"):
        from ideation_goat.mcp_server import run

        if args.command is None:
            run()
        else:
            run("http" if args.http else "stdio", args.host, args.port)
        return 0

    logging.basicConfig(level=logging.INFO if args.command == "index" else logging.WARNING, stream=sys.stderr)
    from ideation_goat import core, render

    try:
        if args.command == "find":
            _print(
                asyncio.run(core.find_libraries(args.idea, args.language, args.limit)),
                args.json,
                render.render_find,
            )
        elif args.command == "compare":
            _print(asyncio.run(core.compare_libraries(args.repos)), args.json, render.render_compare)
        elif args.command == "verify":
            package = asyncio.run(core.verify_package(args.name, args.ecosystem, args.version))
            _print(package, args.json, render.render_package)
        elif args.command == "check":
            from ideation_goat.config import get_settings

            settings = get_settings().model_copy(update={"workspace_root": Path(args.path).resolve()})
            deps = asyncio.run(core.check_dependencies(".", settings=settings))
            _print(deps, args.json, render.render_dependencies)
        elif args.command == "papers":
            _print(asyncio.run(core.find_papers(args.topic, args.limit)), args.json, render.render_papers)
        elif args.command == "index":
            return _index(args)
        elif args.command == "eval":
            return _eval(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


def _index(args: argparse.Namespace) -> int:
    from ideation_goat.config import get_settings
    from ideation_goat.index_store import download_index, index_present, pack_index
    from ideation_goat.indexer import LANGUAGES, build_index
    from ideation_goat.search import FastEmbedder

    settings = get_settings()
    if args.action == "pull":
        print(f"index downloaded to {download_index(settings)}")
    elif args.action == "info":
        meta_path = settings.index_dir / "meta.json"
        print(
            meta_path.read_text()
            if index_present(settings.index_dir)
            else f"no index at {settings.index_dir}"
        )
    else:
        embedder = FastEmbedder(settings.embedding_model, settings.home / "models")
        index = asyncio.run(build_index(settings, embedder, args.languages or LANGUAGES, args.per_language))
        index.save(settings.index_dir)
        print(f"indexed {len(index.docs)} repos into {settings.index_dir}")
        if args.pack:
            print(f"packed {pack_index(settings.index_dir, args.pack)}")
    return 0


def _eval(args: argparse.Namespace) -> int:
    import json

    from ideation_goat import evaluation
    from ideation_goat.config import get_settings
    from ideation_goat.index_store import get_index

    report = evaluation.evaluate(get_index(get_settings()), evaluation.load_queries(args.queries))
    print(evaluation.to_markdown(report))
    if args.out:
        evaluation.save(report, args.out)
    if args.baseline and args.baseline.is_file():
        problems = evaluation.regression(report, json.loads(args.baseline.read_text()))
        for problem in problems:
            print(f"REGRESSION {problem}", file=sys.stderr)
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
