import zipfile, re, collections

apk = r"d:\bbbbb\docs\base.apk"
path_re = re.compile(rb"/[a-z][a-z0-9_\-/{}\.]+")
interesting = collections.Counter()

keywords = (b"event", b"sport", b"tennis", b"odds", b"team", b"player", b"tournament", b"stage", b"live", b"socket", b"ws", b"chat", b"fantasy", b"search", b"user", b"media", b"stream", b"hls")

with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith(".dex"):
            continue
        data = z.read(name)
        for m in path_re.findall(data):
            if not any(k in m for k in keywords):
                continue
            try:
                s = m.decode("utf-8", errors="ignore")
            except Exception:
                continue
            if len(s) < 5 or len(s) > 120:
                continue
            if s.count("/") < 2:
                continue
            if any(x in s for x in ("com/", "android/", "google/", "kotlin/", "java/")):
                continue
            interesting[s] += 1

print("=== Sports/API path strings (freq>=1, sorted) ===")
for p, c in sorted(interesting.items(), key=lambda x: x[0]):
    if c >= 1:
        print(f"{c:2d}  {p}")
print(f"\nUnique: {len(interesting)}")

# ws / host strings
host_re = re.compile(rb"[\x20-\x7e]{4,80}")
hosts = set()
with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith(".dex"):
            continue
        for m in host_re.findall(z.read(name)):
            s = m.decode("ascii", errors="ignore")
            if "sofascore" in s and ("ws" in s or "socket" in s or "mqtt" in s or "push" in s or "stream" in s):
                hosts.add(s)

print("\n=== WS/stream related ===")
for h in sorted(hosts):
    print(h)
