"""Daily pipeline, Phase 0: collect -> dedup -> prefilter -> LLM ensemble -> event scores.

    python -m stockai.pipeline --config config/config.yaml
    python -m stockai.pipeline --config config/config.example.yaml --fake   # no API keys, no network LLM
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
from collections import Counter

import yaml

from .harness.budget import BudgetExceeded, CostTracker
from .harness.cache import Cache
from .harness.structured import StructuredCaller
from .llm.factory import build_provider
from .llm.fake import FakeProvider
from .signals.aggregate import ScoredEvent, event_scores
from .signals.extractor import EventExtractor, ExtractionContext
from .signals.prefilter import Watchlist, dedup
from .signals.prompts import EVENT_PROMPT_VERSION
from .signals.sources.rss import RSSSource
from .store import Store

log = logging.getLogger("stockai")


def _fake_member(name: str) -> FakeProvider:
    # Always answers "irrelevant": lets the plumbing be exercised end-to-end for free.
    return FakeProvider(name, [json.dumps({"relevant": False, "tickers": [], "event_type": "none",
                                           "direction": 0, "materiality": 0, "horizon": "days",
                                           "confidence": 0.5, "evidence": [], "rationale": "fake"})])


def run(cfg: dict, *, fake: bool = False) -> dict:
    data_dir = cfg.get("data_dir", "data")
    os.makedirs(data_dir, exist_ok=True)
    db = os.path.join(data_dir, "stockai.sqlite")

    h = cfg.get("harness", {})
    budget = CostTracker({m: tuple(p) for m, p in cfg.get("pricing", {}).items()},
                         daily_limit_usd=h.get("daily_budget_usd", 0.5), db_path=db)
    caller = StructuredCaller(cache=Cache(db), budget=budget, max_retries=h.get("max_retries", 2))
    if fake:
        members, escalation = [_fake_member("fake-a"), _fake_member("fake-b")], None
    else:
        members = [build_provider(s) for s in cfg["models"]["tier1"]]
        escalation = build_provider(cfg["models"]["tier2"]) if cfg["models"].get("tier2") else None
    extractor = EventExtractor(caller, members, quorum=h.get("quorum", 2), escalation=escalation)
    store = Store(db)
    watch = Watchlist(cfg["watchlist"])
    priority = set(cfg.get("holdings", []))

    # 1) collect
    docs = []
    for s in cfg.get("sources", []):
        src = RSSSource(s["name"], s["url"], s.get("weight", 1.0))
        try:
            got = src.fetch()
            log.info("collected %d from %s", len(got), src.name)
            docs.extend(got)
        except Exception as e:  # one broken source must not kill the run
            log.warning("source %s failed: %s", src.name, e)

    # 2) dedup  3) prefilter (Tier 0)
    unique, carried_by = dedup(docs)
    stats = Counter(collected=len(docs), unique=len(unique))
    scored: list[ScoredEvent] = []
    for doc in unique:
        cands = watch.match(doc)
        if not cands:
            stats["skipped_no_ticker"] += 1
            continue
        if store.seen(doc, EVENT_PROMPT_VERSION):
            stats["skipped_seen"] += 1
            continue
        n_src = len(carried_by.get(doc.url, {doc.source}))
        store.save_document(doc, n_src)
        # 4) LLM ensemble (Tier 1/2)
        try:
            res = extractor.extract(ExtractionContext(doc, cands, priority))
        except BudgetExceeded as e:
            log.error("%s -> stopping LLM stage (fail-safe: remaining docs get no signal)", e)
            stats["budget_stopped"] += 1
            break
        store.save_extraction(doc, EVENT_PROMPT_VERSION, res)
        stats[f"status_{res.status}"] += 1
        stats["rejected_votes"] += sum(1 for v in res.votes if v.rejected)
        if res.value is not None and res.value.relevant:
            scored.append(ScoredEvent(res.value, doc.fetched_at, res.agreement,
                                      doc.source_weight, n_src))

    now = dt.datetime.now(dt.timezone.utc)
    report = {"stats": dict(stats), "event_scores": event_scores(scored, now),
              "llm_cost_today": budget.summary_today()}
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config/config.yaml")
    ap.add_argument("--fake", action="store_true", help="use fake LLMs (no API keys / cost)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    with open(args.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    print(json.dumps(run(cfg, fake=args.fake), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
