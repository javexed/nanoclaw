"""Shadow routing hook — llm-router.md §16b (N-way capability classifier).

Registered as a LiteLLM proxy callback. On every completion request it
FIRE-AND-FORGETS a classification task (Arch-Router on a LAN Ollama) and logs
the decision to a JSONL file. It NEVER modifies the request and NEVER blocks
it — shadow mode's contract is zero behavior change and zero added latency.
(Live routing — rewriting data["model"] for a virtual 'auto' model — is the
next phase and lands behind an explicit flag in routes.json.)

Files (mounted from the host's data/litellm/routing/):
  /app/routing/routes.json           route catalog + classifier endpoint
  /app/routing/routing-shadow.jsonl  one line per classified request

Failure posture: any error (classifier host asleep, timeout, bad JSON) logs a
line with route="__error__" and moves on. The proxy's data path is untouchable.
"""

import asyncio
import json
import time

import httpx
from litellm.integrations.custom_logger import CustomLogger

ROUTES_PATH = "/app/routing/routes.json"
LOG_PATH = "/app/routing/routing-shadow.jsonl"

TASK_INSTRUCTION = """You are a helpful assistant designed to find the best suited route.
You are provided with route description within <routes></routes> XML tags:
<routes>
{routes}
</routes>

<conversation>
{conversation}
</conversation>
"""

FORMAT_PROMPT = """Your task is to decide which route is best suit with user intent on the conversation in <conversation></conversation> XML tags.  Follow the instruction:
1. If the latest intent from user is irrelevant or user intent is full filled, response with other route {"route": "other"}.
2. You must analyze the route descriptions and find the best match route for user latest intent.
3. You only response the name of the route that best matches the user's request, use the exact name in the <routes></routes>.

Based on your analysis, provide your response in the following JSON formats if you decide to match any route:
{"route": "route_name"}"""


def _load_routes():
    with open(ROUTES_PATH) as f:
        return json.load(f)


def _last_user_text(messages):
    """Latest user message as plain text (handles string and parts-list content)."""
    for m in reversed(messages or []):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _parse_route(raw):
    """Model answers {"route": "name"} — tolerate single quotes / stray text."""
    raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in: {raw[:80]}")
    return json.loads(raw[start : end + 1].replace("'", '"'))["route"]


def _append_log(entry):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # a logging failure must never surface


async def _classify_and_log(requested_model, prompt_text):
    t0 = time.time()
    entry = {
        "ts": int(t0 * 1000),
        "requested_model": requested_model,
        "prompt_head": prompt_text[:160],
        "route": "__error__",
        "ms": 0,
    }
    try:
        cfg = _load_routes()
        route_descs = [{"name": r["name"], "description": r["description"]} for r in cfg["routes"]]
        conversation = [{"role": "user", "content": prompt_text}]
        content = (
            TASK_INSTRUCTION.format(routes=json.dumps(route_descs), conversation=json.dumps(conversation))
            + FORMAT_PROMPT
        )
        timeout = cfg.get("classifier", {}).get("timeout_ms", 15000) / 1000
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                cfg["classifier"]["url"],
                json={
                    "model": cfg["classifier"]["model"],
                    "stream": False,
                    "options": {"temperature": 0, "num_predict": 64},
                    # Pin the ~1GB classifier in GPU memory — a cold load adds
                    # seconds to each classify.
                    "keep_alive": cfg.get("classifier", {}).get("keep_alive", "60m"),
                    "messages": [{"role": "user", "content": content}],
                },
            )
            resp.raise_for_status()
            raw = resp.json()["message"]["content"]
        route = _parse_route(raw)
        bindings = {r["name"]: r["model"] for r in cfg["routes"]}
        entry["route"] = route
        entry["bound_model"] = bindings.get(route, cfg.get("default_route"))
    except Exception as e:  # classifier host asleep, timeout, parse failure — log and move on
        entry["error"] = f"{type(e).__name__}: {e}"[:200]
    entry["ms"] = int((time.time() - t0) * 1000)
    _append_log(entry)


class ShadowRouter(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            if call_type in ("completion", "acompletion", "text_completion"):
                text = _last_user_text(data.get("messages"))
                if text:
                    # Fire-and-forget: the request proceeds untouched immediately.
                    asyncio.get_running_loop().create_task(_classify_and_log(data.get("model", "?"), text))
        except Exception:
            pass
        return data


proxy_handler_instance = ShadowRouter()
