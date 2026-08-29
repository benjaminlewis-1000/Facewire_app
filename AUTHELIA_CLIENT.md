# Authelia OIDC client for PhotoVerify

Add this entry to `identity_providers.oidc.clients` in
`/home/benjamin/docker_via_tunnels/authelia/config/configuration.yml`
(same list that already has `django_picasa`), then `docker restart authelia`.

```yaml
      - client_id: 'photoverify_mobile'
        client_name: 'PhotoVerify Mobile'
        public: true
        authorization_policy: 'one_factor'
        consent_mode: 'implicit'
        claims_policy: 'photoverify'
        lifespan: 'photoverify'
        require_pkce: true
        pkce_challenge_method: 'S256'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
          - 'offline_access'
        response_types:
          - 'code'
        grant_types:
          - 'authorization_code'
          - 'refresh_token'
        token_endpoint_auth_method: 'none'
        redirect_uris:
          - 'photoverify://redirect'
          - 'exp://100.69.34.1:8082/--/redirect'
```

And under `identity_providers.oidc:` (a sibling of `clients:` / `hmac_secret:`),
the custom lifespan + claims policy the client above references:

```yaml
    claims_policies:
      photoverify:
        id_token:
          - 'email'
          - 'email_verified'
          - 'name'
          - 'preferred_username'
    lifespans:
      custom:
        photoverify:
          access_token: '1 hour'
          authorize_code: '1 minute'
          id_token: '1 hour'
          refresh_token: '30 days'
```

Notes:
- `public: true` + `token_endpoint_auth_method: 'none'` = native app, no client secret.
- Authelia does **exact** redirect-URI matching (no wildcards / port ranges).
- `exp://100.69.34.1:8082/--/redirect` is for testing in Expo Go. The dev
  server is pinned to port 8082 (`npm run start:tailscale`). If the port ever
  changes, the app logs its real redirect URI to the Metro console on the
  login screen (`=== PhotoVerify OIDC redirect URI`) — register that value.
- `photoverify://redirect` is what the installed APK uses; the `exp://` entry
  can be dropped once you're only running the APK.
