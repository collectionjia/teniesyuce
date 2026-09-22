"""HTTP API for the NFL Elo predictor.

Endpoints (all under /api):
  GET  /info                       model info (params, as_of_season, n_teams)
  GET  /rankings?top=10            current Elo rankings as DataFrame
  GET  /team/{abbr}                single team Elo + starting QB
  POST /predict                    single-game prediction
  POST /predict/batch              batch prediction
  GET  /health                     health check (no DB call)

Auto-generated OpenAPI docs:
  GET /docs     Swagger UI
  GET /redoc    ReDoc

Run:
    uvicorn src.api:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations
import os
import sys
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Allow `import predict` from src/
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import predict as predict_mod


app = FastAPI(
    title="NFL Elo Predictor API",
    version="1.2.0",
    description=(
        "Predict NFL game outcomes using a calibrated Elo + MoV model "
        "with conditional market-spread refinement, backup-QB penalty, "
        "and a XGBoost blend (alpha=0.6). "
        "Auto-generated Swagger UI at /docs, ReDoc at /redoc."
    ),
)

# CORS: allow any origin (this is a public API once deployed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---- Request / Response models ----------------------------------------------

class PredictRequest(BaseModel):
    team_a: str = Field(..., description="Home team abbreviation, e.g. 'KC'")
    team_b: str = Field(..., description="Away team abbreviation, e.g. 'BUF'")
    neutral: bool = Field(False, description="Neutral-site game (Super Bowl, London)")
    spread: Optional[float] = Field(None, description="Market spread_line (nflverse sign: +ve ⇒ home favored)")
    season: Optional[int] = Field(None, description="Season year; triggers mean-reversion if team wasn't seen last season")
    home_qb: Optional[str] = Field(None, description="Home team QB id (nflverse)")
    away_qb: Optional[str] = Field(None, description="Away team QB id (nflverse)")
    use_xgb_ensemble: bool = Field(True, description="Blend with XGBoost (default)")


class BatchPredictRequest(BaseModel):
    games: list[PredictRequest] = Field(..., min_length=1, max_length=64)
    season: Optional[int] = Field(None, description="Apply to all games in the batch")


# ---- Endpoints --------------------------------------------------------------

@app.get("/", include_in_schema=False)
def root():
    return {
        "service": "NFL Elo Predictor",
        "version": "1.2.0",
        "endpoints": ["/api/health", "/api/info", "/api/rankings",
                       "/api/team/{abbr}", "/api/predict", "/api/predict/batch",
                       "/docs", "/redoc"],
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/info")
def info():
    return predict_mod.model_info()


@app.get("/api/rankings")
def rankings(top: int = Query(10, ge=1, le=35)):
    df = predict_mod.team_ratings().head(top)
    return {"count": len(df), "rankings": df.to_dict(orient="records")}


@app.get("/api/team/{abbr}")
def team(abbr: str):
    abbr = abbr.upper()
    df = predict_mod.team_ratings()
    row = df[df["team"] == abbr]
    if row.empty:
        raise HTTPException(status_code=404, detail=f"Unknown team: {abbr}")
    return row.iloc[0].to_dict()


@app.post("/api/predict")
def predict(req: PredictRequest):
    try:
        return predict_mod.predict(
            req.team_a, req.team_b,
            neutral=req.neutral,
            spread=req.spread,
            season=req.season,
            home_qb=req.home_qb, away_qb=req.away_qb,
            use_xgb_ensemble=req.use_xgb_ensemble,
        )
    except KeyError as e:
        raise HTTPException(status_code=400, detail=f"Invalid input: {e}")


@app.post("/api/predict/batch")
def predict_batch(req: BatchPredictRequest):
    results = []
    for g in req.games:
        try:
            out = predict_mod.predict(
                g.team_a, g.team_b,
                neutral=g.neutral, spread=g.spread, season=req.season,
                home_qb=g.home_qb, away_qb=g.away_qb,
                use_xgb_ensemble=g.use_xgb_ensemble,
            )
        except KeyError as e:
            raise HTTPException(status_code=400, detail=f"Invalid input in batch: {e}")
        results.append(out)
    return {"count": len(results), "predictions": results}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.api:app", host="0.0.0.0", port=8000, reload=False)