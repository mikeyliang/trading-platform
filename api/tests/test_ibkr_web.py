"""IBKR Web API client: OAuth maths against a locally simulated IBKR, and
the response mappers. No network."""
import asyncio
import base64
import hashlib
import hmac
import json
import secrets
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.services import ibkr_web, ibkr_web_oauth as oauth

# A small safe prime is enough to exercise the maths; IBKR's is 2048-bit.
DH_PRIME_HEX = "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff"


def _pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


@pytest.fixture(scope="module")
def creds():
    sig = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    enc = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    secret_plain = secrets.token_bytes(32)
    secret_cipher = enc.public_key().encrypt(secret_plain, padding.PKCS1v15())
    c = oauth.OAuthCredentials(
        consumer_key="TESTCONS1",
        access_token="tok123",
        access_token_secret=base64.b64encode(secret_cipher).decode(),
        dh_prime_hex=DH_PRIME_HEX,
        signature_key_pem=_pem(sig),
        encryption_key_pem=_pem(enc),
    )
    return c, secret_plain


def test_prepend_is_decrypted_secret_hex(creds):
    c, plain = creds
    assert oauth.access_token_secret_prepend(c) == plain.hex()


def test_base_string_sorts_and_encodes():
    s = oauth.base_string("GET", "https://api.ibkr.com/v1/api/x", {"b": "2 3", "a": "1"})
    assert s == "GET&https%3A%2F%2Fapi.ibkr.com%2Fv1%2Fapi%2Fx&a%3D1%26b%3D2%25203"


