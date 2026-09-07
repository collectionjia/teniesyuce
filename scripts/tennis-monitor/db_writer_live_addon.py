"""Backward-compatible re-export; use db_writer.py instead."""
from db_writer import update_live_events

__all__ = ["update_live_events"]
