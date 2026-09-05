import json,urllib.request
d=json.load(urllib.request.urlopen('http://127.0.0.1:8890/api/state', timeout=15))
print('top keys', sorted(d.keys()))
lb=d.get('leaderboard') or {}
print('lb keys', sorted(lb.keys()))
print('active_market', d.get('active_market'), d.get('market_label'))
print('round_stats', lb.get('round_stats'))
print('hot_streak_stats', lb.get('hot_streak_stats'))
print('up sample', (lb.get('up') or [])[:2])
print('winners', lb.get('winners'))
print('streak4', lb.get('streak4'))
