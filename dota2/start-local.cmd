@echo off
cd /d "%~dp0"
set POLY_TAG_SLUG=dota-2
set SPORT_LABEL=DOTA2
set PORT=8781
set CACHE_PATH=%~dp0data\cache.json
python -m uvicorn app.api:app --host 127.0.0.1 --port 8781
