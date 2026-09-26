import zipfile, re, collections

apk = r"d:\bbbbb\docs\base.apk"
path_re = re.compile(rb"/api/v[0-9]+/[a-zA-Z0-9_{}/?&=\-\.%]+")
base_re = re.compile(rb"(?:https?://)?([a-z0-9][-a-z0-9.]*\.(?:sofascore|clipro)\.[a-z]{2,3})(/[^\s\x00\"'<>]{0,80})?")
pkg_re = re.compile(rb"com\.sofascore\.[a-z.]+")

paths = collections.Counter()
bases = collections.Counter()
packages = set()

with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith(".dex"):
            continue
        data = z.read(name)
        for m in path_re.findall(data):
            try:
                p = m.decode("utf-8", errors="ignore").rstrip(".,;")
                if len(p) > 8 and "{" not in p or "}" in p:
                    paths[p] += 1
            except Exception:
                pass
        for host, path in base_re.findall(data):
            try:
                h = host.decode()
                p = (path or b"").decode()
                bases[f"https://{h}{p}"] += 1
            except Exception:
                pass
        for m in pkg_re.findall(data):
            try:
                packages.add(m.decode())
            except Exception:
                pass

print("=== All /api/v* paths (top 120 by frequency) ===")
for p, c in paths.most_common(120):
    print(f"{c:3d}  {p}")
print(f"\nUnique paths: {len(paths)}")

print("\n=== Base URLs (sofascore/clipro) ===")
for u, c in bases.most_common(30):
    print(f"{c:3d}  {u}")

print("\n=== Package ===")
for p in sorted(packages):
    if p.count(".") <= 3:
        print(p)
