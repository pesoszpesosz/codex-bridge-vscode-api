---
name: codex-bridge-api
description: Use this skill when Codex, OpenClaw, or another skill-aware agent needs direct programmable access to the local Codex Bridge API in VS Code. It supports checking bridge health, starting a new VS Code Codex conversation, continuing an existing conversation by conversationId, polling worker jobs to completion, and using full-auto settings for trusted local tasks.
---

# Codex Bridge API

Use the local Codex Bridge HTTP API instead of manually typing into the VS Code Codex UI.

## Quick Start

1. Confirm the bridge is running with `python scripts/bridge_client.py health`.
2. Start a new task with `python scripts/bridge_client.py start --message "..."`.
3. Poll the returned job with `python scripts/bridge_client.py wait JOB_ID`.
4. Continue an existing conversation with `python scripts/bridge_client.py resume CONVERSATION_ID --message "..."`.

Read [references/bridge-api.md](references/bridge-api.md) for endpoint details and request fields.

## Standard Workflow

### Check availability

Run:

```bash
python scripts/bridge_client.py health
```

If the bridge is not available, stop and report that the local VS Code extension is not running.

### Start a new worker task

Run:

```bash
python scripts/bridge_client.py start --message "Inspect the repo and fix the failing tests"
```

Add `--cwd` when the task must run in a specific workspace.

For trusted local automation, add:

```bash
--approval-policy never --sandbox danger-full-access
```

or use the shortcut:

```bash
--dangerous-auto
```

### Continue an existing conversation

Run:

```bash
python scripts/bridge_client.py resume CONVERSATION_ID --message "Continue from the previous step"
```

### Wait for completion

If a response includes `job.jobId`, poll it with:

```bash
python scripts/bridge_client.py wait JOB_ID
```

Treat `completed` as success and `failed` as a real worker failure.

## Usage Notes

- Prefer `--dangerous-auto` only for trusted local tasks.
- Use `--token` or `CODEX_BRIDGE_TOKEN` if the bridge requires authentication.
- Use `--url` or `CODEX_BRIDGE_URL` if the bridge is not running on the default loopback address.
- Expect some advanced requests to fall back to the CLI path; those runs may not appear in the Codex history sidebar.

## Resources

### scripts/bridge_client.py

Use this helper to call the local bridge without rewriting HTTP request code.

### references/bridge-api.md

Read this when you need request fields, endpoint behavior, or job semantics.
