"""Unit tests for the hook's pure logic. Run INSIDE the LiteLLM image (which
has litellm + httpx installed — the host tree deliberately doesn't):

  docker run --rm \
    -v "$(pwd)/.claude/skills/add-routing/resources:/t:ro" \
    --entrypoint python ghcr.io/berriai/litellm:v1.90.0 \
    -m unittest discover -s /t -p 'test_*.py' -v
"""

import sys
import unittest

sys.path.insert(0, "/t")

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


if __name__ == "__main__":
    unittest.main()
