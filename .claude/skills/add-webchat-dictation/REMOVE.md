# Remove webchat voice dictation

Reverses the installer. The dark code in the webchat channel stays (it's inert
without the env keys); this removes the backend and the configuration.

```bash
# 1. Stop and remove the local backend container (skip if you used ElevenLabs / --url)
docker rm -f nanoclaw-whisper-stt

# 2. Remove the downloaded model file(s)
rm -rf data/stt

# 3. Drop the env keys (removes the mic from every client)
sed -i.bak '/^WEBCHAT_STT_/d' .env && rm -f .env.bak

# 4. Clear the cleanup-model choice (optional; harmless to leave)
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE webchat_settings SET stt_cleanup_model_id = NULL WHERE id = 1"

# 5. Restart the host so the running process forgets the env
systemctl --user restart nanoclaw     # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```
