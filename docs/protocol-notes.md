# Codex app-server protocol notes

This is an integration design reference, not a claim that every row is implemented or end-to-end tested. The installed CLI inspected during research was `codex-cli 0.169.0`. The linked upstream `main` schemas can advance independently; generate schemas from the deployment's exact Codex binary before declaring compatibility.

## Transport and initialization

Use a host-side child process, `codex app-server`, with newline-delimited JSON on stdin/stdout. Reserve stderr for diagnostics. Messages are bidirectional JSON-RPC-shaped objects without a `jsonrpc` member. Requests have `id`, `method`, `params`; responses echo the original `id` with `result` or `error`; notifications have no `id`. Do not confuse a server-initiated request with a response merely because it has an ID. [Official transport and initialization guide](https://learn.chatgpt.com/docs/app-server).

Send once per connection, wait for the response, then send `initialized`:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"dsh_codex_app_server","title":"DSH Codex App Server","version":"0.1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
{"method":"initialized","params":{}}
```

Experimental opt-in is needed for the user-input integration. Do not claim capabilities such as human-command approval or attestation unless actually implemented. The [initialization capability schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/InitializeCapabilities.ts) is authoritative for advertised fields.

## Session and turn mapping

The IDs below are placeholders. Persist the returned Codex thread ID with the DSH session; never derive it from a title or reuse another session's ID.

```json
{"id":2,"method":"thread/start","params":{"cwd":"/absolute/workspace","approvalPolicy":"on-request","sandbox":"workspace-write"}}
{"id":3,"method":"thread/resume","params":{"threadId":"THREAD_ID"}}
{"id":4,"method":"turn/start","params":{"threadId":"THREAD_ID","input":[{"type":"text","text":"Inspect the project","text_elements":[]}]}}
{"id":5,"method":"turn/steer","params":{"threadId":"THREAD_ID","expectedTurnId":"TURN_ID","input":[{"type":"text","text":"Only inspect the frontend","text_elements":[]}]}}
{"id":6,"method":"turn/interrupt","params":{"threadId":"THREAD_ID","turnId":"TURN_ID"}}
```

| DSH operation | Protocol and behavior |
| --- | --- |
| New session | `thread/start`; capture `result.thread.id` and effective settings. |
| Reopen session | `thread/resume` with the saved ID. Resume does not itself send a new user turn. Reconcile returned history with persisted UI items. |
| Idle input | `turn/start`; `model`, `effort`, `summary`, `cwd` and approval/sandbox overrides are optional. Omit model to retain configured defaults rather than hard-coding one. |
| Input during work | `turn/steer` with `expectedTurnId`; stale preconditions must surface or trigger a state refresh, not silently target a different turn. |
| Stop | `turn/interrupt`; acknowledgement is not completion. Wait for the matching `turn/completed`. |
| Recovery | Reconnect/initialize/resume and reconcile IDs. Do not replay an uncertain `turn/start` automatically, because it may already have been accepted. |

Sources: [ThreadStartParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts), [ThreadResumeParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts), [TurnStartParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts), [TurnSteerParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TurnSteerParams.ts), [TurnInterruptParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TurnInterruptParams.ts).

## Streaming and rendering contract

Use `(threadId, turnId, itemId)` as the UI correlation key. Register event handling before starting work; events and request responses can interleave.

| Event | DSH projection |
| --- | --- |
| `turn/started` | Record `params.turn.id`, mark active. |
| `item/started` | Upsert `params.item`, preserving its original type and ID. |
| `item/agentMessage/delta` | Append `params.delta` only to that message's provisional text. |
| `item/reasoning/summaryTextDelta` | Append to the specified `summaryIndex`; render separately from answer text. |
| `item/commandExecution/outputDelta` | Append command output, not assistant prose. |
| `item/fileChange/outputDelta`, `item/fileChange/patchUpdated` | Tool/file-change presentation rather than answer prose. |
| `item/completed` | Reconcile the authoritative full item. Replace text/output with `item.text`/`item.aggregatedOutput`, not append it again. |
| `turn/completed` | Use `params.turn.status`: `completed`, `interrupted`, or `failed`; expose `turn.error` where supplied. Clear only this turn's pending UI. |
| `serverRequest/resolved` | Remove the pending prompt identified by `params.requestId`; disable stale answer controls. |

`ThreadItem` also includes user messages, plans, file changes, MCP and dynamic tool calls, collaboration, image and compaction items. Preserve unsupported items as clearly labeled activity rather than dropping them or falsely showing success. Read `agentMessage.phase` where present; commentary is not necessarily a final answer. Unknown notifications should not crash the stream.

Sources: [ServerNotification](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts), [ThreadItem](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts), [Turn](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts).

## Approvals and user input

Every response below uses the original **server request ID**, not `itemId`, `turnId`, or `approvalId`. Preserve ID type (string or number). Route by connection generation as well as request ID to avoid answering an obsolete request after a restart.

### Commands and file changes

Handle `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. Display the action, cwd, reason and scope that the server provides. The command can be absent for some approval kinds; do not fabricate it. File changes can be obtained from the matching item.

```json
{"id":"SERVER_REQUEST_ID","result":{"decision":"accept"}}
{"id":"SERVER_REQUEST_ID","result":{"decision":"decline"}}
{"id":"SERVER_REQUEST_ID","result":{"decision":"cancel"}}
```

`acceptForSession` and structured command/network amendments have broader implications and must not be substituted for one-time approval. A `kind: "humanCommand"` request allows only a fresh human `accept`, `decline`, or `cancel`; supporting it also requires `requiredHumanApproval: true` at initialization. Do not infer approval from successful transport, elapsed time, dismissal, or a generic chat message.

Sources: [command approval params](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionRequestApprovalParams.ts), [command decisions](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionApprovalDecision.ts), [file decisions](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/FileChangeApprovalDecision.ts), [human checkpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

### Permission grants are a different response type

`item/permissions/requestApproval` supplies `permissions`, `cwd`, `reason`, and thread/turn/item/environment identifiers. Return only the approved subset, not a command decision:

```json
{"id":"SERVER_REQUEST_ID","result":{"permissions":{},"scope":"turn"}}
```

The empty object grants nothing. Valid scope is `turn` or `session`; session scope must be explicit in the UI. The profile's optional keys are `network` and `fileSystem`; use their version-matched schema, never an invented boolean or blanket full-access conversion. [Permission response schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/PermissionsRequestApprovalResponse.ts).

### Questions

`item/tool/requestUserInput` supplies `questions`, each with `id`, `header`, `question`, `isOther`, `isSecret`, and nullable `options`. Options have a label/description. Map the selected label or free text to its question ID:

```json
{"id":"SERVER_REQUEST_ID","result":{"answers":{"layout-choice":{"answers":["Compact"]}}}}
```

Keep secret answers out of logs and mask input. Current main adds `isBlocking` and deprecates `autoResolutionMs`; older servers may omit `isBlocking`. Do not turn missing fields or timeouts into fabricated answers. Dismissal must have an explicit cancellation policy, not silently choose the first option. Sources: [question](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputQuestion.ts), [params](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts), [response](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputResponse.ts).

MCP elicitation is separate (`mcpServer/elicitation/request`): form/URL workflows respond with `action: accept|decline|cancel` and `content`, not `answers`. If unsupported, expose the limitation and use a supported decline/cancel response; never auto-accept. [Official elicitation guide](https://learn.chatgpt.com/docs/app-server).

## Permission defaults and compatibility

`thread/start`/`thread/resume` use a `sandbox` string. A turn override uses `sandboxPolicy`, for example:

```json
{"type":"workspaceWrite","writableRoots":["/absolute/workspace"],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}
```

Approval policy and filesystem/network sandboxing are separate controls. `approvalPolicy: "never"` is not a sandbox bypass. Never switch to `danger-full-access` just because approval handling is missing. Show effective settings returned by the server rather than claiming requested settings were accepted. [SandboxPolicy](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts), [AskForApproval](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts).

Recommended release checks: pinned CLI schema validation; fake-server tests for interleaved response/event IDs and late approvals; live authenticated text/command/approval/interruption/resume tests; unexpected process exit; reconnect with pending requests; unsupported experimental methods. Protocol research alone does not establish authenticated live compatibility.
