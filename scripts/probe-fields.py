import json,urllib.request
for path in ('/status','/logs?lines=2','/top20'):
  req=urllib.request.Request('http://127.0.0.1:9004'+path, headers={'Authorization':'Bearer sofascore-monitor-2026'})
  d=json.load(urllib.request.urlopen(req, timeout=20))
  print('====', path)
  print(list(d.keys()))
  if path.startswith('/status'):
    print('bundle', d.get('latest_bundle') or d.get('latest_bundle'))
    print('log keys hint', 'latest_log' in d, 'latest_log_tail' in d)
  if path.startswith('/logs'):
    print({k:(str(v)[:60]) for k,v in d.items()})
  if path=='/top20':
    print('loading', d.get('loading'), 'summary', d.get('summary'))
