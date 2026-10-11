#!/usr/bin/env bash
# Publishes a self-hosted Clef-Flash classifier as https://$CLEF_HOST for the mail Worker's
# Inbox categories (worker/src/classifier.ts), instead of Workers AI. Idempotent:
#   1. an Access service token for the Worker, saved to $SECRETS_DIR/clef_access_client_id
#      and clef_access_client_secret (never printed), created only if those files are missing;
#   2. an Access app on $CLEF_HOST that admits that token and nothing else;
#   3. a route on an existing Cloudflare Tunnel (the one that already serves $TUNNEL_HOST, whose
#      cloudflared runs on the classifier's machine) to http://localhost:$CLEF_PORT;
#   4. the proxied CNAME to that tunnel;
#   5. the Worker's secrets: CLASSIFIER_URL and the token (wrangler secret put, from the files).
#
# What has to answer on localhost:$CLEF_PORT: any SystemOne endpoint, POST /v1/systemone, e.g. a
# thin HTTP wrapper around joint_schema_model.systemone() from a local Clef-Flash checkpoint.
# Start it first; until it answers, the Worker keeps every message's quick guess and retries
# with backoff.
#
#   CLEF_HOST=clef.example.com TUNNEL_HOST=app.example.com deploy/clef/cloudflare.sh
#   CLEF_HOST=clef.example.com TUNNEL_HOST=app.example.com deploy/clef/cloudflare.sh --check
#
#   CLEF_HOST    the classifier's public hostname (in a zone on this Cloudflare account)
#   CLEF_ZONE    that zone (default: CLEF_HOST without its first label)
#   TUNNEL_HOST  a hostname an existing tunnel already serves; the new route joins that tunnel
#   CLEF_PORT    where the classifier listens on the tunnel's machine (default 8098)
#   SECRETS_DIR  where credentials are read and written (default ~/.config/secrets)
#
# Reads $SECRETS_DIR/cloudflare_api_token: an API token with Access, Tunnel and DNS edit on the zone.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
secrets="${SECRETS_DIR:-$HOME/.config/secrets}"
: "${CLEF_HOST:?set CLEF_HOST, e.g. clef.example.com}"
: "${TUNNEL_HOST:?set TUNNEL_HOST, a hostname your existing tunnel already serves}"
CLEF_ZONE="${CLEF_ZONE:-${CLEF_HOST#*.}}"
check=0
[[ "${1:-}" == "--check" ]] && check=1

CF_TOKEN="$(cat "$secrets/cloudflare_api_token")" CHECK=$check SECRETS="$secrets" CLEF_PORT="${CLEF_PORT:-8098}" \
  CLEF_HOST="$CLEF_HOST" CLEF_ZONE="$CLEF_ZONE" TUNNEL_HOST="$TUNNEL_HOST" python3 - <<'PY'
import json, os, urllib.request, urllib.error

HOST = os.environ["CLEF_HOST"]
ZONE = os.environ["CLEF_ZONE"]
SERVICE = f"http://localhost:{os.environ['CLEF_PORT']}"
SIBLING = os.environ["TUNNEL_HOST"]  # the tunnel to reuse
TOKEN_NAME = "personal-mail Worker -> Clef"
CHECK = os.environ["CHECK"] == "1"
SECRETS = os.environ["SECRETS"]
ID_FILE, SECRET_FILE = f"{SECRETS}/clef_access_client_id", f"{SECRETS}/clef_access_client_secret"
TOKEN = os.environ["CF_TOKEN"]

def cf(method, path, body=None):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        data = json.load(e)
    if not data.get("success"):
        raise SystemExit(f"{method} {path} failed: {data.get('errors')}")
    return data["result"]

def would(what):
    print(f"would {what}" if CHECK else what)

zone = cf("GET", f"/zones?name={ZONE}")[0]
acc, zone_id = zone["account"]["id"], zone["id"]

# 1. The Worker's service token. Its secret is only shown when it's made, so it goes straight to a file.
tokens = cf("GET", f"/accounts/{acc}/access/service_tokens?per_page=100")
token = next((t for t in tokens if t["name"] == TOKEN_NAME), None)
have_files = os.path.exists(ID_FILE) and os.path.exists(SECRET_FILE)
if token and have_files:
    print(f"service token: '{TOKEN_NAME}' exists, credentials in {SECRETS}")
