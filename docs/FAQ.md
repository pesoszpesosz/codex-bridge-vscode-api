# FAQ

## Why not use the official OpenAI API instead?

This project is for automating the Codex experience inside VS Code specifically. It is useful when your workflow depends on the installed VS Code ChatGPT/Codex extension, its local session state, its conversation tabs, and its history sidebar.

## Does this create real conversations in the Codex history sidebar?

Yes, when the app-server transport is used. Those conversations are created as `vscode` source threads, which makes them appear in the Codex history UI.

## Why do some runs not appear in the history sidebar?

Some advanced options still require the legacy CLI `exec` fallback path. Those runs may be created as `exec` source threads instead of `vscode` source threads.

## Can older invisible bridge conversations be fixed?

Yes. Continuing one through the current bridge automatically upgrades it into a new history-visible `vscode` thread unless you disable that behavior.

## Does this run remotely?

No. It is a local API intended to run on the same machine as VS Code.

## Is this an official stable OpenAI API?

No. It depends on internal behavior of the installed ChatGPT/Codex extension and may need updates when that extension changes.

## How do I make it fully automatic?

Use:

- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`

Only do that on a trusted machine with trusted tasks.

## What should I do if requests fail immediately?

Check:

- the ChatGPT extension is installed
- Codex is available in that extension
- the bridge is running
- your auth token matches if one is configured
- the selected working directory exists

## What should I do if a conversation opens but the worker does not finish?

Poll `/jobs/:jobId` and inspect:

- `status`
- `lastEventType`
- `error`
- `openError`

Those fields are the fastest way to see whether the failure happened during dispatch, worker execution, or tab reveal.
