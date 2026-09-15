#!/bin/zsh
set -e
export PATH="$HOME/.local/bin:$HOME/.lmstudio/bin:/opt/homebrew/bin:$PATH"
cd "${0:A:h}"
exec python3 "$PWD/start-lyrics.py"
