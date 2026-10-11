"""Writes test/fixtures/dkim.ts: messages signed by dkimpy, an independent DKIM
implementation, so the Worker's verifier isn't only checked against itself.

Keys are generated fresh on every run and only the public halves are kept.

    python3 -m venv /tmp/dkim-venv && /tmp/dkim-venv/bin/pip install dkimpy pynacl
    /tmp/dkim-venv/bin/python test/fixtures/make-dkim-fixtures.py > test/fixtures/dkim.ts
"""
import base64
import json
import re
import subprocess

import dkim
import nacl.signing

DOMAIN = b"example.org"


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


rsa_private = openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048")
spki = openssl("pkey", "-pubout", "-outform", "DER", data=rsa_private)
pkcs1 = openssl("rsa", "-RSAPublicKey_out", "-outform", "DER", data=rsa_private)
ed_private = nacl.signing.SigningKey.generate()

keys = {
    "rsa._domainkey.example.org": "v=DKIM1; k=rsa; p=" + base64.b64encode(spki).decode(),
    "pkcs1._domainkey.example.org": "v=DKIM1; k=rsa; p=" + base64.b64encode(pkcs1).decode(),
    "ed._domainkey.example.org": "v=DKIM1; k=ed25519; p=" + base64.b64encode(bytes(ed_private.verify_key)).decode(),
    # RFC 8463 Appendix A.2.
    "brisbane._domainkey.football.example.com": "v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
    "test._domainkey.football.example.com": "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR"
    "iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC"
    "DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3"
    "Ip3G+2kryOTIKT+l/K4w3QIDAQAB",
}


def dns(name, timeout=5):
    return keys.get(name.decode().rstrip("."), "").encode() or None


# Folded and padded headers, repeated header names, raw UTF-8 (including a
# trailing no-break space, byte A0), spaces at line ends and blank lines at
# the end of the body: the cases where canonicalization goes wrong.
base = (
    "Received: from relay.example.net by mx.example.org; Mon, 28 Sep 2026 10:00:00 +0000\r\n"
    "Received: from client.example.net by relay.example.net; Mon, 28 Sep 2026 09:59:59 +0000\r\n"
    "From: Ana Rivera <ana@example.org>\r\n"
    "To: alex@example.net\r\n"
    "Subject:  Cena   el\r\n"
    "\t domingo, \u00bfvienes?\u00a0\r\n"
    "Date: Mon, 28 Sep 2026 09:59:58 +0000\r\n"
    "Message-ID: <fixture@example.org>\r\n"
    "X-Tag: first\r\n"
    "X-Tag:  second  \r\n"
    "MIME-Version: 1.0\r\n"
    "Content-Type: text/plain; charset=utf-8\r\n"
    "\r\n"
    "Hola,   \u00bfvienes   \r\n"
    "el domingo?\t\r\n"
    "  \r\n"
    "Caf\u00e9 at   eight.\r\n"
    "\r\n"
    "\r\n"
).encode()
empty_body = base.split(b"\r\n\r\n")[0] + b"\r\n\r\n"
signed_headers = [b"from", b"to", b"subject", b"date", b"message-id", b"x-tag", b"x-tag", b"x-tag"]


def sign(message, selector, canon, key=rsa_private, algorithm=b"rsa-sha256", length=False):
    signature = dkim.sign(
        message,
        selector,
        DOMAIN,
        key,
        canonicalize=canon,
        signature_algorithm=algorithm,
        include_headers=signed_headers,
        length=length,
    )
    signed = signature + message
    if algorithm != b"rsa-sha1":
        assert dkim.verify(signed, dnsfunc=dns), (selector, canon)
    return signed


relaxed = (b"relaxed", b"relaxed")
simple = (b"simple", b"simple")
ed_seed = base64.b64encode(bytes(ed_private))
messages = {
    "relaxed": sign(base, b"rsa", relaxed),
    "simple": sign(base, b"rsa", simple),
    "relaxedSimple": sign(base, b"rsa", (b"relaxed", b"simple")),
    "emptyBodyRelaxed": sign(empty_body, b"rsa", relaxed),
    "emptyBodySimple": sign(empty_body, b"rsa", simple),
    "lengthLimited": sign(base, b"rsa", relaxed, length=True),
    "pkcs1Key": sign(base, b"pkcs1", relaxed),
    "ed25519": sign(base, b"ed", relaxed, key=ed_seed, algorithm=b"ed25519-sha256"),
    "sha1": sign(base, b"rsa", relaxed, algorithm=b"rsa-sha1"),
    # RFC 8463 Appendix A.3, which carries both an Ed25519 and an RSA signature.
    "rfc8463": (
        "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;\r\n"
        " d=football.example.com; i=@football.example.com;\r\n"
        " q=dns/txt; s=brisbane; t=1528637909; h=from : to :\r\n"
        " subject : date : message-id : from : subject : date;\r\n"
        " bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;\r\n"
        " b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus\r\n"
        " Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==\r\n"
        "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;\r\n"
        " d=football.example.com; i=@football.example.com;\r\n"
        " q=dns/txt; s=test; t=1528637909; h=from : to : subject :\r\n"
        " date : message-id : from : subject : date;\r\n"
        " bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;\r\n"
        " b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3\r\n"
        " DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz\r\n"
        " dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=\r\n"
        "From: Joe SixPack <joe@football.example.com>\r\n"
        "To: Suzie Q <suzie@shopping.example.net>\r\n"
        "Subject: Is dinner ready?\r\n"
        "Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)\r\n"
        "Message-ID: <20030712040037.46341.5F8J@football.example.com>\r\n"
        "\r\n"
        "Hi.\r\n"
        "\r\n"
        "We lost the game.  Are you hungry yet?\r\n"
        "\r\n"
        "Joe.\r\n"
        "\r\n"
    ).encode(),
}
assert dkim.verify(messages["rfc8463"], dnsfunc=dns)
assert re.search(rb"a=rsa-sha1", messages["sha1"])


def ts(value):
    return json.dumps(value, ensure_ascii=False)


print("// Generated by make-dkim-fixtures.py (signed with dkimpy, fresh keys each run). Do not edit.")
print()
print("/** TXT records by DNS name. */")
print("export const dkimKeys: Record<string, string> = {")
for name, value in keys.items():
    print(f"  {ts(name)}: {ts(value)},")
print("};")
print()
print("/** Signed messages, as UTF-8 text (encode with TextEncoder for the exact bytes). */")
print("export const dkimMessages = {")
for name, value in messages.items():
    print(f"  {name}: {ts(value.decode())},")
print("};")
