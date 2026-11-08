"""OAuth 1.0a signing for the IBKR Web API (api.ibkr.com).

Pure functions, no network. The flow IBKR specifies for a self-service
consumer (Client Portal > Settings > OAuth):

1. Live session token (LST). POST ``/oauth/live_session_token`` signed with
   RSA-SHA256 by the *signature* private key. The base string is prefixed
   with the access-token secret decrypted by the *encryption* private key
   (the "prepend"), and the request carries a Diffie-Hellman challenge
   ``g^a mod p`` using IBKR's prime from the uploaded ``dhparam.pem``.
2. IBKR answers with ``g^b mod p``. Both sides derive ``K = g^ab mod p``;
   the LST is ``base64(HMAC-SHA1(key=K, msg=prepend bytes))``. IBKR also
   returns ``HMAC-SHA1(key=LST, msg=consumer_key)`` so the client can check
   it derived the same token.
3. Every later request is signed HMAC-SHA256 with the LST as key, over the
   usual OAuth base string (method, URL, sorted query + oauth params).

Byte handling mirrors IBKR's reference clients: the shared secret is
big-endian with a leading zero byte when its high bit is set, so the key
matches the Java ``BigInteger.toByteArray`` IBKR uses server side.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import string
import time
from dataclasses import dataclass
from typing import Dict, Mapping, Optional
from urllib.parse import quote, quote_plus

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

_ALNUM = string.ascii_letters + string.digits


@dataclass(frozen=True)
class OAuthCredentials:
    consumer_key: str
    access_token: str
    access_token_secret: str  # base64 ciphertext, as issued by Client Portal
    dh_prime_hex: str
    signature_key_pem: bytes
    encryption_key_pem: bytes
    realm: str = "limited_poa"
    dh_generator: int = 2

    def signature_key(self) -> rsa.RSAPrivateKey:
        key = serialization.load_pem_private_key(self.signature_key_pem, password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise ValueError("signature key is not an RSA private key")
        return key

    def encryption_key(self) -> rsa.RSAPrivateKey:
        key = serialization.load_pem_private_key(self.encryption_key_pem, password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise ValueError("encryption key is not an RSA private key")
        return key


def nonce(length: int = 16) -> str:
    return "".join(secrets.choice(_ALNUM) for _ in range(length))


def timestamp() -> str:
    return str(int(time.time()))


def percent_encode(value: str) -> str:
    # RFC 5849 encoding: unreserved characters only, uppercase hex.
    return quote(str(value), safe="-._~")


def base_string(method: str, url: str, params: Mapping[str, str]) -> str:
    """OAuth 1.0a signature base string. ``params`` holds the oauth_* values
    plus any query parameters, all unencoded."""
    pairs = sorted((percent_encode(k), percent_encode(v)) for k, v in params.items())
    normalized = "&".join(f"{k}={v}" for k, v in pairs)
    return "&".join([method.upper(), percent_encode(url), percent_encode(normalized)])


# ── live session token ───────────────────────────────────────────────────────

def access_token_secret_prepend(creds: OAuthCredentials) -> str:
    """Decrypt the access-token secret with the encryption key. IBKR uses
    PKCS#1 v1.5; the plaintext, as hex, prefixes the LST base string and is
    the HMAC message when deriving the LST."""
    ciphertext = base64.b64decode(creds.access_token_secret)
    plaintext = creds.encryption_key().decrypt(ciphertext, padding.PKCS1v15())
    return plaintext.hex()


def dh_private() -> int:
    return secrets.randbits(256)


def dh_challenge(creds: OAuthCredentials, private: int) -> str:
    prime = int(creds.dh_prime_hex, 16)
    return format(pow(creds.dh_generator, private, prime), "x")


def _big_endian_with_sign(value: int) -> bytes:
    raw = value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")
    # Java's BigInteger.toByteArray() keeps a sign bit, so a value whose
    # high bit is set gains a leading zero byte. IBKR keys the HMAC with
    # exactly those bytes.
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return raw


def live_session_token(creds: OAuthCredentials, private: int, dh_response_hex: str, prepend_hex: str) -> str:
    prime = int(creds.dh_prime_hex, 16)
    shared = pow(int(dh_response_hex, 16), private, prime)
    key = _big_endian_with_sign(shared)
    digest = hmac.new(key, bytes.fromhex(prepend_hex), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def validate_live_session_token(creds: OAuthCredentials, lst_b64: str, signature_hex: str) -> bool:
    expected = hmac.new(base64.b64decode(lst_b64), creds.consumer_key.encode(), hashlib.sha1).hexdigest()
    return hmac.compare_digest(expected, signature_hex)


def lst_request_headers(creds: OAuthCredentials, url: str, challenge_hex: str, prepend_hex: str,
                        *, oauth_nonce: Optional[str] = None, oauth_timestamp: Optional[str] = None) -> Dict[str, str]:
    """Authorization header for POST /oauth/live_session_token."""
    params = {
        "oauth_consumer_key": creds.consumer_key,
        "oauth_nonce": oauth_nonce or nonce(),
        "oauth_signature_method": "RSA-SHA256",
        "oauth_timestamp": oauth_timestamp or timestamp(),
        "oauth_token": creds.access_token,
        "diffie_hellman_challenge": challenge_hex,
    }
    to_sign = (prepend_hex + base_string("POST", url, params)).encode()
    signature = creds.signature_key().sign(to_sign, padding.PKCS1v15(), hashes.SHA256())
    params["oauth_signature"] = quote_plus(base64.b64encode(signature).decode())
    return _authorization(creds.realm, params)


# ── signed requests ──────────────────────────────────────────────────────────

def signed_headers(creds: OAuthCredentials, lst_b64: str, method: str, url: str,
                   query: Optional[Mapping[str, str]] = None, *,
                   oauth_nonce: Optional[str] = None, oauth_timestamp: Optional[str] = None) -> Dict[str, str]:
    """Authorization header for an ordinary request once the LST is held.
    ``url`` is the request URL without its query string; ``query`` holds the
    query parameters, which are part of the signature. JSON bodies are not."""
    oauth = {
        "oauth_consumer_key": creds.consumer_key,
        "oauth_nonce": oauth_nonce or nonce(),
        "oauth_signature_method": "HMAC-SHA256",
        "oauth_timestamp": oauth_timestamp or timestamp(),
        "oauth_token": creds.access_token,
    }
    params = {**(query or {}), **oauth}
    digest = hmac.new(base64.b64decode(lst_b64), base_string(method, url, params).encode(), hashlib.sha256).digest()
    oauth["oauth_signature"] = quote_plus(base64.b64encode(digest).decode())
    return _authorization(creds.realm, oauth)


def _authorization(realm: str, params: Mapping[str, str]) -> Dict[str, str]:
    body = ", ".join(f'{k}="{v}"' for k, v in sorted(params.items()))
    return {"Authorization": f'OAuth realm="{realm}", {body}'}
