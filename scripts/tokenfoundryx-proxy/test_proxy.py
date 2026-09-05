import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8787"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, r.read().decode()


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer test"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


print("health:", get("/health"))
code, text = post(
    "/v1/chat/completions",
    {
        "model": "gpt-5.6-sol",
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 32,
        "stream": False,
    },
)
print("chat status:", code)
print(text[:1000])
obj = json.loads(text)
print("assistant:", (obj.get("choices") or [{}])[0].get("message", {}).get("content"))
