from stockai.harness.grounding import check_evidence, quote_in_source

from conftest import SOURCE_TEXT


def test_exact_quote_is_grounded():
    assert quote_in_source("円安と北米販売の好調が寄与する", SOURCE_TEXT)


def test_fullwidth_and_spaces_are_normalized():
    assert quote_in_source("４兆９０００億円 に 上方修正", SOURCE_TEXT)


def test_fabricated_quote_is_rejected():
    assert not quote_in_source("営業利益予想を6兆円に引き上げた", SOURCE_TEXT)


def test_trivially_short_quote_is_rejected():
    assert not quote_in_source("トヨタ", SOURCE_TEXT)


def test_check_evidence_requires_all_and_at_least_one():
    ok, failed = check_evidence(["円安と北米販売の好調が寄与する", "でっちあげの引用文です"], SOURCE_TEXT)
    assert not ok and failed == ["でっちあげの引用文です"]
    assert check_evidence([], SOURCE_TEXT) == (False, [])
