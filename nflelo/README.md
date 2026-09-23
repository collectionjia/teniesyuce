# NFL Elo

NFL game win-probability predictor built on an Elo rating system with
margin-of-victory updates, season mean-reversion, market-spread refinement
(conditional on Elo uncertainty), and a backup-QB penalty.

## Results (walk-forward, 2010-2025, 4175 games)

| Metric | Value | Target |
|---|---|---|
| **HC@75** | **82.8%** (n=488) | > 67% |
| HC@65 | 73.1% (n=1675) | > 70% |
| Brier | 0.2160 | < 0.22 |
| LogLoss | 0.6213 | < 0.65 |
| Accuracy | 65.5% | — |

## Final params (`data/processed/p8_ratings_snapshot.json`)

```json
{
  "K": 16, "HA": 50, "Rev": 0.4,
  "spread_to_elo": 12, "spread_threshold": 100,
  "backup_qb_penalty": 30,
  "mov": "log", "composite": "OFF"
}
```

- **K = 16** (vs Dota2 K=32 — NFL has only 17 games/season, so ratings move slower)
- **HA = 50** Elo points (NFL home win rate ≈ 57%)
- **Rev = 0.4** season-start mean reversion toward 1500
- **MoV multiplier**: `ln(PD+1) × (2.2 / (elo_diff × 0.001 + 2.2))` (FiveThirtyEight)
- **Conditional spread** (P4): market spread_line contributes `× 12 Elo per point`
  ONLY when `|elo_diff| < 100`. Big-favorite games ignore the market (Elo
  already certain); close games use it (where the market has information Elo
  doesn't).
- **Backup QB penalty** (P8): each team tracks its starting QB (most-frequent
  in last 4 games). If the listed game QB differs, that team takes a -30 Elo
  penalty. Captures "star QB out, backup in" scenarios the team Elo can't see.

## Setup

```bash
# Python 3.9+, pandas, numpy
pip install pandas numpy
```

Data file (`data/raw/games.csv`) is downloaded from nflverse:
```bash
curl -sL "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv" \
     -o data/raw/games.csv
```

## Run

```bash
python3 run_p1.py        # baseline Elo (K=20 HA=65)
python3 run_p2.py        # grid search + composite ablation + sqrt MoV
python3 run_p3.py        # unconditional spread_line grid
python3 run_p4.py        # conditional spread grid
python3 run_p6.py        # 2025-2026 out-of-sample backtest
python3 run_p6_2026.py   # 2026 only OOS (game-by-game)
python3 run_p7.py        # QB Elo exploration + retrain through 2025
python3 run_p8.py        # backup QB penalty grid search (recommended)
```

Each script writes its results to `data/processed/`. `run_p8.py` writes the
default snapshot consumed by `src/predict.py`.

## Predict

```python
from src.predict import predict, predict_games, team_ratings

# single game
predict("KC", "BUF")                                    # home KC, no market spread
predict("KC", "BUF", spread=-3.0)                      # KC favored by 3 (market)
predict("KC", "BUF", neutral=True)                      # neutral-site (Super Bowl)

# with QB info (triggers backup penalty if QB != team's starting QB)
predict("KC", "BUF", home_qb="00-0036389", away_qb="00-0034857")

# batch
predict_games([("KC", "BAL"), ("DET", "BUF"), ("SF", "NYJ")])

# ratings snapshot
team_ratings().head(10)
```

CLI:
```bash
python3 src/predict.py info
python3 src/predict.py rankings --top 10
python3 src/predict.py predict KC BUF --spread -3
python3 src/predict.py predict KC BUF --home-qb 00-0036389 --away-qb 00-0034857
```

## HTTP API (v1.2+)

A FastAPI service exposes the same predictor over HTTP with auto-generated
OpenAPI docs.

```bash
python3 -m uvicorn src.api:app --host 0.0.0.0 --port 8000
# Swagger UI:  http://localhost:8000/docs
# ReDoc:       http://localhost:8000/redoc
```

See `API_USAGE.md` for full schema, curl + Python examples, and error reference.

## Repo layout

```
NFL/
├── data/
│   ├── raw/games.csv                    # nflverse game-level data (1999-2026)
│   └── processed/                       # per-phase predictions, grid CSVs, snapshots
├── src/
│   ├── elo.py                           # P1 EloSystem
│   ├── backtest.py                      # P1 evaluator
│   ├── pipeline.py                      # P2-P8 unified pipeline (composite, MoV, cond spread, QB Elo, backup penalty)
│   └── predict.py                       # public prediction interface + CLI
├── run_p1.py .. run_p8.py               # one runner per phase
└── README.md
```

## Methodology notes

- Walk-forward backtest: 1999-2009 burns in Elo, 2010-2025 evaluated.
- Brier/LogLoss clipped to `[1e-9, 1-1e-9]` before `log` to avoid blow-ups.
- HC@X = hit rate on games where the model's predicted prob for the winner
  is ≥ X (i.e. "high confidence" picks).
- Spread_line sign convention (nflverse CSV): negative ⇒ home team is the
  underdog. So `home_elo_bonus = spread × 12` correctly penalizes favorites
  for home teams.
- Out-of-sample validated: 2025 OOS HC@75=84.2% (95%CI ±8pp, n=76), 2026
  OOS (week 1-2, n=17) Acc=82.4%. Numbers within statistical noise of
  in-sample baseline — no decay.

## What did NOT help (negative results, recorded so you don't repeat them)

- **Composite rating (rolling PPG/PAPG/PD)**: 4-factor power add-on reduced
  HC@75 by 3.6 pp. Rolling NFL stats add noise that conflicts with the
  signal of cumulative Elo.
- **sqrt MoV** (538 v2): compressed the PD gradient; ln(PD+1) better suits
  NFL score distributions.
- **Unconditional spread_line**: improves Brier but tanks HC@75 (pushing
  predictions toward 50/50). The conditional version (Elo-diff gate) is
  what unlocks the win.
- **QB Elo subsystem** (per-QB Elo + qb_weight parameter): Brier improves
  marginally (-0.0004) but HC@75 drops -1.3pp — not worth it. Backup
  QB penalty (P8) captures the QB signal better with a much smaller model.

## License

MIT