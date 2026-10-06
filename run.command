#!/bin/bash
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "[error] Setup failed. Make sure Python 3.10+ is installed (e.g. brew install python)."
  read -r -p "Press Enter to close..."
  exit 1
}

if [ ! -x ".venv/bin/python" ]; then
  echo "[setup] Creating virtual environment..."
  python3 -m venv .venv || fail
fi
# Installs any missing packages (e.g. after git pull). Fast when nothing changed.
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt || fail
exec .venv/bin/python app.py "$@"
