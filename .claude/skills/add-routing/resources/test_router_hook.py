"""Unit tests for the hook's pure logic. Run INSIDE the LiteLLM image (which
has litellm + httpx installed — the host tree deliberately doesn't):

  docker run --rm \
    -v "$(pwd)/.claude/skills/add-routing/resources:/t:ro" \
    --entrypoint python ghcr.io/berriai/litellm:v1.90.0 \
    -m unittest discover -s /t -p 'test_*.py' -v
"""

import asyncio
import sys
import unittest
from unittest import mock

sys.path.insert(0, "/t")

import router_hook  # noqa: E402
from router_hook import _last_user_text, _parse_route  # noqa: E402


class LastUserText(unittest.TestCase):
    def test_plain_string_content(self):
        msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hello"}]
        self.assertEqual(_last_user_text(msgs), "hello")

    def test_takes_latest_user_message(self):
        msgs = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "a"},
            {"role": "user", "content": "second"},
        ]
        self.assertEqual(_last_user_text(msgs), "second")

    def test_parts_list_content(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "part one"},
                    {"type": "image_url", "image_url": {"url": "x"}},
                    {"type": "text", "text": "part two"},
                ],
            }
        ]
        self.assertEqual(_last_user_text(msgs), "part one part two")

    def test_empty_and_none(self):
        self.assertEqual(_last_user_text(None), "")
        self.assertEqual(_last_user_text([]), "")
        self.assertEqual(_last_user_text([{"role": "assistant", "content": "a"}]), "")


class ParseRoute(unittest.TestCase):
    def test_clean_json(self):
        self.assertEqual(_parse_route('{"route": "code"}'), "code")

    def test_single_quotes(self):
        # Observed live: the GGUF sometimes answers with single quotes.
        self.assertEqual(_parse_route("{'route': 'reasoning'}"), "reasoning")

    def test_stray_prose_around_json(self):
        self.assertEqual(_parse_route('Sure! {"route": "general"} '), "general")

    def test_other_route(self):
        self.assertEqual(_parse_route('{"route": "other"}'), "other")

    def test_garbage_raises(self):
        with self.assertRaises(Exception):
            _parse_route("no json here")


LIVE_CFG = {
    "classifier": {"url": "http://unused", "model": "m"},
    "default_route": "general",
    "live": {"enabled": True, "model_name": "auto", "timeout_ms": 5000},
    "routes": [
        {"name": "code", "description": "d", "model": "qwen3-coder:30b"},
        {"name": "general", "description": "d", "model": "gemma4:latest"},
    ],
}


def _req(model="auto", text="write a function"):
    return {"model": model, "messages": [{"role": "user", "content": text}]}


class LiveRouting(unittest.IsolatedAsyncioTestCase):
    """Phase 2: the virtual 'auto' model. Classifier is mocked — no network."""

    async def _call(self, cfg, data, classify):
        with mock.patch.object(router_hook, "_load_routes", return_value=cfg), \
             mock.patch.object(router_hook, "_classify", classify), \
             mock.patch.object(router_hook, "_append_log") as logged:
            out = await router_hook.proxy_handler_instance.async_pre_call_hook(
                {}, None, data, "acompletion"
            )
            # Drain any fire-and-forget shadow task while the mocks still hold.
            for _ in range(3):
                await asyncio.sleep(0)
        return out, logged

    async def test_rewrites_auto_to_classified_binding(self):
        out, logged = await self._call(LIVE_CFG, _req(), mock.AsyncMock(return_value="code"))
        self.assertEqual(out["model"], "qwen3-coder:30b")
        entry = logged.call_args[0][0]
        self.assertEqual(entry["mode"], "live")
        self.assertEqual(entry["route"], "code")
        self.assertEqual(entry["final_model"], "qwen3-coder:30b")

    async def test_classifier_error_falls_back_to_default_binding(self):
        out, logged = await self._call(LIVE_CFG, _req(), mock.AsyncMock(side_effect=RuntimeError("down")))
        self.assertEqual(out["model"], "gemma4:latest")
        entry = logged.call_args[0][0]
        self.assertEqual(entry["route"], "__error__")
        self.assertIn("error", entry)
        self.assertEqual(entry["final_model"], "gemma4:latest")

    async def test_other_route_falls_back_to_default_binding(self):
        out, _ = await self._call(LIVE_CFG, _req(), mock.AsyncMock(return_value="other"))
        self.assertEqual(out["model"], "gemma4:latest")

    async def test_concrete_model_never_rewritten(self):
        out, logged = await self._call(
            LIVE_CFG, _req(model="qwen3-coder:30b"), mock.AsyncMock(return_value="general")
        )
        self.assertEqual(out["model"], "qwen3-coder:30b")
        # Shadow task was scheduled instead of a live log entry.
        self.assertFalse(
            any(c.args and c.args[0].get("mode") == "live" for c in logged.call_args_list)
        )

    async def test_flag_off_leaves_auto_untouched(self):
        cfg = {**LIVE_CFG, "live": {"enabled": False, "model_name": "auto"}}
        out, _ = await self._call(cfg, _req(), mock.AsyncMock(return_value="code"))
        self.assertEqual(out["model"], "auto")


if __name__ == "__main__":
    unittest.main()
