import json,urllib.request
u='http://127.0.0.1:9004/top20?token=sofascore-monitor-2026'
d=json.load(urllib.request.urlopen(u, timeout=20))
print('keys', list(d.keys()))
for k,v in d.items():
    if k in ('players','atp','wta','data','board'):
        print(k, type(v).__name__, (len(v) if hasattr(v,'__len__') else ''))
        if isinstance(v, list) and v:
            print(' sample0', json.dumps(v[0], ensure_ascii=False)[:500])
        elif isinstance(v, dict):
            kk=list(v.keys())[:5]
            print(' subkeys', kk)
            if kk:
                print(' sample', json.dumps(v[kk[0]], ensure_ascii=False)[:500])
    else:
        print(k, ':', json.dumps(v, ensure_ascii=False)[:200])
