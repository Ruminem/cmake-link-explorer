#!/bin/sh
# Renders every .mmd here to .png beside it.
#
# The readmes used to carry these as ```mermaid fences. GitHub draws those; the
# VS Code Marketplace does not, and showed the source as a grey code block on
# the one page most people ever see. Committed images referenced by absolute URL
# draw the same everywhere.
#
# PNG rather than SVG because vsce refuses to package a readme that references
# an SVG at all -- "SVGs are restricted in README.md". Rendered at 2x so it
# still looks right on a high-density screen.
#
# The .mmd files stay the source of truth -- edit those, re-run this, commit both.
#
#   sh media/diagrams/render.sh
#
# Needs network the first time: mermaid-cli pulls a headless browser to measure
# text with. Nothing in the extension depends on it.
set -e
cd "$(dirname "$0")"
for src in *.mmd; do
  npx --yes @mermaid-js/mermaid-cli \
    -i "$src" -o "${src%.mmd}.png" \
    -c theme.json -b transparent -s 2
  echo "  $src -> ${src%.mmd}.png"
done
