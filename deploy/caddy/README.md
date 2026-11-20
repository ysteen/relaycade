# Dedicated administration listener

This optional Caddy configuration exposes the bridge dashboard at
`https://<ROMM_HOST>:8083/` and the RomM library and login at
`https://<ROMM_HOST>:8443/`. Both listeners use the same host so the browser can
reuse its RomM session cookie. Only the administration routes are proxied on
8083. RomM checks the administrator role before serving the dashboard or its
data.

Point these environment variables at the services and the public entry files
as seen from Caddy:

| Variable | Example |
| --- | --- |
| `ROMM_HOST` | `romm.lan` |
| `ROMM_UPSTREAM` | `romm:8080` |
| `BRIDGE_UPSTREAM` | `netplay-bridge:8080` |
| `ADMIN_ENTRY_DIR` | `/etc/caddy/bridge-admin-public` |

Use the accompanying `public/` directory for `ADMIN_ENTRY_DIR`. The example
uses Caddy's internal CA. Clients must already trust that CA to open the page.
A deployment with a public hostname can configure its normal TLS certificates.
Validate the Caddyfile with these variables set before loading it.

The older dashboard URL on 8443 points to 8083. When no administrator session
is present, the 8083 page offers the RomM login in a new tab and checks access
again when focus returns. The bridge service token stays on the server.
