# Models and custom endpoints

The terminal, browser and desktop clients use the same model registry. Profiles support
OpenAI-compatible **Chat Completions** APIs, including streaming and tool calls. A base URL
such as `https://provider.example/v1` is extended with `/chat/completions`; do not enter the
full completion URL. Native provider protocols other than this are not implemented.

## Add and switch from the interface

- **Web / desktop:** click the model name in the composer, then **Add model**. Enter an
  optional display name, API base URL, model ID and API key. **Save and use** selects it.
  The Settings model row opens the same picker.
- **TUI:** type `/models`, press Enter, then select **+ Add model** and press Enter (or press **A/a**). Tab or Enter advances
  through the fields. Enter on the API key field saves and selects the profile. Keys are
  masked. Use Up/Down and Enter to switch an existing profile; Esc returns to chat.
- `/model` also opens the TUI picker; `/model <profile-id>` selects a known profile directly.
- An empty key is allowed for a local endpoint that does not require authentication.

Model selection is shared by clients connected to the same runtime. It applies to newly
submitted turns and retries. Each run records the model profile ID and public model metadata;
queued/running work keeps its original profile. New child tasks inherit their parent's profile.
Conversation history remains in the same session when the user switches models.

Selection is saved as `activeModel` and restored on restart. An existing project-level selection,
or a selection of a project-only profile, is saved in that project's settings. Otherwise it is
saved in the user's global settings. Environment overrides still take precedence at startup.

## Configuration

The existing top-level `provider`, `baseUrl`, `model` and `credentials` remain supported as the
reserved **default** profile. Additional profiles live in `models`:

```json
{
  "approvalMode": "all",
  "activeModel": "fast",
  "models": {
    "fast": {
      "name": "Fast model",
      "provider": "compatible",
      "baseUrl": "https://provider.example/v1",
      "model": "your-model-id",
      "apiKeyEnv": "FAST_MODEL_API_KEY"
    },
    "review": {
      "name": "Review model",
      "provider": "compatible",
      "baseUrl": "https://another-provider.example/v1",
      "model": "another-model-id",
      "apiKeyEnv": "REVIEW_MODEL_API_KEY"
    }
  }
}
```

Examples are placeholders, not preconfigured working model IDs. Set the named environment
variables before launch. Profiles may alternatively use the existing `credentials.file` and
`credentials.provider` reference format. A profile with its own credential reference/environment
name does not silently use the legacy `LLM_API_KEY`. `thinking`, `reasoningEffort` and
`maxOutputTokens` can be set per profile and are not inherited from a different default model.

`ORCHESTRATOR_MODEL` selects a startup profile. Legacy `ORCHESTRATOR_PROVIDER`, `LLM_MODEL` or
`LLM_BASE_URL` overrides select the default profile unless `ORCHESTRATOR_MODEL` is also set.
Project `models` maps override global maps, following the existing settings precedence.

## Credential storage

UI-created profiles receive a unique ID. Their key is stored in the runtime host's
`~/.orchestrator/credentials.json` (or `ORCHESTRATOR_DATA_DIR/credentials.json`). Settings contain
only a file reference. Keys are local plaintext credentials, not encrypted vault entries.
The client does not persist them in browser storage; the form clears its key after saving or
closing. Model-list responses, runtime events and conversation JSONL contain no keys.

The current UI adds and selects profiles. Editing or removing saved profiles uses JSON
configuration and a runtime restart. Selecting a profile validates its local configuration;
provider authentication and model availability are checked when a real request is made.

## HTTP API

| Request | Purpose |
| --- | --- |
| `GET /v1/models` | Public profile IDs, labels, model IDs and provider types |
| `POST /v1/models` | Add `{name?, baseUrl, model, apiKey}`; returns public metadata |
| `POST /v1/model` | Select `{id}`; returns runtime info |
| `GET /v1/info` | Includes selected `modelId` and model/provider names |

These routes use the same origin and bearer-token rules as all other runtime APIs.
Do not place keys in query parameters or conversation messages.
