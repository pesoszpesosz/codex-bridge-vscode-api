# Security Policy

## Supported Versions

Only the latest version in the default branch is supported.

## Security Notes

Codex Bridge is a local automation API. It can dispatch powerful local Codex tasks, including danger-full-access tasks if the caller requests that mode.

Treat it as a trusted local component:

- keep it bound to loopback unless you have a strong reason not to
- set `codexBridge.authToken` if you expose it beyond loopback
- only use `approvalPolicy: "never"` and `sandbox: "danger-full-access"` on trusted machines and trusted prompts

## Reporting

If you discover a security issue, open a private report through your normal security channel before opening a public issue.
