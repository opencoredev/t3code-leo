# Pi

T3 Code connects to Pi through the external `pi-acp` executable from
[`@automatalabs/pi-acp`](https://www.npmjs.com/package/@automatalabs/pi-acp).

## Install

Install the ACP bridge on the machine that runs the T3 Code server:

```bash
bun add -g @automatalabs/pi-acp
pi-acp --version
```

Open **Settings**, select **Add provider instance**, and select **Pi**. Set **Binary path** if
`pi-acp` is not on the server's `PATH`.

## Configuration and credentials

Pi ACP uses the server process environment and the normal Pi agent directory. It respects
`PI_CODING_AGENT_DIR`, `HOME`, user and project Pi settings, credentials, custom providers, Pi MCP
servers, extensions, skills, prompt templates, and packages. T3 Code also adds its session MCP
server without removing Pi's configured MCP servers.

Extensions must support headless use. TUI-only extension interfaces are not available in T3 Code.
T3 Code does not disable Pi resources.

Pi credentials can come from Pi's stored credentials or the provider API key environment variables
that Pi supports. Keep these values on the server machine.

## Sessions

Pi supports new and resumed ACP sessions, streaming output, tool progress, image prompts,
permissions, cancellation, model selection, and thinking-level selection. T3 Code shows form
elicitation when every field can be represented as a choice or boolean question. T3 Code rejects
URL elicitation and arbitrary text or number fields with a clear error because its current user
input panel cannot represent them safely.
