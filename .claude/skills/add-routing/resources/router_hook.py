"""Routing hook — llm-router.md §16b (N-way capability classifier).

Registered as a LiteLLM proxy callback. Two modes, per request:

SHADOW (always on): on every completion request it FIRE-AND-FORGETS a
classification task (Arch-Router on a LAN Ollama) and logs the decision to a
JSONL file. It NEVER modifies the request and NEVER blocks it.

LIVE (Phase 2, flag-gated): when routes.json carries `"live": {"enabled": true}`
and the request names the virtual model (`live.model_name`, default "auto"),
the hook classifies SYNCHRONOUSLY and rewrites data["model"] to the bound
roster model before the router picks a deployment. Failure posture: any
classifier problem (host asleep, timeout, bad JSON, unknown route, route
"other") falls back to the default_route's binding — a request for "auto"
never fails because of routing. Live classification holds the request, so it
uses its own tighter timeout (`live.timeout_ms`, default 5000ms).

Files (mounted from the host's data/litellm/routing/):
  /app/routing/routes.json           route catalog + classifier endpoint + live flag
  /app/routing/routing-shadow.jsonl  one line per decision (shadow and live)

Requests naming a concrete roster model are never rewritten, live flag or not.
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


def _strip_system_wrapper(text):
    """NanoClaw's agent-runner prepends '<system>…</system>' inside the USER
    message (OpenCode has no separate system channel there). Classify on the
    user's actual words, not the agent preamble — otherwise every
    first-of-session prompt routes on boilerplate."""
    if text.lstrip().startswith("<system>"):
        end = text.find("</system>")
        if end >= 0:
            return text[end + len("</system>") :].strip()
    return text


def _last_user_text(messages):
    """Latest user message as plain text (handles string and parts-list content)."""
    for m in reversed(messages or []):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return _strip_system_wrapper(c)
        if isinstance(c, list):
            joined = " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
            return _strip_system_wrapper(joined)
    return ""


def _parse_route(raw):
    """Model answers {"route": "name"} — tolerate single quotes / stray text."""
    raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in: {raw[:80]}")
    return json.loads(raw[start : end + 1].replace("'", '"'))["route"]


def _bindings(cfg):
    return {r["name"]: r["model"] for r in cfg["routes"]}


def _default_binding(cfg):
    return _bindings(cfg).get(cfg.get("default_route"))


def _append_log(entry):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # a logging failure must never surface


async def _classify(cfg, prompt_text, timeout_ms=None):
    """One Arch-Router call → route name. Raises on any failure."""
    route_descs = [{"name": r["name"], "description": r["description"]} for r in cfg["routes"]]
    conversation = [{"role": "user", "content": prompt_text}]
    content = (
        TASK_INSTRUCTION.format(routes=json.dumps(route_descs), conversation=json.dumps(conversation))
        + FORMAT_PROMPT
    )
    if timeout_ms is None:
        timeout_ms = cfg.get("classifier", {}).get("timeout_ms", 15000)
    async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
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
    return _parse_route(raw)


async def _classify_and_log(requested_model, prompt_text):
    """Shadow path: fire-and-forget, the request is long gone."""
    t0 = time.time()
    entry = {
        "ts": int(t0 * 1000),
        "mode": "shadow",
        "requested_model": requested_model,
        "prompt_head": prompt_text[:160],
        "route": "__error__",
        "ms": 0,
    }
    try:
        cfg = _load_routes()
        route = await _classify(cfg, prompt_text)
        entry["route"] = route
        entry["bound_model"] = _bindings(cfg).get(route) or _default_binding(cfg)
    except Exception as e:  # classifier host asleep, timeout, parse failure — log and move on
        entry["error"] = f"{type(e).__name__}: {e}"[:200]
    entry["ms"] = int((time.time() - t0) * 1000)
    _append_log(entry)


async def _route_live(cfg, live, data, prompt_text):
    """Live path: classify while the request waits, then rewrite data["model"]."""
    t0 = time.time()
    entry = {
        "ts": int(t0 * 1000),
        "mode": "live",
        "requested_model": data.get("model"),
        "prompt_head": prompt_text[:160],
        "route": "__error__",
        "ms": 0,
    }
    target = _default_binding(cfg)
    try:
        route = await _classify(cfg, prompt_text, timeout_ms=live.get("timeout_ms", 5000))
        entry["route"] = route
        # Unknown route or "other" → default binding, same as an error.
        target = _bindings(cfg).get(route) or target
    except Exception as e:
        entry["error"] = f"{type(e).__name__}: {e}"[:200]
    if target:
        data["model"] = target
    entry["final_model"] = data.get("model")
    entry["ms"] = int((time.time() - t0) * 1000)
    _append_log(entry)
    return data


class ShadowRouter(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            if call_type not in ("completion", "acompletion", "text_completion"):
                return data
            text = _last_user_text(data.get("messages"))
            if not text:
                return data
            cfg = None
            try:
                cfg = _load_routes()
            except Exception:
                pass
            live = (cfg or {}).get("live") or {}
            if cfg and live.get("enabled") and data.get("model") == live.get("model_name", "auto"):
                return await _route_live(cfg, live, data, text)
            # Fire-and-forget: the request proceeds untouched immediately.
            asyncio.get_running_loop().create_task(_classify_and_log(data.get("model", "?"), text))
        except Exception:
            pass
        return data


proxy_handler_instance = ShadowRouter()
