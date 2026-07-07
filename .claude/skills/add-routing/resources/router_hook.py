"""Routing hook — llm-router.md §16b (N-way capability classifier).

Registered as a LiteLLM proxy callback. Two modes, per request:

SHADOW (always on): on every completion request it FIRE-AND-FORGETS a
classification task (Arch-Router on a LAN Ollama) and logs the decision to a
JSONL file. It NEVER modifies the request and NEVER blocks it.

LIVE (flag-gated): routes.json defines one or more named ROUTERS (reusable
routing profiles). When `"live": {"enabled": true}` and a request names a
router (its map key — the virtual model an agent is assigned, e.g. "auto" or
"auto-vision"), the hook classifies SYNCHRONOUSLY against THAT router's routes
and rewrites data["model"] to the bound roster model before the router picks a
deployment. Every router shares the one classifier and the one roster; they
differ only in their routes (rules) and bindings (models). Failure posture:
any classifier problem (host asleep, timeout, bad JSON, unknown route, route
"other") falls back to that router's default_route binding — a routed request
never fails because of routing.

Config shape (routes.json):
  { "classifier": {...},              # shared — one Arch-Router
    "live": { "enabled": true },      # global kill-switch
    "routers": {                      # up to a handful of profiles
      "auto":        { "default_route": ..., "timeout_ms": ..., "routes": [...] },
      "auto-vision": { ... } } }
The pre-multi-router format (top-level "routes"/"default_route"/"live.model_name")
is still read — `_routers()` normalizes it to a single-entry map in memory.

Files (mounted from the host's data/litellm/routing/):
  /app/routing/routes.json           router catalog + classifier endpoint + live flag
  /app/routing/routing-shadow.jsonl  one line per decision (shadow and live)

Requests naming a concrete roster model are never rewritten, live flag or not.
"""

import asyncio
import json
import time

import httpx
from fastapi import HTTPException
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


def _routers(cfg):
    """The map of named routers {name: {routes, default_route, timeout_ms}}.

    New format carries `cfg["routers"]` directly. The pre-multi-router format
    (top-level routes/default_route + live.model_name) is normalized here to a
    single-entry map so the hook logic is uniform. KEEP-IN-SYNC with the same
    normalize in bind-routes.mjs / recalibrate.mjs."""
    if isinstance(cfg.get("routers"), dict):
        return cfg["routers"]
    name = (cfg.get("live") or {}).get("model_name", "auto")
    return {
        name: {
            "routes": cfg.get("routes", []),
            "default_route": cfg.get("default_route"),
            "timeout_ms": (cfg.get("live") or {}).get("timeout_ms", 5000),
        }
    }


def _primary_router_name(cfg, routers):
    """Which router the shadow path classifies against (shadow requests name a
    concrete model, not a router, so there's no router in-band). Prefer the
    legacy `live.model_name` if it's a real router; else the first defined."""
    name = (cfg.get("live") or {}).get("model_name")
    if name and name in routers:
        return name
    return next(iter(routers), None)


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


def _bindings(router):
    return {r["name"]: r.get("model") for r in router.get("routes", []) if r.get("model")}


def _escalate_routes(router):
    """Routes with `"escalate": true` have no local binding — a live match
    rejects the request with a no_adequate_model marker so NanoClaw's
    per-group fallback_provider re-runs the turn on a stronger provider
    (llm-router §16c). The confidence floor, realized as a route: describe
    what's beyond the local roster and let Arch-Router match it."""
    return {r["name"] for r in router.get("routes", []) if r.get("escalate")}


def _default_binding(router):
    return _bindings(router).get(router.get("default_route"))


def _append_log(entry):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # a logging failure must never surface


async def _classify(cfg, router, prompt_text, timeout_ms=None):
    """One Arch-Router call → route name, against THIS router's routes. Raises
    on any failure. The classifier itself (cfg["classifier"]) is shared."""
    route_descs = [{"name": r["name"], "description": r["description"]} for r in router.get("routes", [])]
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
    """Shadow path: fire-and-forget, the request is long gone. Classifies
    against the primary router (shadow requests name a concrete model)."""
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
        routers = _routers(cfg)
        name = _primary_router_name(cfg, routers)
        if not name:
            return
        router = routers[name]
        entry["router"] = name
        route = await _classify(cfg, router, prompt_text)
        entry["route"] = route
        if route in _escalate_routes(router):
            entry["bound_model"] = "__escalate__"
        else:
            entry["bound_model"] = _bindings(router).get(route) or _default_binding(router)
    except Exception as e:  # classifier host asleep, timeout, parse failure — log and move on
        entry["error"] = f"{type(e).__name__}: {e}"[:200]
    entry["ms"] = int((time.time() - t0) * 1000)
    _append_log(entry)


async def _route_live(cfg, router, router_name, data, prompt_text):
    """Live path: classify while the request waits, then rewrite data["model"]
    to the matched route's binding in THIS router."""
    t0 = time.time()
    entry = {
        "ts": int(t0 * 1000),
        "mode": "live",
        "router": router_name,
        "requested_model": data.get("model"),
        "prompt_head": prompt_text[:160],
        "route": "__error__",
        "ms": 0,
    }
    target = _default_binding(router)
    try:
        timeout_ms = router.get("timeout_ms") or (cfg.get("live") or {}).get("timeout_ms", 5000)
        route = await _classify(cfg, router, prompt_text, timeout_ms=timeout_ms)
        entry["route"] = route
        if route in _escalate_routes(router):
            # No adequate local model (§16c). Reject fast — before any
            # generation — with a greppable marker; the agent-runner's
            # fallback_provider seam re-runs the turn on a stronger provider.
            # Only an AFFIRMATIVE classification escalates: classifier errors
            # below fall back to the local default binding, never to the
            # (quota-costing) fallback provider.
            entry["final_model"] = "__escalate__"
            entry["ms"] = int((time.time() - t0) * 1000)
            _append_log(entry)
            raise HTTPException(
                status_code=400,
                detail=f"no_adequate_model: prompt classified to route '{route}' — no local binding, escalate",
            )
        # Unknown route or "other" → default binding, same as an error.
        target = _bindings(router).get(route) or target
    except HTTPException:
        raise
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
            if cfg and live.get("enabled"):
                routers = _routers(cfg)
                model = data.get("model")
                if model in routers:
                    return await _route_live(cfg, routers[model], model, data, text)
            # Fire-and-forget: the request proceeds untouched immediately.
            asyncio.get_running_loop().create_task(_classify_and_log(data.get("model", "?"), text))
        except HTTPException:
            raise  # no_adequate_model rejection must reach the client
        except Exception:
            pass
        return data


proxy_handler_instance = ShadowRouter()
