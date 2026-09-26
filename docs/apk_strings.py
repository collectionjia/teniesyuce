import zipfile, re, collections

apk = r"d:\bbbbb\docs\base.apk"
# printable ASCII runs 6+
str_re = re.compile(rb"[\x20-\x7e]{6,}")
hosts = collections.Counter()
api_lines = set()

with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith(".dex"):
            continue
        data = z.read(name)
        for m in str_re.findall(data):
            s = m.decode("ascii", errors="ignore")
            if "sofascore" in s.lower() or "clipro" in s.lower():
                if s.startswith("/api/") or "api.sofascore" in s or "ott.sofascore" in s:
                    api_lines.add(s)
                if re.match(r"https?://[a-z0-9.-]+\.(sofascore|clipro)\.[a-z]{2,}", s, re.I):
                    hosts[s.split()[0].rstrip(".,;")] += 1
                elif re.match(r"^[a-z0-9][-a-z0-9.]*\.sofascore\.com", s, re.I):
                    hosts["https://" + s.split()[0]] += 1

print("=== Full https hosts ===")
for h, c in sorted(hosts.items(), key=lambda x: (-x[1], x[0])):
    print(f"{c:3d}  {h}")

print("\n=== API-related strings ===")
for s in sorted(api_lines):
    if len(s) < 200:
        print(s)
print(f"\nTotal: {len(api_lines)}")
