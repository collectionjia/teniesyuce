import zipfile, re

apk = r"d:\bbbbb\docs\base.apk"
api_patterns = [
    rb"api\.sofascore\.com[^\s\x00\"'<>]{0,120}",
    rb"ott\.sofascore\.com[^\s\x00\"'<>]{0,120}",
    rb"files\.sofascore\.com[^\s\x00\"'<>]{0,120}",
    rb"userimage\.sofascore\.com[^\s\x00\"'<>]{0,120}",
    rb"app\.sofascore\.com[^\s\x00\"'<>]{0,120}",
    rb"/api/v[0-9]+/[^\s\x00\"'<>]{0,100}",
    rb"wss?://[^\s\x00\"'<>]{0,120}",
]
host_re = re.compile(rb"(?:https?://)?([a-zA-Z0-9][-a-zA-Z0-9.]*sofascore[a-zA-Z0-9./?&=_%-]{0,100})")

found = set()
hosts = set()

with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith(".dex"):
            continue
        data = z.read(name)
        for pat in api_patterns:
            for m in re.findall(pat, data):
                try:
                    found.add(m.decode("utf-8", errors="ignore"))
                except Exception:
                    pass
        for m in host_re.findall(data):
            try:
                s = m.decode("utf-8", errors="ignore")
                if len(s) > 10:
                    hosts.add(s)
            except Exception:
                pass

print("=== SofaScore API / paths ===")
for s in sorted(found):
    print(s)
print(f"\nTotal: {len(found)}")

print("\n=== SofaScore hosts/paths (broader) ===")
for s in sorted(hosts)[:100]:
    print(s)
print(f"\nTotal: {len(hosts)}")

# manifest
with zipfile.ZipFile(apk) as z:
    manifest = z.read("AndroidManifest.xml")
    pkg = re.search(rb"com\.[a-z.]+", manifest)
    print("\n=== Package hint ===")
    if pkg:
        print(pkg.group().decode())
