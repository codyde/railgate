# railgate

Self-hostable localhost tunnel. Like ngrok, except the relay runs on infrastructure you own.

```bash
# One-time setup — deploys a relay to Railway, saves config
npx railgate setup

# Expose any local port
npx railgate http 3000
```

## How it works

`railgate` is two pieces:

- A **CLI client** that runs on your laptop and connects to a relay over a WebSocket control channel.
- A **relay** that lives on the public internet, accepts incoming HTTP/WebSocket traffic, and forwards it through the control channel to your laptop.

`npx railgate setup` is the one-time provisioning step:

1. Generates a shared token between your CLI and your relay.
2. Opens Railway in your browser. You authorize railgate (standard OAuth, no client secret).
3. railgate creates a Railway project for you, deploys the relay image, waits for it to come up, captures the public URL, and verifies it responds correctly.
4. Saves everything to `~/.config/railgate/config.json` (chmod 600).

After that, `npx railgate http <port>` just works.

## Configuration

Effective config resolves as `flags > env vars > saved config`.

| Source | Format |
|---|---|
| CLI flags | `--relay <url>`, `--token <value>`, `--subdomain <name>` |
| Env vars | `RAILGATE_RELAY_URL`, `RAILGATE_TOKEN` |
| Saved | `~/.config/railgate/config.json` (or `$XDG_CONFIG_HOME/railgate/config.json`) |

## Alternative setup modes

```bash
# Skip the browser entirely — paste a relay URL + token you already have
npx railgate setup --manual

# Use the legacy "open a browser, paste back the URL" deploy flow
npx railgate setup --browser
```

## Self-hosting the relay outside Railway

The relay is a small Node service. Pull it directly:

```bash
docker run -d \
  -p 3000:3000 \
  -e RAILGATE_TOKEN=$(openssl rand -base64 32) \
  -e BASE_DOMAIN=relay.example.com \
  -e PROTOCOL=https \
  ghcr.io/codyde/railgate-relay:latest
```

Then `railgate setup --manual` and point it at your relay.

## Repo

https://github.com/codyde/railgate

## License

MIT
