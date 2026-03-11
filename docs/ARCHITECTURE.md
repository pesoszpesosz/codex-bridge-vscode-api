# Architecture

## Overview

Codex Bridge is a VS Code extension that hosts a local HTTP server and translates incoming API requests into Codex actions inside the installed OpenAI ChatGPT extension.

There are four main layers:

1. HTTP layer
2. job tracking layer
3. Codex transport layer
4. VS Code tab discovery and reveal layer

## Request Flow

For a typical `POST /conversations` request with a message:

1. the bridge accepts the HTTP request
2. it validates the body and resolves the working directory
3. it creates an in-memory job with status `starting`
4. it starts a new thread and turn through the Codex app-server when possible
5. it listens for worker notifications and updates the job to `running`
6. when the turn completes, it marks the job `completed` or `failed`
7. it attempts to reveal the corresponding VS Code conversation tab

## Transports

### Preferred transport: Codex app-server

The bridge uses the bundled Codex app-server when the requested options are supported by that path.

Benefits:

- creates `vscode` source threads
- makes new conversations appear in the Codex history sidebar
- provides richer worker lifecycle notifications
- avoids relying on startup event parsing from CLI stdout

### Fallback transport: Codex CLI exec

Some options still require the CLI `exec` path.

That path is kept as a compatibility fallback for requests that use features not exposed through the app-server transport yet.

Tradeoffs:

- those runs may be created as `exec` source threads
- `exec` source threads may not appear in the Codex history sidebar

## History-Visible Conversations

The project specifically prefers the app-server path because it creates `vscode` source threads.

That matters because the Codex history sidebar is source-sensitive. A conversation existing on disk is not enough by itself; it needs to be represented as the kind of thread the UI lists.

Older bridge-created conversations from the earlier `exec` transport are automatically upgraded when continued:

1. the bridge checks the thread summary
2. if the source is `exec`, it forks the thread
3. the forked thread becomes the active target
4. the response includes both the requested id and the upgraded id

## Job Model

Every dispatched worker run becomes a job record with:

- stable `jobId`
- lifecycle state
- timestamps
- `conversationId`
- open/focus result
- event counters
- last event summary
- exit and error fields

This lets external automation treat the bridge as a worker API instead of a blind fire-and-forget transport.

## In-Memory State

The bridge stores runtime state in memory:

- job records
- job ordering
- active app-server client
- app-server watchers by turn id and thread id
- conversation alias mapping for upgraded legacy threads

Job history is pruned to a fixed maximum length.

## VS Code Integration

The bridge inspects VS Code tab groups to:

- discover open Codex conversations
- detect the current active Codex conversation
- focus or reveal a conversation after dispatch

Conversation tabs are opened with the Codex conversation URI scheme.

## Security Model

The bridge is local-first:

- default host is `127.0.0.1`
- optional auth token can be required
- dangerous task execution is only enabled when the caller explicitly requests permissive approval/sandbox settings

The project does not try to enforce a hosted multi-tenant security model. It is designed for trusted local automation.

## Failure Modes

Important failure cases:

- ChatGPT/Codex extension not installed
- Codex app-server startup failure
- request timeout waiting for worker start
- tab reveal failure after successful dispatch
- upstream extension behavior changes

The HTTP API reports these as failed responses or failed jobs, depending on the stage where the problem happens.
