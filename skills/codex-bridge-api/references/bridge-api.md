# Bridge API Reference

## Preconditions

- The Codex Bridge VS Code extension must be installed and running on the same machine.
- The default base URL is `http://127.0.0.1:8765`.
- If `codexBridge.authToken` is configured, send the bearer token.

## Core Endpoints

### `GET /health`

Use this to confirm the bridge is alive and to inspect aggregate job counts.

### `POST /conversations`

Use this to start a new conversation.

Important fields:

- `message`
- `cwd`
- `approvalPolicy`
- `sandbox`
- `model`
- `sendTimeoutMs`
- `openTimeoutMs`
- `outputLastMessagePath`

If `message` is omitted, the bridge opens a blank draft panel and does not start work.

### `POST /conversations/{conversationId}/messages`

Use this to continue a known conversation.

Important fields:

- `message`
- `ensureOpen`
- `approvalPolicy`
- `sandbox`

### `GET /jobs/{jobId}`

Use this to poll worker progress until the job reaches `completed` or `failed`.

## Job States

- `starting`
- `running`
- `completed`
- `failed`

## Recommended Automation Pattern

1. Call `health`.
2. Dispatch the task with `start` or `resume`.
3. Extract `job.jobId`.
4. Poll `job`.
5. Stop only when the state is terminal.

## Full-Auto Mode

For trusted local runs, use:

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`

or the script shortcut:

```bash
python scripts/bridge_client.py start --message "..." --dangerous-auto
```

Use that only when the task and machine are trusted.
