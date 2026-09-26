import zipfile, re, sys

apk = r"d:\bbbbb\docs\base.apk"
url_re = re.compile(rb"https?://[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%\-]+")
ws_re = re.compile(rb"wss?://[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%\-]+")
domain_re = re.compile(rb"[a-zA-Z0-9][-a-zA-Z0-9]*\.(?:com|cn|net|org|io|app|xyz|cc|top|vip|live|tv|me|co)(?:\.[a-z]{2})?(?:/[^\s\x00\"'<>]{0,80})?")

urls = set()
domains = set()

with zipfile.ZipFile(apk) as z:
    names = z.namelist()
    print(f"APK entries: {len(names)}")
    for name in names:
        if not any(name.endswith(ext) for ext in (".dex", ".xml", ".json", ".properties", ".txt", ".js", ".html", ".conf", ".cfg", ".so")):
            if "assets/" not in name and "res/" not in name:
                continue
        try:
            data = z.read(name)
        except Exception:
            continue
        for m in url_re.findall(data):
            try:
                urls.add(m.decode("utf-8", errors="ignore").rstrip(".,;"))
            except Exception:
                pass
        for m in ws_re.findall(data):
            try:
                urls.add(m.decode("utf-8", errors="ignore").rstrip(".,;"))
            except Exception:
                pass
        if name.endswith(".dex"):
            for m in domain_re.findall(data):
                try:
                    s = m.decode("utf-8", errors="ignore")
                    if len(s) > 6 and "android" not in s and "google" not in s:
                        domains.add(s)
                except Exception:
                    pass

print("\n=== HTTP/WS URLs ===")
for u in sorted(urls):
    print(u)
print(f"\nTotal URLs: {len(urls)}")

print("\n=== Domain-like strings from DEX ===")
for d in sorted(domains)[:80]:
    print(d)
print(f"\nTotal domains (filtered): {len(domains)}")
