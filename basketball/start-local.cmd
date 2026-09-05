@echo off
cd /d "%~dp0"
set POLY_TAG_SLUG=nba
set POLY_SERIES_ID=10345
set SPORT_LABEL=NBA
set PORT=8780
set CACHE_PATH=%~dp0data\cache.json
python -m uvicorn app.api:app --host 127.0.0.1 --port 8780
