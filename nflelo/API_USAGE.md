# NFL Elo API — Usage

A small FastAPI service exposing the v1.2 NFL Elo predictor (Elo + MoV +
conditional spread + backup-QB penalty + XGBoost blend) over HTTP.

## Run

```bash
# from repo root
pip install fastapi uvicorn pandas numpy scikit-learn   # if not already
python3 -m uvicorn src.api:app --host 0.0.0.0 --port 8000
```

Open:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc
- **OpenAPI JSON**: http://localhost:8000/openapi.json

Production with multiple workers:
```bash
uvicorn src.api:app --host 0.0.0.0 --port 8000 --workers 4
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET  | `/` | Service banner |
| GET  | `/api/health` | Liveness check (no model load) |
| GET  | `/api/info` | Model params + as_of_season + n_teams |
| GET  | `/api/rankings?top=N` | Current Elo rankings (default top=10, max 35) |
| GET  | `/api/team/{abbr}` | Single team Elo + starting QB |
| POST | `/api/predict` | Single-game prediction |
| POST | `/api/predict/batch` | Batch prediction (1–64 games) |

All POST endpoints accept JSON. CORS is open (`*`).

## Schema

### POST `/api/predict`

Request:
```json
{
  "team_a": "KC",
  "team_b": "BUF",
  "neutral": false,
  "spread": -3.0,
  "season": 2026,
  "home_qb": "00-0036389",
  "away_qb": "00-0034857",
  "use_xgb_ensemble": true
}
```

Field reference:
- `team_a` (str, required): home team abbr; e.g. `"KC"`
- `team_b` (str, required): away team abbr
- `neutral` (bool, default false): Super Bowl / London games
- `spread` (float, optional): market `spread_line` from nflverse; sign convention
  is **+ve ⇒ home team is favored**. E.g. spread = -3.0 ⇒ KC is 3-pt underdog.
- `season` (int, optional): if given and differs from team's last_season, applies
  40% mean reversion toward 1500.
- `home_qb` / `away_qb` (str, optional): nflverse QB ids; if a team's QB differs
  from its starting QB (most-frequent in last 4 games), a -30 Elo penalty applies.
- `use_xgb_ensemble` (bool, default true): blend Elo with XGBoost (60/40).

Response:
```json
{
  "team_a": "KC",
  "team_b": "BUF",
  "neutral": false,
  "win_prob_a": 0.4144,
  "win_prob_b": 0.5856,
  "win_prob_a_elo_only": 0.4088,
  "xgb_blend_used": true,
  "elo_a": 1528.7,
  "elo_b": 1606.8,
  "elo_diff_after_spread": -64.1,
  "spread_used": true,
  "spread_value": -3.0,
  "backup_penalty_applied": false,
  "expected_margin_a": -1.67,
  "confidence_tier": "low"
}
```

Field reference:
- `win_prob_a` / `win_prob_b`: probabilities (sum to 1)
- `win_prob_a_elo_only`: pure Elo prediction (no XGB)
- `xgb_blend_used`: whether the XGBoost blend kicked in
- `elo_a` / `elo_b`: raw Elo before home-adv / spread / QB adjustments
- `elo_diff_after_spread`: working diff used for prediction (includes all adjustments)
- `spread_used`: whether spread contribution fired (gated by `|elo_diff| < 100`)
- `backup_penalty_applied`: whether any team's QB was flagged as backup
- `expected_margin_a`: FiveThirtyEight-style, 1 Elo ≈ 0.026 points
- `confidence_tier`: `"high"` if prob ≥ 0.75, `"medium"` if ≥ 0.65, else `"low"`
  (suffix `(team_b)` for low-prob picks)

### POST `/api/predict/batch`

Request:
```json
{
  "season": 2026,
  "games": [
    {"team_a": "KC", "team_b": "BUF"},
    {"team_a": "DET", "team_b": "BUF", "neutral": true},
    {"team_a": "SF", "team_b": "NYJ", "spread": -8.5}
  ]
}
```

Response:
```json
{
  "count": 3,
  "predictions": [ { ...same shape as /api/predict... }, ... ]
}
```

Max 64 games per batch.

### GET `/api/rankings?top=10`

Response:
```json
{
  "count": 10,
  "rankings": [
    {"rank": 1, "team": "SEA", "elo": 1611.4, "last_season": 2026, "starting_qb": "00-0034869"},
    ...
  ]
}
```

## Examples

### cURL

```bash
# Health
curl http://localhost:8000/api/health

