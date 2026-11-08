"""SQLite store (stdlib only). JSON bodies; one row per checklist version,
dialog, evaluation (per dialog × checklist id) and appeal."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS checklists (id TEXT, version INTEGER, body TEXT, created_at REAL,
                                       PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS dialogs (cid TEXT PRIMARY KEY, dataset TEXT, body TEXT, imported_at REAL);
CREATE TABLE IF NOT EXISTS evaluations (cid TEXT, checklist_id TEXT, version INTEGER, body TEXT,
                                        updated_at REAL, PRIMARY KEY (cid, checklist_id, version));
CREATE TABLE IF NOT EXISTS appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, checklist_id TEXT,
                                    criterion_id TEXT, comment TEXT, status TEXT, body TEXT,
                                    created_at REAL, decided_at REAL);
CREATE TABLE IF NOT EXISTS prompts (id TEXT, version INTEGER, body TEXT, created_at REAL,
                                    PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS prompt_active (id TEXT PRIMARY KEY, version INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS eval_history (eval_id TEXT PRIMARY KEY, cid TEXT, checklist_id TEXT, version INTEGER,
                                         run_id INTEGER, created_at REAL, body TEXT);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, body TEXT,
                                 created_at REAL, updated_at REAL);
"""


class Store:
    def __init__(self, path: str | Path = "data/cqa.sqlite"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(_SCHEMA)

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.fetchall()

    # checklists ---------------------------------------------------------
    def save_checklist(self, body: dict[str, Any]) -> dict[str, Any]:
        rows = self._q("SELECT MAX(version) v FROM checklists WHERE id=?", (body["id"],))
        version = (rows[0]["v"] or 0) + 1
        body = {**body, "version": version}
        self._q("INSERT INTO checklists VALUES (?,?,?,?)",
                (body["id"], version, json.dumps(body, ensure_ascii=False), time.time()))
        return body

    def checklist(self, cid: str, version: Optional[int] = None) -> Optional[dict]:
        if version:
            rows = self._q("SELECT body FROM checklists WHERE id=? AND version=?", (cid, version))
        else:
            rows = self._q("SELECT body FROM checklists WHERE id=? ORDER BY version DESC LIMIT 1", (cid,))
        return json.loads(rows[0]["body"]) if rows else None

    def checklists(self) -> list[dict]:
        rows = self._q("SELECT id, MAX(version) v FROM checklists GROUP BY id")
        return [self.checklist(r["id"], r["v"]) for r in rows]

    # system prompts (versioned; one active version per prompt) -----------
    def save_prompt(self, body: dict[str, Any], activate: bool = False) -> dict[str, Any]:
        rows = self._q("SELECT MAX(version) v FROM prompts WHERE id=?", (body["id"],))
        version = (rows[0]["v"] or 0) + 1
        now = time.time()
        body = {**body, "version": version, "created_at": now}
        self._q("INSERT INTO prompts VALUES (?,?,?,?)",
                (body["id"], version, json.dumps(body, ensure_ascii=False), now))
        if activate or version == 1:
            self.activate_prompt(body["id"], version)
        return body

    def activate_prompt(self, pid: str, version: int) -> None:
        self._q("INSERT OR REPLACE INTO prompt_active VALUES (?,?)", (pid, version))

    def active_prompt_version(self, pid: str) -> Optional[int]:
        rows = self._q("SELECT version FROM prompt_active WHERE id=?", (pid,))
        return rows[0]["version"] if rows else None

    def prompt(self, pid: str, version: Optional[int] = None) -> Optional[dict]:
        """A given version, else the active one, else the latest."""
        version = version or self.active_prompt_version(pid)
        if version:
            rows = self._q("SELECT body FROM prompts WHERE id=? AND version=?", (pid, version))
        else:
            rows = self._q("SELECT body FROM prompts WHERE id=? ORDER BY version DESC LIMIT 1", (pid,))
        return json.loads(rows[0]["body"]) if rows else None

    def prompt_versions(self, pid: str) -> list[dict]:
        return [{"version": r["version"], "created_at": r["created_at"]} for r in self._q(
            "SELECT version, created_at FROM prompts WHERE id=? ORDER BY version DESC", (pid,))]

    def prompts(self) -> list[dict]:
        ids = [r["id"] for r in self._q("SELECT DISTINCT id FROM prompts ORDER BY id")]
        return [p for p in (self.prompt(i) for i in ids) if p]

    # settings (provider keys, model catalog) ---------------------------
    def setting(self, key: str, default: Any = None) -> Any:
        rows = self._q("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    def set_setting(self, key: str, value: Any) -> None:
        self._q("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))

    # every evaluation of a call, kept forever (the evaluations table holds only the current one) ---
    def save_history(self, doc: dict[str, Any]) -> None:
        rows = self._q("SELECT created_at FROM eval_history WHERE eval_id=?", (doc["eval_id"],))
        created = rows[0]["created_at"] if rows else doc.get("created_at", time.time())
        self._q("INSERT OR REPLACE INTO eval_history VALUES (?,?,?,?,?,?,?)",
                (doc["eval_id"], doc["conversation_id"], doc["checklist_id"], doc["checklist_version"],
                 doc.get("run_id"), created, json.dumps({**doc, "created_at": created}, ensure_ascii=False)))

    def history(self, eval_id: str) -> Optional[dict]:
        rows = self._q("SELECT body FROM eval_history WHERE eval_id=?", (eval_id,))
        return json.loads(rows[0]["body"]) if rows else None

    def history_list(self, cid: str, checklist_id: str) -> list[dict]:
        """Newest first."""
        return [json.loads(r["body"]) for r in self._q(
            "SELECT body FROM eval_history WHERE cid=? AND checklist_id=? ORDER BY created_at DESC", (cid, checklist_id))]

    def history_all(self, checklist_id: str) -> list[dict]:
        """Every evaluation of every call for a checklist, newest first."""
        return [json.loads(r["body"]) for r in self._q(
            "SELECT body FROM eval_history WHERE checklist_id=? ORDER BY created_at DESC", (checklist_id,))]

    def next_eval_no(self, cid: str, checklist_id: str) -> int:
        rows = self._q("SELECT COUNT(*) n FROM eval_history WHERE cid=? AND checklist_id=?", (cid, checklist_id))
        return int(rows[0]["n"]) + 1

    def next_eval_id(self, cid: str) -> str:
        """A new history id for a call, unique across ALL checklists (eval_no stays per checklist for display)."""
        nums = [int(r["eval_id"].rsplit("#", 1)[1]) for r in self._q("SELECT eval_id FROM eval_history WHERE cid=?", (cid,))
                if r["eval_id"].rsplit("#", 1)[-1].isdigit()]
        return f"{cid}#{max(nums, default=0) + 1}"

    def set_appeal_body(self, aid: int, body: dict) -> None:
        self._q("UPDATE appeals SET body=? WHERE id=?", (json.dumps(body, ensure_ascii=False), aid))

    # evaluation runs (one per «Оценить» click; keeps its own snapshot of results) ---
    def create_run(self, body: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        with self.lock:
            cur = self.db.execute("INSERT INTO runs (status, body, created_at, updated_at) VALUES (?,?,?,?)",
                                  (body.get("status", "queued"), "{}", body.get("created_at", now), now))
            self.db.commit()
            rid = int(cur.lastrowid)
        body = {**body, "id": rid, "created_at": body.get("created_at", now)}
        self.update_run(body)
        return body

    def update_run(self, body: dict[str, Any]) -> None:
        self._q("UPDATE runs SET status=?, body=?, updated_at=? WHERE id=?",
                (body.get("status"), json.dumps(body, ensure_ascii=False), time.time(), body["id"]))

    def run(self, rid: int) -> Optional[dict]:
        rows = self._q("SELECT body FROM runs WHERE id=?", (rid,))
        return json.loads(rows[0]["body"]) if rows else None

    def runs(self, statuses: Optional[list[str]] = None) -> list[dict]:
        sql, args = "SELECT body FROM runs", ()
        if statuses:
            sql += " WHERE status IN (%s)" % ",".join("?" * len(statuses))
            args = tuple(statuses)
        return [json.loads(r["body"]) for r in self._q(sql + " ORDER BY id DESC", args)]

    # dialogs ------------------------------------------------------------
    def save_dialog(self, d: dict, dataset: str) -> None:
        self._q("INSERT OR REPLACE INTO dialogs VALUES (?,?,?,?)",
                (d["conversation_id"], dataset, json.dumps(d, ensure_ascii=False), time.time()))

    def dialog(self, cid: str) -> Optional[dict]:
        rows = self._q("SELECT body FROM dialogs WHERE cid=?", (cid,))
        return json.loads(rows[0]["body"]) if rows else None

    def dialogs(self, dataset: Optional[str] = None) -> list[dict]:
        sql, args = "SELECT body, dataset, imported_at FROM dialogs", ()
        if dataset:
            sql, args = sql + " WHERE dataset=?", (dataset,)
        return [{**json.loads(r["body"]), "dataset": r["dataset"], "imported_at": r["imported_at"]}
                for r in self._q(sql + " ORDER BY cid", args)]

    # evaluations --------------------------------------------------------
    def save_evaluation(self, cid: str, checklist_id: str, body: dict) -> None:
        """One row per checklist version: re-applying a new version never erases
        the old evaluation, its appeals or decisions."""
        self._q("INSERT OR REPLACE INTO evaluations VALUES (?,?,?,?,?)",
                (cid, checklist_id, body["checklist_version"], json.dumps(body, ensure_ascii=False), time.time()))

    def evaluation_time(self, cid: str, checklist_id: str) -> Optional[float]:
        rows = self._q("SELECT MAX(updated_at) t FROM evaluations WHERE cid=? AND checklist_id=?", (cid, checklist_id))
        return rows[0]["t"] if rows else None

    def evaluation(self, cid: str, checklist_id: str, version: Optional[int] = None) -> Optional[dict]:
        if version:
            rows = self._q("SELECT body FROM evaluations WHERE cid=? AND checklist_id=? AND version=?",
                           (cid, checklist_id, version))
        else:
            rows = self._q("SELECT body FROM evaluations WHERE cid=? AND checklist_id=? "
                           "ORDER BY version DESC LIMIT 1", (cid, checklist_id))
        return json.loads(rows[0]["body"]) if rows else None

    def evaluations_latest(self, checklist_id: str) -> list[dict]:
        """Latest checklist version per dialog, with the time it was last written."""
        rows = self._q("SELECT e.body, e.updated_at FROM evaluations e JOIN "
                       "(SELECT cid, MAX(version) v FROM evaluations WHERE checklist_id=? GROUP BY cid) m "
                       "ON e.cid=m.cid AND e.version=m.v WHERE e.checklist_id=? ORDER BY e.cid",
                       (checklist_id, checklist_id))
        return [{**json.loads(r["body"]), "updated_at": r["updated_at"]} for r in rows]

    def checklist_versions(self, cid: str) -> list[dict]:
        return [{"version": r["version"], "created_at": r["created_at"]} for r in self._q(
            "SELECT version, created_at FROM checklists WHERE id=? ORDER BY version DESC", (cid,))]

    def evaluation_versions(self, cid: str, checklist_id: str) -> list[int]:
        return [r["version"] for r in self._q(
            "SELECT version FROM evaluations WHERE cid=? AND checklist_id=? ORDER BY version", (cid, checklist_id))]

    # appeals ------------------------------------------------------------
    def create_appeal(self, cid: str, checklist_id: str, criterion_id: str, comment: str, body: dict) -> int:
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO appeals (cid, checklist_id, criterion_id, comment, status, body, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (cid, checklist_id, criterion_id, comment, "pending", json.dumps(body, ensure_ascii=False),
                 time.time()))
            self.db.commit()
            return int(cur.lastrowid)

    def appeal(self, aid: int) -> Optional[dict]:
        rows = self._q("SELECT * FROM appeals WHERE id=?", (aid,))
        return self._appeal_row(rows[0]) if rows else None

    def appeals(self, status: Optional[str] = None, cid: Optional[str] = None) -> list[dict]:
        sql, conds, args = "SELECT * FROM appeals", [], []
        if status:
            conds.append("status=?")
            args.append(status)
        if cid:
            conds.append("cid=?")
            args.append(cid)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        return [self._appeal_row(r) for r in self._q(sql + " ORDER BY id DESC", tuple(args))]

    def update_appeal(self, aid: int, status: str, body: dict) -> None:
        self._q("UPDATE appeals SET status=?, body=?, decided_at=? WHERE id=?",
                (status, json.dumps(body, ensure_ascii=False), time.time(), aid))

    @staticmethod
    def _appeal_row(r: sqlite3.Row) -> dict:
        return {"id": r["id"], "conversation_id": r["cid"], "checklist_id": r["checklist_id"],
                "criterion_id": r["criterion_id"], "comment": r["comment"], "status": r["status"],
                "created_at": r["created_at"], "decided_at": r["decided_at"], **json.loads(r["body"])}
