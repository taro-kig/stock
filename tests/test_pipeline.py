from stockai import pipeline
from stockai.signals.models import Document
from stockai.signals.sources.rss import RSSSource


def test_pipeline_end_to_end_with_fake_llms(tmp_path, monkeypatch):
    docs = {
        "a": [Document(source="a", url="u1", title="トヨタ、営業益予想を上方修正 - A"),
              Document(source="a", url="u2", title="Unrelated weather news")],
        "b": [Document(source="b", url="u3", title="トヨタ、営業益予想を上方修正 - B")],
    }
    monkeypatch.setattr(RSSSource, "fetch", lambda self: docs[self.name])
    cfg = {"data_dir": str(tmp_path),
           "sources": [{"name": "a", "url": "x"}, {"name": "b", "url": "y"}],
           "watchlist": {"7203": {"name": "トヨタ自動車", "aliases": ["トヨタ"]}}}

    first = pipeline.run(cfg, fake=True)["stats"]
    assert first == {"collected": 3, "unique": 2, "skipped_no_ticker": 1, "status_consensus": 1,
                     "rejected_votes": 0}
    second = pipeline.run(cfg, fake=True)["stats"]
    assert second["skipped_seen"] == 1  # already processed -> no LLM call at all
