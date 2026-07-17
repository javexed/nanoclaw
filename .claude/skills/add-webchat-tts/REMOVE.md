# Remove webchat TTS

Reverses what `/add-webchat-tts` provisioned. The skill makes **no core-code
edits** — the host route and PWA control ship with the webchat channel and stay
inert once the flag is off. Removal is the container + the `.env` flags.

```bash
# 1. Stop and remove the Kokoro backend container
docker rm -f nanoclaw-kokoro-tts 2>/dev/null || true

# 2. Turn the feature off in .env (removes the four keys)
sed -i.bak '/^WEBCHAT_TTS_/d' .env && rm -f .env.bak
```

3. Restart the webchat host so it drops the config:

```bash
systemctl --user restart nanoclaw                    # Linux
launchctl kickstart -k gui/$(id -u)/com.nanoclaw     # macOS
```

With `WEBCHAT_TTS_ENABLED` gone, `/api/tts/config` reports `enabled:false` and
the PWA falls back to the browser's Web Speech API (device voices). To remove
the read-aloud control **entirely**, uninstall/downgrade the webchat channel
itself — the control lives in its `app.js`, not in this skill.

4. Delete the skill folder if fully retiring: `.claude/skills/add-webchat-tts/`.
