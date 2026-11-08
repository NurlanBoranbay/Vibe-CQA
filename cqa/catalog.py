"""Providers and models, managed in the UI like OpenRouter's «Bring your own key»:
an admin picks a provider, pastes its key (checked before it is saved), then chooses which of
its models can be used for evaluation and which one is the default.

Keys live in the local SQLite store (data/*.sqlite is git-ignored) or in .env; the API only
ever returns a masked form. Prototype: there is no auth yet, roles are enforced in the UI.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import httpx

from .llm import make_provider

PROVIDERS: dict[str, dict[str, Any]] = {
    "selfhosted": {"title": "Свой сервер", "kind": "compat", "needs_url": True, "key_optional": True,
                   "env_key": "LLM_API_KEY", "env_url": "GEMMA_BASE_URL", "default_url": "http://127.0.0.1:18887/v1",
                   "hint": "vLLM, Ollama и другие серверы с OpenAI-совместимым API. Бесплатно."},
    "openrouter": {"title": "OpenRouter", "kind": "openrouter", "base_url": "https://openrouter.ai/api/v1",
                   "env_key": "OPENROUTER_API_KEY", "keys_url": "https://openrouter.ai/settings/keys",
                   "hint": "Сотни моделей по одному ключу: Gemma, Qwen, DeepSeek, Claude, GPT."},
    "deepseek": {"title": "DeepSeek", "kind": "deepseek", "base_url": "https://api.deepseek.com",
                 "env_key": "DEEPSEEK_API_KEY", "keys_url": "https://platform.deepseek.com/api_keys",
                 "hint": "DeepSeek Flash и Pro напрямую."},
    "openai": {"title": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1",
               "env_key": "OPENAI_API_KEY", "keys_url": "https://platform.openai.com/api-keys",
               "hint": "Модели GPT."},
}

# what one evaluated dialog costs (3-sample vote), measured in bench/RESULTS.md
KNOWN_PRICE = {("deepseek", "deepseek-flash"): 0.002}
AVG_TOKENS = (2923 * 3, 8792 * 3)      # in/out tokens per dialog with thinking and a 3-sample vote

SEED_MODELS = [
    {"id": "gemma-selfhosted", "provider": "selfhosted", "model": "/models/gemma-4-26B-A4B-it", "label": "Gemma 4 26B-A4B", "enabled": True},
    {"id": "deepseek-flash", "provider": "deepseek", "model": "deepseek-flash", "label": "DeepSeek Flash", "enabled": True},
]

_or_cache: dict[str, Any] = {"at": 0, "models": []}


def mask(key: str) -> str:
    return f"{key[:3]}…{key[-4:]}" if key and len(key) > 10 else "••••"


class Catalog:
    def __init__(self, store):
        self.store = store
        if self.store.setting("models") is None:
            self.store.set_setting("models", SEED_MODELS)
            self.store.set_setting("default_model", "gemma-selfhosted")

    # ------------------------------------------------------------ providers
    def _saved(self) -> dict[str, dict]:
        return self.store.setting("providers", {}) or {}

    def creds(self, pid: str) -> tuple[Optional[str], Optional[str], str]:
        """(key, base_url, source) — a key saved in the UI wins over .env."""
        meta = PROVIDERS[pid]
        saved = self._saved().get(pid) or {}
        key = saved.get("key") or os.environ.get(meta["env_key"]) or None
        url = saved.get("base_url") or (os.environ.get(meta.get("env_url", "")) if meta.get("env_url") else None) \
            or meta.get("default_url") or meta.get("base_url")
        source = "ui" if saved else ("env" if os.environ.get(meta["env_key"]) or (meta.get("env_url") and os.environ.get(meta["env_url"])) else "")
        return key, url, source

    def connected(self, pid: str) -> bool:
        key, url, source = self.creds(pid)
        return bool(key) or (PROVIDERS[pid].get("key_optional") and bool(source or self._saved().get(pid)
                                                                            or PROVIDERS[pid].get("default_url")))

    def providers(self) -> list[dict]:
        out = []
        for pid, meta in PROVIDERS.items():
            key, url, source = self.creds(pid)
            saved = self._saved().get(pid) or {}
            out.append({"id": pid, "title": meta["title"], "hint": meta["hint"], "keys_url": meta.get("keys_url"),
                        "needs_url": bool(meta.get("needs_url")), "key_optional": bool(meta.get("key_optional")),
                        "connected": self.connected(pid), "key_masked": mask(key) if key else None,
                        "base_url": url if meta.get("needs_url") else None, "source": source,
                        "added_at": saved.get("added_at")})
        return out

    async def check(self, pid: str, key: Optional[str], url: Optional[str]) -> list[str]:
        """Calls the provider with the key before anything is saved. Returns model ids (when listed)."""
        meta = PROVIDERS[pid]
        base = (url or meta.get("base_url") or "").rstrip("/")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        probe = "https://openrouter.ai/api/v1/key" if pid == "openrouter" else f"{base}/models"
        async with httpx.AsyncClient(timeout=12) as c:
            try:
                r = await c.get(probe, headers=headers)
            except httpx.HTTPError as e:
                raise ValueError(f"Сервер не отвечает: {e.__class__.__name__}") from None
        if r.status_code in (401, 403):
            raise ValueError("Ключ не принят провайдером")
        if r.status_code >= 400:
            raise ValueError(f"Провайдер ответил {r.status_code}")
        if pid == "openrouter":
            return []
        try:
            return [m["id"] for m in r.json().get("data", [])]
        except Exception:
            return []

    def save_provider(self, pid: str, key: Optional[str], url: Optional[str]) -> None:
        saved = self._saved()
        prev = saved.get(pid) or {}
        saved[pid] = {"key": key or prev.get("key") or "", "base_url": url or prev.get("base_url"), "added_at": time.time()}
        self.store.set_setting("providers", saved)

    def remove_provider(self, pid: str) -> None:
        saved = self._saved()
        saved.pop(pid, None)
        self.store.set_setting("providers", saved)

    async def provider_models(self, pid: str) -> list[dict]:
        """Models a provider offers, for the «add model» picker (OpenRouter: public list with prices)."""
        if pid == "openrouter":
            if time.time() - _or_cache["at"] > 3600:
                async with httpx.AsyncClient(timeout=20) as c:
                    data = (await c.get("https://openrouter.ai/api/v1/models")).json().get("data", [])
                _or_cache.update(at=time.time(), models=[
                    {"model": m["id"], "label": m.get("name") or m["id"],
                     "price": self.price("openrouter", m["id"], m.get("pricing"))} for m in data])
            return _or_cache["models"]
        key, url, _ = self.creds(pid)
        ids = await self.check(pid, key, url)
        return [{"model": i, "label": i.rsplit("/", 1)[-1], "price": self.price(pid, i)} for i in ids]

    # --------------------------------------------------------------- models
    def price(self, pid: str, model: str, pricing: Optional[dict] = None) -> Optional[float]:
        """≈ USD per evaluated dialog; 0 for a self-hosted model, None when unknown."""
        if pid == "selfhosted":
            return 0.0
        if (pid, model) in KNOWN_PRICE:
            return KNOWN_PRICE[(pid, model)]
        if pid == "openrouter":
            if pricing is None:
                pricing = next((m for m in _or_cache["models"] if m["model"] == model), {}).get("_pricing")
            try:
                return round(AVG_TOKENS[0] * float(pricing["prompt"]) + AVG_TOKENS[1] * float(pricing["completion"]), 5)
            except Exception:
                return None
        return None

    def models(self) -> list[dict]:
        default = self.store.setting("default_model")
        out = []
        for m in self.store.setting("models", []) or []:
            out.append({**m, "default": m["id"] == default, "usable": self.connected(m["provider"]),
                        "provider_title": PROVIDERS.get(m["provider"], {}).get("title", m["provider"]),
                        "price": m.get("price", self.price(m["provider"], m["model"]))})
        return out

    def save_models(self, models: list[dict], default: Optional[str]) -> None:
        ids = [m["id"] for m in models]
        if len(ids) != len(set(ids)):
            raise ValueError("повторяются id моделей")
        for m in models:
            if m["provider"] not in PROVIDERS:
                raise ValueError(f"неизвестный провайдер {m['provider']}")
        if default and default not in ids:
            raise ValueError("модель по умолчанию не найдена")
        keep = ("id", "provider", "model", "label", "enabled", "price")
        self.store.set_setting("models", [{k: m[k] for k in keep if k in m} for m in models])
        self.store.set_setting("default_model", default)

    def default(self) -> Optional[dict]:
        ms = {m["id"]: m for m in self.models()}
        d = ms.get(self.store.setting("default_model"))
        return d if d and d["usable"] else None

    def spec(self, m: dict) -> tuple[str, Optional[str]]:
        """Provider spec for make_provider() and the key to use."""
        meta = PROVIDERS[m["provider"]]
        key, url, _ = self.creds(m["provider"])
        if meta["kind"] == "compat":
            return f"compat:{m['model']}@{url}", key
        return f"{meta['kind']}:{m['model']}", key

    def make(self, model_id: str, **kw):
        m = next((x for x in self.models() if x["id"] == model_id), None)
        if not m:
            raise ValueError(f"модель {model_id} не найдена")
        if not m["usable"]:
            raise ValueError(f"провайдер «{m['provider_title']}» не подключён")
        spec, key = self.spec(m)
        p = make_provider(spec, api_key=key, **kw)
        p.label = m["label"]
        return p
