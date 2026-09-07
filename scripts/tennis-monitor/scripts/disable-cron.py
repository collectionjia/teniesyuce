import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
if not (APP / 'tm' / 'server.py').exists():
    APP = Path.cwd()
sys.path.insert(0, str(APP))

from tm.server import _apply_collect_schedule, _read_schedule_config, _write_schedule_config

_apply_collect_schedule(6, enabled=False)
cfg = _read_schedule_config()
cfg["interval_hours"] = 0
_write_schedule_config(cfg)
print("cron_removed", "interval_hours=0")
