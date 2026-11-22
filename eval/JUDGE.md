# Judging a diff rendering

The tool shows a Before text and an After text and marks what changed. It is used for prose and notes: emails, copy, outlines, bullet lists. A reader opens it to learn what the editor did.

**Goal: the reader knows exactly what changed while spending the least attention.** Every mark that does not stand for a real change costs attention. Every real change without a mark is a failure. Whole lines tinted, struck or repeated when one word changed waste attention.

## Inputs per case (folder `<out>/<id>/`)

- `split.png`: the app in Split layout (Before left, After right). Only changed words are tinted: struck-through red is removed text; green is added text; blue with a "moved" tag is text that moved.
- `unified.png`: the app in Unified layout (one column). Small edits show removed words struck in place next to the added words; rewritten or deleted lines show above the new ones as a struck block. Small boxed markers stand for whitespace edits: ¶ a line break added or removed, ⇥ an indent change, ␣ a spacing change. Moved text appears in full at its new place (blue, "moved" tag); its old place shows only a "moved ↓/↑" tag with a short dim preview.
- `ours.txt`: the same engine's changes as markup, `[-removed-]{+added+}` over the Before text, then the moves it found. Use it to check exact boundaries the screenshot makes hard to read.
- `git.txt`: `git diff --word-diff` of the same pair, as a reference point.
- The case itself (`before`, `after`, and `edits`, the ground-truth list of every edit) is in the case JSON file.

## Score each layout 1–10

- 10: only the real edits are marked, each at its natural size (word, sentence, line), and moves read as moves. Nothing to scan twice.
- 7: correct, with some extra noise: a few unchanged words marked, or a block repeated that did not need to be.
- 4: correct but the reader has to compare large spans by eye to find the edit.
- 1: misleading: a real edit is missing or unchanged text is presented as changed in a way that implies a different edit.

## Output

Write a JSON array to the path you are given, one object per case:

```json
{"id": "a01",
 "split":   {"score": 8, "missed": ["edits not visibly marked"], "false_marks": ["unchanged text marked as changed"], "notes": "one or two sentences"},
 "unified": {"score": 5, "missed": [], "false_marks": [], "notes": "..."},
 "vs_git": "better | same | worse",
 "ideal": "one sentence: what the minimal-attention rendering of this case would show",
 "problem": "the single biggest attention waste, named as a mechanism if you can (e.g. 'edited line not paired with its new version', 'whole paragraph repeated for a one-word change', 'move shown as delete plus insert', 'indent change marks whole line')"}
```

Judge what is on screen, not what the engine meant. Be strict: a human skimming is the user.
