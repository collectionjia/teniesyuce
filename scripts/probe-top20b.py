import json,urllib.request
d=json.load(urllib.request.urlopen('http://127.0.0.1:9004/top20?token=sofascore-monitor-2026', timeout=20))
# find a player with matches
for tour in ('atp','wta'):
  for p in d[tour]:
    if p.get('matchCount'):
      print(tour, json.dumps(p, ensure_ascii=False, indent=2)[:1200])
      break
st=json.load(urllib.request.urlopen('http://127.0.0.1:9004/status?token=sofascore-monitor-2026&format=json', timeout=10))
print('STATUS keys', st.keys())
print('last_run', st.get('last_run'))
print('latest_bundle', st.get('latest_bundle'))
print('cron', st.get('cron'))
