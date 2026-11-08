"""Pluggable LLM providers.

- OpenAICompatProvider: any /chat/completions endpoint (DeepSeek, OpenAI, vLLM,
  OpenRouter, Ollama...). Tracks tokens, cache hits and USD cost.
- AgentProvider: no API. Writes each prompt to <dir>/requests/<key>.json and
  reads <dir>/responses/<key>.json — lets an external agent (Claude, a human)
  play the model. Missing answers raise Pending; rerun after they are written.
- CachingProvider: wraps any provider; identical requests are never paid twice.
- Budget: hard USD cap shared by all calls in a process.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

# USD per 1M tokens: (cache-hit input, cache-miss input, output).
# DeepSeek list prices as of 2026 (api-docs.deepseek.com/quick_start/pricing);
# peak-hour surcharges may apply — the balance endpoint is the source of truth.
PRICES = {
    "deepseek-flash": (0.0028, 0.14, 0.28),
    "deepseek-v4-pro": (0.003625, 0.435, 0.87),
    "deepseek-chat": (0.028, 0.28, 0.42),
    "deepseek-reasoner": (0.028, 0.28, 0.42),
}


class Pending(Exception):
    """An AgentProvider request is waiting for an external answer."""


class BudgetExceeded(Exception):
    pass


@dataclass
class Budget:
    max_usd: float
    spent: float = 0.0

    def charge(self, usd: float) -> None:
        self.spent += usd

    def check(self) -> None:
        if self.spent >= self.max_usd:
            raise BudgetExceeded(f"budget ${self.max_usd:.2f} exhausted (spent ${self.spent:.4f})")


@dataclass
class LLMResult:
    text: str
    usage: dict[str, Any] = field(default_factory=dict)
    cost_usd: float = 0.0
    latency_s: float = 0.0
    cached: bool = False


def request_key(model: str, messages: list[dict], params: dict) -> str:
    blob = json.dumps({"m": model, "msg": messages, "p": params}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24]


class OpenAICompatProvider:
    def __init__(self, model: str, base_url: str, api_key: str, *, thinking: str = "off",
                 concurrency: int = 8, budget: Optional[Budget] = None, timeout: float = 180):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.thinking = thinking            # off | low | high (DeepSeek V4 knobs)
        self.sem = asyncio.Semaphore(concurrency)
        self.budget = budget
        self.timeout = timeout
        self.name = f"{model}[think={thinking}]"

    def params(self, temperature: float, max_tokens: int, json_mode: bool, thinking: Optional[str] = None) -> dict:
        p: dict[str, Any] = {"temperature": temperature, "max_tokens": max_tokens}
        if json_mode:
            p["response_format"] = {"type": "json_object"}
        think = thinking or self.thinking
        if "openrouter.ai" in self.base_url:
            p["usage"] = {"include": True}          # OpenRouter returns the billed cost
            if think == "off":
                p["reasoning"] = {"enabled": False}
            elif think in ("low", "medium", "high"):
                p["reasoning"] = {"effort": think}
        elif "deepseek" in self.base_url:
            if think == "off":
                p["thinking"] = {"type": "disabled"}
            else:
                p["reasoning_effort"] = think
        elif "api.openai.com" in self.base_url:
            if think in ("low", "medium", "high") and self.model.startswith(("o", "gpt-5")):
                p["reasoning_effort"] = think
        elif think in ("off", "low", "medium", "high"):
            # self-hosted vLLM/SGLang: Qwen/Gemma chat templates switch thinking with this flag
            p["chat_template_kwargs"] = {"enable_thinking": think != "off"}
            if think != "off" and temperature < 0.6:
                # Qwen/Gemma thinking at temperature 0 falls into endless reasoning loops
                # (measured on kt-103: 9/10 dialogs hit max_tokens); vendors recommend 0.6+.
                p["temperature"], p["top_p"] = 0.6, 0.95
        return p

    def cost(self, usage: dict) -> float:
        if isinstance(usage.get("cost"), (int, float)):   # provider-reported (OpenRouter)
            return float(usage["cost"])
        hit_p, miss_p, out_p = PRICES.get(self.model, (0, 0, 0))
        hit = usage.get("prompt_cache_hit_tokens")
        miss = usage.get("prompt_cache_miss_tokens")
        if hit is None:
            hit = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
            miss = usage.get("prompt_tokens", 0) - hit
        return (hit * hit_p + miss * miss_p + usage.get("completion_tokens", 0) * out_p) / 1e6

    async def complete(self, messages: list[dict], *, temperature: float = 0.0,
                       max_tokens: int = 4000, json_mode: bool = True,
                       thinking: Optional[str] = None, **_) -> LLMResult:
        if self.budget:
            self.budget.check()
        body = {"model": self.model, "messages": messages,
                **self.params(temperature, max_tokens, json_mode, thinking)}
        async with self.sem:
            t0 = time.perf_counter()
            last_err = None
            for attempt in range(4):
                try:
                    async with httpx.AsyncClient(timeout=self.timeout) as cli:
                        r = await cli.post(f"{self.base_url}/chat/completions", json=body,
                                           headers={"Authorization": f"Bearer {self.api_key}"})
                    if r.status_code in (429, 500, 502, 503, 504):
                        last_err = f"HTTP {r.status_code}: {r.text[:200]}"
                        await asyncio.sleep(2 * (attempt + 1))
                        continue
                    r.raise_for_status()
                    data = r.json()
                    break
                except (httpx.TransportError, httpx.TimeoutException) as e:
                    last_err = repr(e)
                    await asyncio.sleep(2 * (attempt + 1))
            else:
                raise RuntimeError(f"LLM call failed: {last_err}")
            latency = time.perf_counter() - t0
        usage = data.get("usage") or {}
        cost = self.cost(usage)
        if self.budget:
            self.budget.charge(cost)
        msg = data["choices"][0]["message"]
        return LLMResult(text=msg.get("content") or "", usage=usage, cost_usd=cost, latency_s=latency)


class AgentProvider:
    """File-based 'model' for external agents. See module docstring."""

    def __init__(self, root: str | Path, name: str = "agent"):
        self.root = Path(root)
        (self.root / "requests").mkdir(parents=True, exist_ok=True)
        (self.root / "responses").mkdir(parents=True, exist_ok=True)
        self.model = name
        self.name = name

    async def complete(self, messages: list[dict], *, temperature: float = 0.0,
                       max_tokens: int = 4000, json_mode: bool = True, sample: int = 0, **_) -> LLMResult:
        key = request_key(self.model, messages, {"json": json_mode, "sample": sample})
        resp = self.root / "responses" / f"{key}.json"
        if resp.exists():
            # the file holds exactly what the model would have returned
            return LLMResult(text=resp.read_text(encoding="utf-8"), cached=True)
        req = self.root / "requests" / f"{key}.json"
        if not req.exists():
            req.write_text(json.dumps({"key": key, "messages": messages}, ensure_ascii=False, indent=1),
                           encoding="utf-8")
        raise Pending(key)


class CachingProvider:
    def __init__(self, inner, cache_dir: str | Path):
        self.inner = inner
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.model = inner.model
        self.name = inner.name

    async def complete(self, messages: list[dict], *, temperature: float = 0.0,
                       max_tokens: int = 4000, json_mode: bool = True, sample: int = 0,
                       thinking: Optional[str] = None) -> LLMResult:
        params = getattr(self.inner, "params", lambda *a: {})(temperature, max_tokens, json_mode, thinking)
        salt = os.environ.get("CQA_CACHE_SALT")  # set to force fresh calls (repeatability runs)
        key = request_key(self.inner.name, messages, {**params, "sample": sample, **({"salt": salt} if salt else {})})
        f = self.dir / f"{key}.json"
        if f.exists():
            d = json.loads(f.read_text(encoding="utf-8"))
            return LLMResult(text=d["text"], usage=d.get("usage", {}), cost_usd=0.0,
                             latency_s=d.get("latency_s", 0.0), cached=True)
        res = await self.inner.complete(messages, temperature=temperature, max_tokens=max_tokens,
                                        json_mode=json_mode, thinking=thinking)
        f.write_text(json.dumps({"text": res.text, "usage": res.usage, "cost_usd": res.cost_usd,
                                 "latency_s": res.latency_s}, ensure_ascii=False), encoding="utf-8")
        return res


def default_provider() -> str:
    """Default evaluator: Gemma 4 26B-A4B (thinking) on a vLLM server; GEMMA_BASE_URL overrides the address."""
    return "compat:/models/gemma-4-26B-A4B-it@" + os.environ.get("GEMMA_BASE_URL", "http://127.0.0.1:18887/v1")


def load_env(path: str | Path = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def make_provider(spec: str, *, budget: Optional[Budget] = None, cache_dir: str | Path = "runs/cache",
                  thinking: str = "high", concurrency: int = 8, api_key: Optional[str] = None):
    """spec examples:
         deepseek:deepseek-flash            (DEEPSEEK_API_KEY)
         openai:gpt-4.1-mini                (OPENAI_API_KEY)
         openrouter:anthropic/claude-sonnet-5.5   (OPENROUTER_API_KEY)
         compat:<model>@<base_url>          (LLM_API_KEY)
         agent:<dir>                        (file hand-off to an external agent)
    """
    kind, _, rest = spec.partition(":")
    if kind == "agent":
        return AgentProvider(rest or "runs/agent", name=f"agent:{Path(rest or 'agent').name}")
    if kind == "deepseek":
        p = OpenAICompatProvider(rest or "deepseek-flash", os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
                                 api_key or os.environ["DEEPSEEK_API_KEY"], thinking=thinking,
                                 concurrency=concurrency, budget=budget)
    elif kind == "openai":
        p = OpenAICompatProvider(rest, "https://api.openai.com/v1", api_key or os.environ["OPENAI_API_KEY"],
                                 thinking="n/a", concurrency=concurrency, budget=budget)
    elif kind == "openrouter":
        p = OpenAICompatProvider(rest, "https://openrouter.ai/api/v1", api_key or os.environ["OPENROUTER_API_KEY"],
                                 thinking=thinking, concurrency=concurrency, budget=budget)
    elif kind == "compat":
        model, _, url = rest.partition("@")
        p = OpenAICompatProvider(model, url, api_key or os.environ.get("LLM_API_KEY", "none"),
                                 thinking=thinking, concurrency=concurrency, budget=budget)
    else:
        raise ValueError(f"unknown provider spec {spec!r}")
    return CachingProvider(p, cache_dir)
