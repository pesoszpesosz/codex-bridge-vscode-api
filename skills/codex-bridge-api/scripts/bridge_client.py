#!/usr/bin/env python3
"""Small client for the local Codex Bridge API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_URL = os.environ.get("CODEX_BRIDGE_URL", "http://127.0.0.1:8765").rstrip("/")
DEFAULT_TOKEN = os.environ.get("CODEX_BRIDGE_TOKEN", "").strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Call the local Codex Bridge API.")
    parser.add_argument("--url", default=DEFAULT_URL, help="Bridge base URL.")
    parser.add_argument("--token", default=DEFAULT_TOKEN, help="Optional bridge auth token.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health", help="Fetch bridge health.")
    subparsers.add_parser("jobs", help="List jobs.")
    subparsers.add_parser("open", help="List open conversations.")
    subparsers.add_parser("current", help="Show the active conversation.")

    job_parser = subparsers.add_parser("job", help="Fetch one job.")
    job_parser.add_argument("job_id")

    wait_parser = subparsers.add_parser("wait", help="Poll a job until completion.")
    wait_parser.add_argument("job_id")
    wait_parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds.")
    wait_parser.add_argument("--timeout", type=float, default=0.0, help="Maximum wait time in seconds. 0 means no limit.")

    start_parser = subparsers.add_parser("start", help="Start a new conversation.")
    add_dispatch_arguments(start_parser, include_message=True)

    resume_parser = subparsers.add_parser("resume", help="Continue an existing conversation.")
    resume_parser.add_argument("conversation_id")
    add_dispatch_arguments(resume_parser, include_message=True)
    resume_parser.add_argument("--ensure-open", dest="ensure_open", action="store_true", default=True)
    resume_parser.add_argument("--no-ensure-open", dest="ensure_open", action="store_false")

    return parser.parse_args()


def add_dispatch_arguments(parser: argparse.ArgumentParser, include_message: bool) -> None:
    if include_message:
        parser.add_argument("--message", help="Task prompt.")
    parser.add_argument("--cwd", help="Working directory for the task.")
    parser.add_argument("--approval-policy", choices=["untrusted", "on-failure", "on-request", "never"])
    parser.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"])
    parser.add_argument("--model")
    parser.add_argument("--send-timeout-ms", type=int)
    parser.add_argument("--open-timeout-ms", type=int)
    parser.add_argument("--output-last-message-path")
    parser.add_argument("--dangerous-auto", action="store_true", help="Shortcut for approvalPolicy=never and sandbox=danger-full-access.")


def build_headers(token: str) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def request_json(base_url: str, token: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"{base_url}{path}"
    data = None
    headers = build_headers(token)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            details = json.loads(payload)
        except json.JSONDecodeError:
            details = {"ok": False, "error": payload or str(error)}
        raise RuntimeError(f"{error.code} {details.get('error', str(error))}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Bridge request failed: {error.reason}") from error


def build_dispatch_body(args: argparse.Namespace) -> dict:
    body: dict[str, object] = {}
    if getattr(args, "message", None):
        body["message"] = args.message
    if args.cwd:
        body["cwd"] = args.cwd
    if args.model:
        body["model"] = args.model
    if args.send_timeout_ms is not None:
        body["sendTimeoutMs"] = args.send_timeout_ms
    if args.open_timeout_ms is not None:
        body["openTimeoutMs"] = args.open_timeout_ms
    if args.output_last_message_path:
        body["outputLastMessagePath"] = args.output_last_message_path

    if args.dangerous_auto:
        body["approvalPolicy"] = "never"
        body["sandbox"] = "danger-full-access"
    else:
        if args.approval_policy:
            body["approvalPolicy"] = args.approval_policy
        if args.sandbox:
            body["sandbox"] = args.sandbox

    if hasattr(args, "ensure_open"):
        body["ensureOpen"] = args.ensure_open

    return body


def print_json(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=False))


def wait_for_job(base_url: str, token: str, job_id: str, interval: float, timeout: float) -> int:
    started = time.monotonic()
    while True:
        payload = request_json(base_url, token, "GET", f"/jobs/{urllib.parse.quote(job_id)}")
        print_json(payload)
        job = payload.get("job") or {}
        status = job.get("status")
        if status == "completed":
            return 0
        if status == "failed":
            return 1
        if timeout and time.monotonic() - started >= timeout:
            print(f"Timed out waiting for job {job_id}.", file=sys.stderr)
            return 2
        time.sleep(interval)


def main() -> int:
    args = parse_args()
    try:
        if args.command == "health":
            print_json(request_json(args.url, args.token, "GET", "/health"))
            return 0
        if args.command == "jobs":
            print_json(request_json(args.url, args.token, "GET", "/jobs"))
            return 0
        if args.command == "open":
            print_json(request_json(args.url, args.token, "GET", "/conversations/open"))
            return 0
        if args.command == "current":
            print_json(request_json(args.url, args.token, "GET", "/conversations/current"))
            return 0
        if args.command == "job":
            print_json(request_json(args.url, args.token, "GET", f"/jobs/{urllib.parse.quote(args.job_id)}"))
            return 0
        if args.command == "wait":
            return wait_for_job(args.url, args.token, args.job_id, args.interval, args.timeout)
        if args.command == "start":
            print_json(request_json(args.url, args.token, "POST", "/conversations", build_dispatch_body(args)))
            return 0
        if args.command == "resume":
            path = f"/conversations/{urllib.parse.quote(args.conversation_id)}/messages"
            print_json(request_json(args.url, args.token, "POST", path, build_dispatch_body(args)))
            return 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
