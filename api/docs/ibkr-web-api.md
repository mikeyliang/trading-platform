# IBKR Web API data layer

The api serves account, positions, quotes, history and option chains from the
IBKR Web API (`api.ibkr.com`) when it is configured, and falls back to the IB
Gateway (ib_async) feed otherwise. The tape, depth of market and the bot's order
execution always use the Gateway. `/health` reports which source answered each
feed under `data.sources`, and the Settings page shows the same.

Nothing changes for the dashboard: the `/api/*` endpoints and their shapes are
the same whichever source answers.

## One-time setup in Client Portal

IBKR issues OAuth 1.0a credentials for individual accounts without a Gateway.

1. Generate two RSA keys and a Diffie-Hellman parameter file:

   ```bash
   openssl genrsa -out private_signature.pem 2048
   openssl rsa -in private_signature.pem -outform PEM -pubout -out public_signature.pem
   openssl genrsa -out private_encryption.pem 2048
   openssl rsa -in private_encryption.pem -outform PEM -pubout -out public_encryption.pem
   openssl dhparam -outform PEM 2048 -out dhparam.pem
   ```

2. In Client Portal go to Settings > User Settings > OAuth (Third-party
   access, "Self-service OAuth"). Create a consumer key (9 characters), upload
   `public_signature.pem`, `public_encryption.pem` and `dhparam.pem`, and
   generate the access token and access token secret. The secret is the
   base64 ciphertext shown there; keep it as is.
3. Activation can take up to a day for live accounts. Paper accounts need
   their own consumer key, created while logged in to the paper account.
4. Extract the DH prime as hex:

   ```bash
   openssl dhparam -in dhparam.pem -text -noout | sed -n '/prime:/,/generator/p' | grep -v prime | grep -v generator | tr -d ' :\n'
   ```

## Environment variables

| Variable | Value |
| --- | --- |
| `IBKR_WEB_ENABLED` | `true` |
| `IBKR_WEB_CONSUMER_KEY` | consumer key from Client Portal |
| `IBKR_WEB_ACCESS_TOKEN` | access token |
| `IBKR_WEB_ACCESS_TOKEN_SECRET` | access token secret (base64 ciphertext) |
| `IBKR_WEB_DH_PRIME` | prime from `dhparam.pem` as hex |
| `IBKR_WEB_SIGNATURE_KEY_FP` | path to `private_signature.pem` |
| `IBKR_WEB_ENCRYPTION_KEY_FP` | path to `private_encryption.pem` |
| `IBKR_WEB_ACCOUNT_ID` | optional; defaults to the first account the API lists |
| `IBKR_WEB_REALM` | `limited_poa` (default; `test_realm` for IBKR's test consumer) |
| `IBKR_WEB_CHAIN_MONTHS` | expirations to expose per chain (default 6) |
| `IBKR_WEB_CHAIN_WINDOW` | strikes each side of spot per expiry (default 12) |

Mount the two private keys into the api container and point the `_FP`
variables at them. Never commit the keys or the token secret.

## Session behaviour

On startup the api derives a live session token (RSA-signed request plus a
Diffie-Hellman exchange), opens the brokerage session with
`/iserver/auth/ssodh/init` and keeps it alive with `/tickle` every minute. A
401 drops the session and the next request re-authenticates. While the Web API
is down or unconfigured, every feed silently uses the Gateway and the Settings
page says so. The Web API session competes with Client Portal and TWS logins
on the same username; use a second user for the dashboard if you also trade
from TWS.

## What stays on the Gateway

Streaming prints (`reqTickByTick`), the depth panel (`reqMktDepth`) and the
bot's order placement. The Web API has a websocket for quotes and order
updates, but no tick-by-tick stream, so the tape needs the Gateway.