# Single game (KC favored at home, BUF underdog)
curl -X POST http://localhost:8000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"team_a":"KC","team_b":"BUF","spread":-3.0}'

# Batch
curl -X POST http://localhost:8000/api/predict/batch \
  -H "Content-Type: application/json" \
  -d '{"games":[{"team_a":"KC","team_b":"BUF"},{"team_a":"DET","team_b":"NYJ"}]}'

# Top 5 rankings
curl http://localhost:8000/api/rankings?top=5

# Single team
curl http://localhost:8000/api/team/KC
```

### Python (requests)

```python
import requests

BASE = "http://localhost:8000"

# Single game
r = requests.post(f"{BASE}/api/predict",
                  json={"team_a": "KC", "team_b": "BUF", "spread": -3.0})
r.raise_for_status()
pred = r.json()
print(f"KC win prob: {pred['win_prob_a']:.3f}  Elo-only: {pred['win_prob_a_elo_only']:.3f}")
print(f"Expected margin: {pred['expected_margin_a']:+.1f}")
print(f"Confidence: {pred['confidence_tier']}")

# Batch (a full NFL week)
r = requests.post(f"{BASE}/api/predict/batch", json={
    "season": 2026,
    "games": [
        {"team_a": "KC", "team_b": "BUF"},
        {"team_a": "DET", "team_b": "BUF", "neutral": True},
        {"team_a": "SF", "team_b": "NYJ"},
    ]
})
for p in r.json()["predictions"]:
    print(f"{p['team_a']} vs {p['team_b']}: {p['win_prob_a']:.2%}")
```

### Python (httpx async)

```python
import httpx, asyncio

async def main():
    async with httpx.AsyncClient() as client:
        r = await client.post("http://localhost:8000/api/predict",
                               json={"team_a": "KC", "team_b": "BUF"})
        print(r.json())

asyncio.run(main())
```

## Errors

| HTTP | When | Body |
|---|---|---|
| 400 | Unknown team abbreviation | `{"detail": "Invalid input: ..."}` |
| 404 | GET `/api/team/{abbr}` with bad abbr | `{"detail": "Unknown team: XXX"}` |
| 422 | Pydantic validation (e.g. negative spread where bool expected) | auto-detail |

## Performance

- `/api/info` / `/api/health` — instant (no model load)
- `/api/predict` — ~5–10ms (XGB inference on 23 features + Python Elo)
- `/api/predict/batch` — ~5–10ms × N games
- Snapshot reload: on first request only (FastAPI module-load)

## Operational notes

- The XGBoost bundle (`data/processed/xgb_ensemble.pkl`) is loaded once at
  module import. If the file is missing, `predict()` falls back to pure Elo
  (and `xgb_blend_used` will be `false`).
- The snapshot (`data/processed/p8_ratings_snapshot.json`) is the source of
  truth. It is refreshed weekly by `run_weekly.py` + cron. To pick up the
  newest snapshot, restart the API process.
- CORS is open (`*`). For production behind a custom domain, restrict to
  specific origins in `src/api.py` (`CORSMiddleware`).

## Model reference

| Component | Description | Reference |
|---|---|---|
| Elo | K=16, HA=50, Rev=0.4 | FiveThirtyEight NFL |
| MoV | `ln(PD+1) × (2.2 / (elo_diff × 0.001 + 2.2))` | 538 |
| Conditional spread | market × 12 Elo/pt, only when `|diff| < 100` | this repo (P4) |
| Backup QB penalty | -30 Elo if QB ≠ team's most-recent starter | this repo (P8) |
| XGBoost blend | HistGradientBoosting, α=0.6 | this repo (P9) |

Eval (walk-forward, 2018-2025, n=2127): **HC@75 = 84.2%, Brier = 0.2149**.