from diageo_research.memory import DialogueMemory
from diageo_research.models import Citation, DialogueTurn


def _turn(idx: int, **kw) -> DialogueTurn:
    return DialogueTurn(
        turn_idx=idx,
        question=kw.get("question", f"q{idx}"),
        answer=kw.get("answer", f"a{idx}"),
        citations=kw.get("citations", []),
        queries=kw.get("queries", []),
    )


def test_context_block_empty():
    m = DialogueMemory()
    assert m.context_block() == ""


def test_context_block_windows_recent_turns():
    m = DialogueMemory()
    for i in range(1, 7):
        m.append(_turn(i))
    block = m.context_block(window=3)
    # Only the last 3 turns appear verbatim
    assert "Turn 4" in block
    assert "Turn 5" in block
    assert "Turn 6" in block
    assert "Turn 1" not in block


def test_context_block_includes_rolling_summary():
    m = DialogueMemory()
    m.rolling_summary = "previous gist about pricing"
    m.append(_turn(1))
    block = m.context_block()
    assert "previous gist about pricing" in block
    assert "Turn 1" in block


def test_context_block_shows_cite_ids():
    m = DialogueMemory()
    cites = [
        Citation(cite_id="B1", source="browser", url="https://x.example"),
        Citation(cite_id="Q1", source="duckdb", sql="SELECT 1"),
    ]
    m.append(_turn(1, citations=cites))
    block = m.context_block()
    assert "B1" in block and "Q1" in block
