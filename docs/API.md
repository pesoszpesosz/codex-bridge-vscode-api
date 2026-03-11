# API Guide

## Base URL

```text
http://127.0.0.1:8765
```

## Endpoints

### `GET /health`

Returns:

- bridge status
- current conversation id
- aggregate job counts
- open conversation tabs

### `GET /jobs`

Returns job history, newest first.

### `GET /jobs/:jobId`

Returns one job record.

### `GET /conversations/open`

Returns the currently open Codex conversation tabs in VS Code.

### `GET /conversations/current`

Returns the active Codex conversation if the focused editor is a Codex tab.

### `POST /conversations`

Creates a new conversation.

If `message` is provided:

- starts a real worker turn
- returns a new `conversationId`
- returns `job` and `jobUrl`

If `message` is omitted:

- opens a blank Codex draft panel
- returns `conversationId: null`

Example:

```json
{
  "message": "Inspect the repo and fix the failing tests",
  "cwd": "C:\\path\\to\\repo",
  "approvalPolicy": "never",
  "sandbox": "danger-full-access"
}
```

### `POST /conversations/current/messages`

Sends a message to the active Codex conversation.

### `POST /conversations/:conversationId/messages`

Continues a specific conversation by id.

Common example:

```json
{
  "message": "Continue and finish the implementation",
  "ensureOpen": true
}
```

If the target conversation was a legacy `exec` thread, the response can also include:

- `requestedConversationId`
- `upgradedFromConversationId`

## Common Body Fields

- `message`
- `cwd`
- `approvalPolicy`
- `sandbox`
- `dangerouslyBypassApprovalsAndSandbox`
- `model`
- `serviceTier`
- `baseInstructions`
- `developerInstructions`
- `personality`
- `config`
- `images`
- `sendTimeoutMs`
- `openTimeoutMs`
- `outputSchemaPath`
- `outputLastMessagePath`
- `ensureOpen`
- `upgradeLegacyExecConversations`

## Job Lifecycle

Jobs move through these states:

- `starting`
- `running`
- `completed`
- `failed`

Useful job fields:

- `jobId`
- `operation`
- `status`
- `createdAt`
- `updatedAt`
- `startedAt`
- `completedAt`
- `conversationId`
- `opened`
- `openError`
- `eventCount`
- `lastEventType`
- `exitCode`
- `signal`
- `error`

## Auth

If `codexBridge.authToken` is configured, send one of:

- `Authorization: Bearer <token>`
- `X-Codex-Bridge-Token: <token>`

## OpenAPI

See [openapi.json](../openapi.json) for the machine-readable contract.
