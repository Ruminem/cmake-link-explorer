# Changelog

## 0.2.2 — 2026-09-07

- Link graphs are compared without the generator's own targets standing in the way.
- Two things the interface stated that were not true are gone.

## 0.2.1 — 2026-09-07

- The README diagrams are images, so they draw the same on GitHub, the Marketplace and inside VS Code.

## 0.2.0 — 2026-09-06

- An executable matches its map entry even when its objects arrive through an archive.
- Link edits that would have been silently wrong are refused, and an unsaved `CMakeLists.txt` counts as stale.
- An answer says when it describes a configure that a newer one has already superseded; the newest reply file decides.
- Every `-D` the build sets is counted, and the list says what it does not cover.
- Release artifacts stay out of the packaged extension.

## 0.1.1 — 2026-09-06

- Published to the Marketplace, with an icon.
- A double-click installer for Windows, and releases cut from a tag.
- A large closure no longer holds a link site for every pair in it.

## 0.1.0 — 2026-09-06

- First release. What a CMake target links, who links it, and what eats the binary size and build time,
  read from CMake's File API, the linker map and ninja's build log rather than from `CMakeLists.txt`.
- "What do I link to use this header?" answered from the `#include` line, as a quick fix that picks
  `PUBLIC` or `PRIVATE` from where the include actually is.
- A linker map tab: sizes, memory regions and a build-to-build diff.
- Jump to where CMake says a target was declared, and see what a file is actually compiled with.
- Find link cycles and libraries nothing needs, and compare one build tree against another.
- C++ names are demangled without needing `c++filt`.
