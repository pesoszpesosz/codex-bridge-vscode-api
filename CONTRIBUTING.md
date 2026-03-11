# Contributing

## Development Setup

1. Open the repo in VS Code.
2. Run `npm test`.
3. Launch an Extension Development Host with `F5` when you need to test the extension runtime.

## Before Opening a Pull Request

- keep changes focused
- update docs when the API surface changes
- update `openapi.json` when request or response shapes change
- run `npm test`

## Scope

Good contributions include:

- bridge stability improvements
- better job lifecycle reporting
- transport compatibility fixes
- API documentation improvements
- safer auth and deployment options

## Out of Scope

This repo is not trying to replace the official OpenAI API or expose a hosted service. It is a local integration layer for the VS Code ChatGPT/Codex extension.
