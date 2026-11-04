# Design review · 2 November 2026

Method: walked every screen and state on real COMP2211 data at 1440×900 (laptop), 820×1180 (tablet) and 390×844 (phone), as Thomas (no notes yet) and Alex (has notes). Judged against the concept doc's principles: *useful as a notebook first*, *suggestions quiet until opened*, *student notes never altered*, *provenance and unverified labels*, *no extra sharing step*. Each finding names the human problem, not just the visual one.

## P1: trust, consent and value

1. **Automatic sharing is never actually disclosed.** The only mention was a passive line on the home page ("Notes are only shared within a course"), which reads as a limit, not as "your notes are shared". A student finds out only by seeing "Contributing 16 notes". *Fix:* explain it when joining or creating a course (the moment of the decision); show a persistent sharing status on the course page with a review list.
2. **Authors can't take anything back.** "What this page shares" is read-only. If the AI shares a wrong or embarrassing line under my name, I have no control. *Fix:* "Stop sharing" on every shared item, remembered across re-indexing. Explain why items are private (hard to read, same as the slide, turned off).
3. **Many "classmate notes" just repeat the slide.** On L3 slide 14, 8 of Alex's notes are definitions already printed on the slide ("Prior probability P(B): how likely the belief is on its own"). This is noise, and it makes the orange badge meaningless. The product's value is what is *not* on the slide. *Fix:* don't share fragments that mostly restate the linked slide text.
4. **Transcriptions talk about the student** ("Student's own working definition of AI:", "as recorded:"). Classmates want the knowledge itself. *Fix:* prompt for direct content.
5. **Bare "94%" next to a classmate's note** reads as "94% correct". It is actually confidence in reading the handwriting. *Fix:* no number; show "Hard to read, check the handwriting" only when it matters.
6. **Study panel opens by default with orange counts.** This contradicts "suggestions should be quiet until opened", and it takes a third of the screen from the notes. *Fix:* closed by default; the per-page pill and thumbnail dot stay as quiet indicators; remember the user's choice.

## P2: structure and everyday use

7. **The home page doesn't help me resume.** The most common intent ("continue where I was") has no entry point. The subtitle explains the data model. Leave sits next to Open with equal weight. Student counts on my own courses are noise. The model name ("AI · deepseek-flash") means nothing to students. *Fix:* Continue row (recent notebooks across courses, opening at the last page), no subtitle, Leave in a ⋯ menu, members only for courses to join, AI shown only when it's broken.
8. **Lectures appear twice.** Opening a lecture silently created "L3 · Naive Bayes, 41 pages" under My notebooks even with nothing written, so My notebooks fills with empty duplicates of lectures. *Fix:* the lecture card *is* my notebook for that lecture. It shows my progress ("You wrote on 5 slides") and classmates' notes; My notebooks lists only my own blank and imported notebooks.
9. **Editor header wraps** at 1440 px when the panel is open ("Study" drops to a second row), and to three rows on a phone; the title truncates on a tablet. The stylus-only switch is meaningless with a mouse. Zoom takes header space. *Fix:* one row; zoom floats over the canvas; the stylus switch appears only on touch devices; the toolbar scrolls horizontally on narrow screens.
10. **Menus don't close** on outside click or Escape (the page ⋯ menu stayed open across actions); dialogs ignore Escape.
11. **Notebooks reopen at page 1.** In a 99-slide lecture this is real friction. *Fix:* remember the last page per notebook.

## P3: wording and placement

12. A page of Alex's notes covering six slides showed "Looks like L1 · slide 11", which is wrong in spirit. *Fix:* "L1 · 6 slides" when fragments link to several slides.
13. The Classmates tab on non-slide pages said "No classmate notes for this slide".
14. "Add to my notes" from a lasso Explain placed the card top-right, often over slide text far from the selection. *Fix:* place it beside the selection.

## Status
All P1–P3 findings above are implemented (same day). Also found while verifying: page images on the home page and handwriting crops were requested without the student identity (fixed with a demo-identity cookie, still checked server-side); opening the study panel rescaled pages and jumped several slides (the reading position is now preserved); lazy page rendering measured visibility against the window instead of the canvas, so pages just below the fold weren't pre-rendered and would flash blank; fixed.

Effect on real data: re-reading Alex's 48 pages produced 412 notes, 209 shared; 178 kept private as "already on the slide", 9 hard to read, 16 lecture unclear. L3 slide 14 went from 8 classmate notes (all slide definitions) to 1.

## Kept as is (working)
Paper/ink rendering, lasso → Explain/Quiz, citation chips opening the original slide or handwriting, unverified labels, separate sticky annotations, per-page "Organizing… / Contributing" chips, course isolation.

## Open decisions for the product owner
- Per-notebook "don't share this notebook" switch (privacy vs. how fast the shared layer grows).
- Whether students can share an item the AI kept private (e.g. low confidence). Currently not allowed, to avoid spreading misread math.
