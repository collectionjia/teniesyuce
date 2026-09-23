"""Weekly retrain: pull fresh nflverse data, retrain P8, refresh snapshot.

Pipeline:
  1. Backup current snapshot (with timestamp)
  2. Download latest nflverse release (overwrite data/raw/games.csv)
  3. Detect latest completed season/week
  4. Run P8 walk-forward (train through that season)
  5. Save new snapshot + commit to git if changes are non-trivial

Exit code 0 = success, 1 = no changes needed, 2 = error.
"""

from __future__ import annotations
import sys, os, json, shutil, subprocess, urllib.request, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd

from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate,
    mov_log,
)


SNAPSHOT_PATH = "data/processed/p8_ratings_snapshot.json"
RAW_PATH = "data/raw/games.csv"
DATA_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"


def download_data():
    """Pull latest games.csv from nflverse; returns True if changed."""
    print(f"Downloading {DATA_URL}...")
    # urllib SSL handshake is flaky on macOS Python 3.9; use curl subprocess
    res = subprocess.run(
        ["curl", "-sL", "--max-time", "120", DATA_URL, "-o", "/tmp/_games_new.csv"],
        capture_output=True, text=True
    )
    if res.returncode != 0 or not os.path.exists("/tmp/_games_new.csv"):
        print(f"  curl failed: {res.stderr}")
        return False
    with open("/tmp/_games_new.csv", "rb") as f:
        new_bytes = f.read()
    with open(RAW_PATH, "rb") as f:
        old_bytes = f.read()
    if new_bytes == old_bytes:
        os.remove("/tmp/_games_new.csv")
        print("  No change in remote data.")
        return False
    # Backup old
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    shutil.copy(RAW_PATH, f"data/raw/games.{ts}.bak")
    shutil.move("/tmp/_games_new.csv", RAW_PATH)
    print(f"  Updated {RAW_PATH}  (backup: data/raw/games.{ts}.bak)")
    return True


def detect_latest_completed_season():
    """Find the latest season whose REG+POST games are all completed."""
    df = pd.read_csv(RAW_PATH)
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    latest = int(df["season"].max())
    # Check if "current" season is finished: look for upcoming games
    # Heuristic: season with most recent gameday in the past = complete
    g = df[df["season"] == latest]
    max_week = int(g["week"].max())
    # If postseason exists at week >= 18 and we have <=22 weeks, season is post-Super Bowl
    has_post = (g["week"] >= 18).any() and (g["game_type"] == "POST").any()
    # Use as latest training cutoff
    return latest, max_week, has_post


def retrain(as_of_season: int):
    print(f"\nRetraining P8 walk-forward (train_through_season={as_of_season})…")
    K, HA, Rev = 16.0, 50.0, 0.40
    ste, thr, penalty = 12.0, 100.0, 30.0

    df = pd.read_csv(RAW_PATH)
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)

    eval_seasons = list(range(2010, as_of_season + 1))
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                          spread_to_elo=ste, spread_threshold=thr,
                          backup_qb_penalty=penalty)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games=df, eval_seasons=eval_seasons,
                                use_composite=False, train_through_season=as_of_season)
    m = evaluate(df_pred)
    print(f"  Eval N={m['n']}  Brier={m['brier']:.4f}  "
          f"HC@75={m['hc75']['hit_rate']:.3f}({m['hc75']['n']})  Acc={m['acc']:.3f}")

    # Snapshot
    snap = {
        "as_of_season": as_of_season,
        "trained_through": f"all played games through season {as_of_season}",
        "params": {"K": K, "HA": HA, "Rev": Rev, "spread_to_elo": ste,
                    "spread_threshold": thr, "composite": "OFF", "mov": "log",
                    "qb_weight": 0.0, "qb_k": 16.0, "backup_qb_penalty": penalty},
        "ratings": dict(sys_algo.ratings),
        "last_season": dict(sys_algo.last_season),
        "qb_ratings": dict(sys_algo.qb_ratings),
        "qb_last_season": dict(sys_algo.qb_last_season),
        "team_starting_qb": dict(sys_algo.team_starting_qb),
    }
    # Backup old
    if os.path.exists(SNAPSHOT_PATH):
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
        shutil.copy(SNAPSHOT_PATH, f"data/processed/p8_ratings_snapshot.{ts}.bak")
    with open(SNAPSHOT_PATH, "w") as f:
        json.dump(snap, f, indent=2, sort_keys=True)
    print(f"  Snapshot written: {len(snap['ratings'])} teams, "
          f"{len(snap['qb_ratings'])} QBs, "
          f"{len(snap['team_starting_qb'])} starting-QB records")
    return m


def git_commit_if_changed(message: str):
    """git add + commit + push; returns True if a commit was made."""
    try:
        subprocess.run(["git", "add", "data/raw/games.csv", SNAPSHOT_PATH,
                         "data/processed/p8_ratings_snapshot.json"],
                       cwd=".", check=True)
        result = subprocess.run(["git", "diff", "--cached", "--quiet"],
                                cwd=".", capture_output=True)
        if result.returncode == 0:
            print("  No git diff → skipping commit")
            return False
        subprocess.run(["git", "commit", "-m", message], cwd=".", check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=".", check=True)
        print("  git push OK")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  git error: {e}")
        return False


def main():
    print("=" * 60)
    print(f"Weekly retrain  ({datetime.datetime.now().isoformat()})")
    print("=" * 60)

    changed = download_data()
    if not changed:
        # Even if data unchanged, retrain anyway (cheap; ensures cron heartbeat)
        print("\nData unchanged — proceeding with retrain for heartbeat.")
    latest_season, latest_week, has_post = detect_latest_completed_season()
    print(f"\nLatest season: {latest_season}  week: {latest_week}  "
          f"postseason played: {has_post}")

    # If postseason not done (week < 18 or no postseason yet), use prev season
    # as training cutoff to avoid leaking in-progress postseason
    if not has_post and latest_week < 18:
        train_season = latest_season  # mid-regular-season; train through current season
    else:
        train_season = latest_season  # postseason started or done
    print(f"Training through season: {train_season}")

    metrics = retrain(train_season)

    ts = datetime.datetime.now().strftime("%Y-%m-%d")
    msg = (f"weekly retrain {ts} (as_of_season={train_season})\n\n"
           f"  HC@75={metrics['hc75']['hit_rate']:.3f}({metrics['hc75']['n']})  "
           f"Brier={metrics['brier']:.4f}  Acc={metrics['acc']:.3f}")
    git_commit_if_changed(msg)

    print("\nDone.")


if __name__ == "__main__":
    main()