def test_lst_round_trip_matches_server_derivation(creds):
    """Play IBKR's side of the Diffie-Hellman exchange and check both ends
    derive the same live session token and signature."""
    c, plain = creds
    prime = int(DH_PRIME_HEX, 16)
    a = oauth.dh_private()
    challenge = oauth.dh_challenge(c, a)
    b = secrets.randbits(256)
    response = format(pow(2, b, prime), "x")
    k = pow(int(challenge, 16), b, prime)
    k_bytes = k.to_bytes((k.bit_length() + 7) // 8, "big")
    if k_bytes[0] & 0x80:
        k_bytes = b"\x00" + k_bytes
    server_lst = base64.b64encode(hmac.new(k_bytes, plain, hashlib.sha1).digest()).decode()
    server_sig = hmac.new(base64.b64decode(server_lst), c.consumer_key.encode(), hashlib.sha1).hexdigest()

    client_lst = oauth.live_session_token(c, a, response, oauth.access_token_secret_prepend(c))
    assert client_lst == server_lst
    assert oauth.validate_live_session_token(c, client_lst, server_sig)
    assert not oauth.validate_live_session_token(c, client_lst, "00" * 20)


def test_lst_request_signature_verifies_with_public_key(creds):
    c, plain = creds
    url = "https://api.ibkr.com/v1/api/oauth/live_session_token"
    headers = oauth.lst_request_headers(c, url, "abc123", plain.hex(), oauth_nonce="n0nce", oauth_timestamp="1700000000")
    params = _parse_auth(headers["Authorization"])
    assert params.pop("realm") == "limited_poa"
    signature = base64.b64decode(unquote(params.pop("oauth_signature")))
    expected = (plain.hex() + oauth.base_string("POST", url, params)).encode()
    c.signature_key().public_key().verify(signature, expected, padding.PKCS1v15(), hashes.SHA256())


def test_signed_headers_hmac(creds):
    c, _ = creds
    lst = base64.b64encode(b"k" * 20).decode()
    url = "https://api.ibkr.com/v1/api/iserver/marketdata/snapshot"
    headers = oauth.signed_headers(c, lst, "GET", url, {"conids": "265598", "fields": "31,84"},
                                   oauth_nonce="n", oauth_timestamp="1")
    params = _parse_auth(headers["Authorization"])
    params.pop("realm")
    sig = unquote(params.pop("oauth_signature"))
    base = oauth.base_string("GET", url, {**params, "conids": "265598", "fields": "31,84"})
    expected = base64.b64encode(hmac.new(b"k" * 20, base.encode(), hashlib.sha256).digest()).decode()
    assert sig == expected


def _parse_auth(header: str) -> dict:
    assert header.startswith("OAuth ")
    out = {}
    for part in header[6:].split(", "):
        k, v = part.split("=", 1)
        out[k] = v.strip('"')
    return out


# ── mappers ─────────────────────────────────────────────────────────────────

def test_map_quote_strips_status_prefix_and_derives_change():
    q = ibkr_web.map_quote("spy", {"31": "C586.12", "84": "586.10", "86": "586.14", "87": "1,234", "7296": "580.00"})
    assert q["symbol"] == "SPY"
    assert q["last"] == 586.12 and q["bid"] == 586.10 and q["volume"] == 1234
    assert q["change"] == 6.12 and round(q["change_pct"], 3) == round(6.12 / 580 * 100, 3)
    assert ibkr_web.map_quote("SPY", {"_updated": 1}) is None


def test_map_bars_converts_ms_epoch():
    bars = ibkr_web.map_bars({"data": [{"t": 1762300800000, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]})
    assert bars == [{"time": 1762300800, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0}]
    assert ibkr_web.map_bars(None) == []


def test_map_account_summary():
    acct = ibkr_web.map_account_summary({
        "netliquidation": {"amount": 128734.55, "currency": "USD"},
        "buyingpower": {"amount": 214300},
        "totalcashvalue": {"amount": 41250.12},
        "unrealizedpnl": {"amount": 518},
        "realizedpnl": {"amount": 6420.3},
    }, "U1234567")
    assert acct["equity"] == 128734.55 and acct["buying_power"] == 214300 and acct["balance"] == 41250.12
    assert acct["mode"] == "live" and acct["account_id"] == "U1234567"
    assert ibkr_web.map_account_summary({}, "DU1")["mode"] == "paper" if ibkr_web.map_account_summary({}, "DU1") else True


def test_map_position_option_and_stock():
    opt = ibkr_web.map_position({
        "conid": 1, "ticker": "RUT", "assetClass": "OPT", "position": -4, "avgPrice": 2.10, "mktPrice": 1.15,
        "unrealizedPnl": 380, "multiplier": "100", "strike": "2050", "expiry": "20261120", "putOrCall": "P",
    })
    assert opt["symbol"] == "RUT" and opt["is_option"] and opt["right"] == "P" and opt["strike"] == 2050
    assert opt["quantity"] == -4 and opt["unrealized_pnl"] == 380 and opt["unrealized_pnl_pct"] == round(380 / (4 * 2.10 * 100) * 100, 2)
    stk = ibkr_web.map_position({"conid": 2, "ticker": "AAPL", "assetClass": "STK", "position": 50, "avgCost": 221, "mktPrice": 228.4, "unrealizedPnl": 370})
    assert stk["symbol"] == "AAPL" and not stk["is_option"] and stk["avg_price"] == 221
    assert ibkr_web.map_position({"ticker": "X", "position": 0}) is None


def test_chain_helpers():
    assert ibkr_web.month_code("20261120") == "NOV26"
    assert ibkr_web.select_window([1, 2, 3, 4, 5, 6, 7], 4, 1) == [3, 4, 5]
    assert ibkr_web.select_window([1, 2, 3], None, 5) == [1, 2, 3]
    assert ibkr_web.nearest([10, 20, 30], 24) == 20
    rows = [{"conid": "756733", "symbol": "SPY", "sections": [{"secType": "STK"}, {"secType": "OPT", "months": "NOV26;DEC26"}]}]
    assert ibkr_web.pick_conid(rows, "SPY", "STK") == 756733
    assert ibkr_web.option_months(rows, 756733) == ["NOV26", "DEC26"]
    row = ibkr_web.map_option_row({"strike": 2050, "right": "P", "expiry": "20261120"},
                                  {"84": "1.10", "86": "1.20", "7308": "-0.18", "7633": "24.5", "7638": "1200"})
    assert row["mid"] == 1.15 and row["delta"] == -0.18 and row["iv"] == 0.245 and row["oi"] == 1200


# ── client against a fake IBKR over httpx.MockTransport ─────────────────────

def test_client_session_and_quote(creds, monkeypatch):
    c, plain = creds
    prime = int(DH_PRIME_HEX, 16)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = urlsplit(str(request.url)).path.replace("/v1/api", "")
        calls.append(path)
        auth = request.headers.get("Authorization", "")
        assert auth.startswith('OAuth realm="limited_poa"')
        if path == "/oauth/live_session_token":
            params = _parse_auth(auth)
            challenge = int(params["diffie_hellman_challenge"], 16)
            b = secrets.randbits(256)
            k = pow(challenge, b, prime)
            kb = k.to_bytes((k.bit_length() + 7) // 8, "big")
            if kb[0] & 0x80:
                kb = b"\x00" + kb
            lst = base64.b64encode(hmac.new(kb, plain, hashlib.sha1).digest()).decode()
            return httpx.Response(200, json={
                "diffie_hellman_response": format(pow(2, b, prime), "x"),
                "live_session_token_signature": hmac.new(base64.b64decode(lst), c.consumer_key.encode(), hashlib.sha1).hexdigest(),
                "live_session_token_expiration": 4102444800000,
            })
        if path == "/iserver/auth/ssodh/init":
            return httpx.Response(200, json={"authenticated": True, "connected": True})
        if path == "/portfolio/accounts":
            return httpx.Response(200, json=[{"accountId": "U777"}])
        if path == "/iserver/accounts":
            return httpx.Response(200, json={"accounts": ["U777"]})
        if path == "/iserver/secdef/search":
            return httpx.Response(200, json=[{"conid": 756733, "symbol": "SPY", "sections": [{"secType": "STK"}]}])
        if path == "/iserver/marketdata/snapshot":
            q = parse_qs(urlsplit(str(request.url)).query)
            assert q["conids"] == ["756733"]
            return httpx.Response(200, json=[{"conid": 756733, "31": "586.12", "84": "586.10", "86": "586.14", "82": "6.12", "83": "1.05"}])
        return httpx.Response(404, json={"error": path})

    client = ibkr_web.IbkrWebClient(c, "https://api.ibkr.com/v1/api", transport=httpx.MockTransport(handler))

    async def run():
        assert await client.ensure_session()
        assert client.state.authenticated and client.state.account_id == "U777"
        q = await client.quote("SPY")
        await client.aclose()
        return q

    q = asyncio.run(run())
    assert q["last"] == 586.12 and q["change_pct"] == 1.05 and q["source"] == "web"
    assert calls[:4] == ["/oauth/live_session_token", "/iserver/auth/ssodh/init", "/portfolio/accounts", "/iserver/accounts"]


def test_client_without_credentials_is_inert():
    client = ibkr_web.IbkrWebClient(None, "https://api.ibkr.com/v1/api")
    assert not client.available
    assert asyncio.run(client.ensure_session()) is False
    assert client.state.as_dict()["enabled"] is False
