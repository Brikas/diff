## About SPEC File:
SPEC.md is very small, fully semantical
- VERY BRIEF.
- Only writable by human, or when human EXPLICITLY says "write to spec".
  - Exception applies to "UNPROCESSED SPEC". See below.
- Only explicit decisions made by human
  - Put as verbatim as the user said as possible.
  - Zeo assumptions on what the the user explicitly agreed -> better ask than not.
- Abstract and general on purpose
  - Specific best-practice tools change, but principles survive longer.
  - no code mentions
    - unless particualr lines of code or library was a huge discussion.
- Unproccesed spec
  - When you as an AI agent make changes to the app and user did not explicitly ask to add to spec, add a VERBATIM entry of what the user asked using a quote to the UNPROCESSED SPEC section.
  - This is NOT a log of what you did,
  - Only aboslutely short commentary allowed if context is needed to understand the quote. Max 15 words.
  - Include the name of the quote author, if possible.

## Intent
- A diff tool on its own domain, built on mature open-source diff engines
- "its not only used for code, but more for normal copy." (Airidas)

## Spec
- Identity
  - "No login. Anonymous identity stored by cookie "Anon {random entity noun}"."
  - "user_id = the differentiator"
  - "user_secret = but that allows to do writes as a user (it contains user_id inside of it, so to login one only needs one copy/paste)"
    - "technically secret and could not leak when reading requests"
  - "Click on the user icon has something to save/copy and then insert the user secret. But mostly minimal in design"
    - "also it should say in the modal."
- Sharing
  - "Link sharing has view or edit access. Edit default."
  - "Each link is private and non indexable. ~16+ chars long for secrecy."
- Editing
  - "Edit access one can just edit inside while looking."
- Versioning
  - "Supports versioning with 0 friction by default"
    - "auto new version every 30 mins if by same person"
    - "otherwise even if 30s elapsed but a new person, mints a new version"
    - "but can be disabled."
  - "find some inspirations for the versioning thing and adopt."
- Interface
  - "Super minimal interface."
- Marking
  - "optimizing for human attention minimization"
  - "In the diff in VS Code, there are two level of red/green marking. red and very red. very red shows the actual changed / removed things."
    - "I DONT need to see place, track as remove because it is NOT Removed thats confusing., but its a part of the change context, so yeah it should be somehow indicated"
  - "no strikethroughs"
  - "make it two styles that one can also choose so I can compare"
    - Solid: the current single-level marking
    - Layered: the two-level marking
- Abuse
  - "Since its public, ratelimit public writes somehow."
  - "Max 100 new versions/diffs per day."
- Runtime
  - "Isolated non-root docker (ensure security)"
  - "throttled system resources access (non dedicated, but throttled)"

## UNPROCESSED SPEC
- Diff quality
  - "Goal: minimize attention requirement for a human to know what actually changed." (Airidas)
  - "no use case for code, thats not needed, but bullet indented text is relevant" (Airidas)
  - "The unified wastes so much attention. Only the word test cahnges, but it shows the whole thing as changed... The the git does it better" (Airidas)
  - "the spacing differences (paragraphs) should be literally full lines in red/green, not some bullshit marking" (Airidas)
  - "the layered, lower contrast one should be a little bit more contrast please" (Airidas)
- Identity
  - "Castle? Radish? these are not entitiies. it must be 'alive' things. Radish is fine but not Castle" (Airidas)
  - "Anon -> Anonymous" (Airidas)
  - "find a list of 100 plus icon set in the same style that contains enttities like this and add icons to these anonymous things, plus colors" (Airidas)
- Interface
  - "add a theme (dark, light, system) toggle" (Airidas)
  - ""diff" logo has no colors. Just black font." (Airidas)
  - "add keyboard shortcuts for as many things as possible. Show the shortcut on hover of any button and add a keyboard shortcuit icon which opens and shows a list of keyboard shortcuts (not editable)." (Airidas)
  - "Shortcuts must work on Windows and MacOS" (Airidas)
- Agents
  - "Add a button for "API | Connect agent". API is not text, but the icon." (Airidas)
  - "opens API docs explained for agents to use. It also shows the current user_id based on cookie" (Airidas)
  - "shows a quick prompt to put into the AI (with icons of Claude, Codex, PI, Gemini, OpenCode, OpenClaw etc.)" (Airidas)
  - "an agent might create their own user id such as Johns Agent to indicate that it was an agent." (Airidas)
  - "Make it all possible to do with a single API call: Make a new user (just don't provide an id, the app auto gens) Name that new user Add the diff Get sharing link" (Airidas)

## ASSUMED SPEC
- Prose diff rules taken from oracles in temple1 `codebase-inspiration`
  - Moved paragraph: wikidiff2 similarity, git 20-character floor
  - Noise merge: diff-match-patch semantic cleanup
- Versioning details taken from Figma, Google Docs, Outline, Etherpad
  - Same content writes nothing
  - Every amending author is kept on the version
  - Naming a version closes it
  - Old versions open read-only; Restore appends a copy
  - A version has its own link
  - A stale save is a conflict, never a silent overwrite
- "100 per day" counted per client IP, plus a global ceiling
- Outbound network blocked for the app entirely
- Agents identify by sending a user id; a user id grants attribution, never access
- Shortcuts use Alt+Shift (⌥⇧), so they never type into the editor or clash with the browser
