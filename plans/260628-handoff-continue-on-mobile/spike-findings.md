# Spike findings — Handoff CLI resume (2026-06-28)

## Canonical resume command

```bash
agent -p --trust --force \
  --workspace "/absolute/path/to/repo" \
  --resume "<chatId>" \
  --output-format stream-json \
  --stream-partial-output \
  "<steer message>"
```

Binary: `~/.local/bin/agent` (v2026.06.19). Auth via saved CLI login (`agent login`).

## chatId source

Folder name under `~/.cursor/projects/<project-slug>/agent-transcripts/<chatId>/<chatId>.jsonl`.

Example: `c50dad89-6241-43c4-8282-eca5915efa40` for workspace `/Users/a1241968/Desktop/Oscar/nuncio`.

## project-slug rule

Absolute path → strip trailing slashes → drop leading `/` → replace `/` with `-`.

`/Users/a1241968/Desktop/Oscar/nuncio` → `Users-a1241968-Desktop-Oscar-nuncio`

## stream-json schema (verified)

| type | Maps to Nuncio event | Notes |
|------|---------------------|-------|
| `system` | skip | init metadata |
| `user` | skip | we emit our own user_message |
| `assistant` + `timestamp_ms` + no `model_call_id` | `assistant_delta` | token delta |
| `assistant` without `timestamp_ms` | skip | final flush duplicate |
| `result` + `subtype: success` | `assistant_message` | use `result` field |
| `result` + `subtype: error` | `error` | |
| unknown | skip + log | |

Sample delta lines:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SPI"}]},"timestamp_ms":1782655396343}
{"type":"result","subtype":"success","result":"SPIKE-OK",...}
```

## Failure modes

| Case | Behavior |
|------|----------|
| Wrong chatId | CLI exits non-zero; stderr has error |
| Wrong workspace | May still resume if chat exists globally |
| `agent` missing | spawn ENOENT |
| `agent ls` | TUI-only — **do not use headless** |

## IDE resume verified

`agent --resume c50dad89-...` with IDE transcript ID returned contextual "SPIKE-OK" — checkpoint loads correctly.
