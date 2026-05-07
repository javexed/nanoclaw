# Verify Webchat

1. Open `http://127.0.0.1:3100/` (or your configured host:port) in a browser.
2. If you set `WEBCHAT_TOKEN`, paste it on the login screen.
3. Use the PWA to create an agent, then send it a message — the agent should reply within a few seconds.

If the page won't load, check `logs/nanoclaw.log` for `Webchat HTTP listening` at startup.