elif token and not have_files:
    raise SystemExit(f"service token '{TOKEN_NAME}' exists but its secret isn't in {SECRETS}: rotate it in Zero Trust, or delete it to make a new one")
elif CHECK:
    print(f"would create service token '{TOKEN_NAME}' and save it to {ID_FILE} / {SECRET_FILE}")
else:
    token = cf("POST", f"/accounts/{acc}/access/service_tokens", {"name": TOKEN_NAME, "duration": "8760h"})
    old = os.umask(0o077)
    try:
        for path, value in ((ID_FILE, token["client_id"]), (SECRET_FILE, token["client_secret"])):
            with open(path, "w") as f:
                f.write(value)
            os.chmod(path, 0o600)
    finally:
        os.umask(old)
    print(f"service token: created '{TOKEN_NAME}' (one year), saved to {SECRETS}")

# 2. Access first, so the hostname is never reachable without it.
apps = cf("GET", f"/accounts/{acc}/access/apps?per_page=100")
if any(a.get("domain") == HOST for a in apps):
    print(f"access: app for {HOST} exists")
elif CHECK or not token:
    would(f"create an Access app for {HOST} admitting only that token")
else:
    cf("POST", f"/accounts/{acc}/access/apps", {
        "name": "Clef-Flash (personal-mail Worker)",
        "domain": HOST,
        "type": "self_hosted",
        "session_duration": "24h",
        "app_launcher_visible": False,
        "policies": [{
            "name": "Allow the mail Worker (service token)",
            "decision": "non_identity",
            "include": [{"service_token": {"token_id": token["id"]}}],
            "precedence": 1,
        }],
    })
    print(f"access: created app for {HOST} (service token only)")

# 3. Tunnel route, inserted before the catch-all.
tunnel = config = None
for t in cf("GET", f"/accounts/{acc}/cfd_tunnel?is_deleted=false&per_page=100"):
    cfg = cf("GET", f"/accounts/{acc}/cfd_tunnel/{t['id']}/configurations").get("config") or {}
    if any(r.get("hostname") == SIBLING for r in cfg.get("ingress", [])):
        tunnel, config = t, cfg
        break
if not tunnel:
    raise SystemExit(f"no tunnel serves {SIBLING}")
ingress = config["ingress"]
if any(r.get("hostname") == HOST for r in ingress):
    print(f"tunnel {tunnel['name']}: {HOST} already routed")
elif CHECK:
    would(f"route {HOST} -> {SERVICE} on tunnel {tunnel['name']}")
else:
    at = next((i for i, r in enumerate(ingress) if "hostname" not in r), len(ingress))
    ingress.insert(at, {"hostname": HOST, "service": SERVICE, "originRequest": {}})
    cf("PUT", f"/accounts/{acc}/cfd_tunnel/{tunnel['id']}/configurations", {"config": config})
    print(f"tunnel {tunnel['name']}: routed {HOST} -> {SERVICE}")

# 4. DNS.
target = f"{tunnel['id']}.cfargotunnel.com"
if cf("GET", f"/zones/{zone_id}/dns_records?name={HOST}"):
    print(f"dns: {HOST} exists")
elif CHECK:
    would(f"add CNAME {HOST} -> {target} (proxied)")
else:
    cf("POST", f"/zones/{zone_id}/dns_records", {"type": "CNAME", "name": HOST, "content": target, "proxied": True})
    print(f"dns: {HOST} -> {target}")
PY

# 5. The Worker: where to ask, and the token to ask with (piped from the files, never echoed).
if [[ $check == 1 ]]; then
  echo "would set the Worker secrets CLASSIFIER_URL, CLASSIFIER_ACCESS_CLIENT_ID and CLASSIFIER_ACCESS_CLIENT_SECRET"
  exit 0
fi
cd "$here/../../worker"
printf '%s' "https://$CLEF_HOST/v1/systemone" | npx wrangler secret put CLASSIFIER_URL
npx wrangler secret put CLASSIFIER_ACCESS_CLIENT_ID < "$secrets/clef_access_client_id"
npx wrangler secret put CLASSIFIER_ACCESS_CLIENT_SECRET < "$secrets/clef_access_client_secret"
echo "done: the Worker asks https://$CLEF_HOST/v1/systemone from its next sweep (every minute)"
