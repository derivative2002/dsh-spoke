# wire-tap (extra)

A tiny evidence plugin for the DSH runtime: it taps the `llm/stream`
middleware seam and appends every request/response pair — full message list,
tool definitions, every streamed chunk, and any thrown error — to a JSONL
file.

Why it exists here: dsh-spoke's stance is that a governed seat must be able
to **prove** what happened, not just claim it. `--event-log` captures the
session-event stream (tool calls, status); wire-tap captures the layer below
it (raw model traffic). Together they make a run auditable end to end.

## Use

Link the plugin into your seat profile's `node_modules`, add the patch from
`cordis.patch.yml` to the profile's `cordis.patch.yml`, and set:

```bash
export DSH_WIRE_TAP_PATH=/path/to/captures.jsonl
```

Passive by design: chunks pass through unchanged; capture happens in
`finally`, so even a mid-stream failure leaves its partial evidence.

⚠ The capture contains the complete prompt and completion stream — treat the
output file with the same care as the conversation itself.
