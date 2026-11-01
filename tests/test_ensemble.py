from stockai.harness.structured import StructuredCaller
from stockai.llm.fake import FakeProvider
from stockai.signals.extractor import EventExtractor, ExtractionContext

from conftest import event_json

CANDS = {"7203": "トヨタ自動車"}


def _ex(*members, escalation=None, quorum=2):
    return EventExtractor(StructuredCaller(max_retries=0), list(members), quorum=quorum, escalation=escalation)


def test_agreement_gives_consensus_and_stops_early(doc):
    a, b, c = (FakeProvider(n, [event_json()]) for n in "abc")
    res = _ex(a, b, c).extract(ExtractionContext(doc, CANDS))
    assert res.status == "consensus" and res.value.event_type.value == "guidance_up"
    assert c.calls == 0  # third member never paid for


def test_merge_is_conservative(doc):
    a = FakeProvider("a", [event_json(direction=2, materiality=3)])
    b = FakeProvider("b", [event_json(direction=1, materiality=2)])
    res = _ex(a, b).extract(ExtractionContext(doc, CANDS))
    assert res.value.direction == 1 and res.value.materiality == 2


def test_hallucinated_evidence_vote_is_rejected(doc):
    a = FakeProvider("a", [event_json()])
    b = FakeProvider("b", [event_json(evidence=["営業利益が前年比3倍になる見通し"])])
    res = _ex(a, b).extract(ExtractionContext(doc, CANDS))
    assert res.status == "no_consensus" and res.value is None
    assert "ungrounded" in res.votes[1].rejected


def test_ticker_outside_candidates_is_rejected(doc):
    a = FakeProvider("a", [event_json(tickers=["7267"])])  # Honda, not in the prefilter candidates
    b = FakeProvider("b", [event_json(tickers=["7267"])])
    res = _ex(a, b).extract(ExtractionContext(doc, CANDS))
    assert res.status == "failed"


def test_disagreement_on_important_item_escalates(doc):
    a = FakeProvider("a", [event_json()])
    b = FakeProvider("b", [event_json(event_type="earnings_miss", direction=-1)])
    strong = FakeProvider("strong", [event_json()])
    res = _ex(a, b, escalation=strong).extract(ExtractionContext(doc, CANDS))
    assert res.status == "escalated" and res.value.direction == 2 and strong.calls == 1


def test_escalation_must_agree_with_a_cheap_model(doc):
    a = FakeProvider("a", [event_json()])
    b = FakeProvider("b", [event_json(event_type="earnings_miss", direction=-1)])
    strong = FakeProvider("strong", [event_json(event_type="m_and_a", direction=1)])
    res = _ex(a, b, escalation=strong).extract(ExtractionContext(doc, CANDS))
    assert res.status == "no_consensus" and res.value is None


def test_unimportant_disagreement_is_not_escalated(doc):
    a = FakeProvider("a", [event_json(materiality=1, direction=1)])
    b = FakeProvider("b", [event_json(materiality=1, direction=-1)])
    strong = FakeProvider("strong", [event_json()])
    res = _ex(a, b, escalation=strong).extract(ExtractionContext(doc, CANDS))
    assert res.status == "no_consensus" and strong.calls == 0


def test_all_irrelevant_is_consensus_without_evidence(doc):
    irr = event_json(relevant=False, tickers=[], event_type="none", direction=0, materiality=0, evidence=[])
    res = _ex(FakeProvider("a", [irr]), FakeProvider("b", [irr])).extract(ExtractionContext(doc, CANDS))
    assert res.status == "consensus" and not res.value.relevant
