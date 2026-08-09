# 3-configure-api-keys

Snow App manages model provider access through **API profiles**, supporting multiple profiles and one-click switching. This article explains how to configure API keys and models in the GUI, and where the corresponding configuration files are located.

## 1. Configuration Entries

| Entry | Description |
| --- | --- |
| Settings → API Settings (settings page id: `api-settings`) | GUI: create / edit / switch API profiles |
| `api_configs` table in the app database | **Authoritative store for all profiles**; one row per profile (`profile_name` is the unique identifier) |
| `activeProfile` field in `~/.snow/active-profile.json` | Records the **currently active profile name**; the active config = that profile's row in `api_configs` |
| `snowcfg` field in `~/.snow/config.json` | CLI compatibility layer / snapshot shared with Snow CLI, **not** the authoritative source |

> **Storage at a glance**: profiles live in the `api_configs` table of the app
> database; the active profile is chosen via `activeProfile`. The `config` tool
> and the UI read/write the **currently active profile**; the `snowcfg` field in
> `config.json` is just a CLI-compatible mirror of the active profile.

## 2. GUI Configuration (multiple profiles)

Open **Settings → API Settings** to create multiple profiles. When creating a profile, fill in:

| Field | Required | Description |
| --- | --- | --- |
| Profile name | Yes | Unique identifier for the profile, e.g. `openai` |
| Display name | No | Name shown in the UI; defaults to the profile name if omitted |
| Base URL | Yes | Service endpoint URL |
| Base URL mode | Yes | `auto` automatic / `custom` manual |
| API Key | Yes | Provider key, e.g. `sk-...` |
| Request method | Yes | e.g. `chat` |
| Advanced model | Yes | Model used for complex tasks |
| Basic model | Yes | Model used for lightweight tasks |
| Vision model | No | Image understanding model, can be configured separately |

When a model input is focused, the available model list is automatically fetched from the current Base URL; you can also fill it in manually.

### Separate Vision Model Configuration

When the main model does not support vision, turn off the **Supports vision** switch and configure `visionBaseUrl`, `visionApiKey`, `visionRequestMethod`, `visionModel` separately, so image understanding requests go to a dedicated endpoint and key. Images are textified into descriptions for the main model; each image in a **user message** also gets a `[Reference image #N ...]` block (just a relative path under the upload/ directory), so image-to-image editing still uses the **original image** and is never downgraded to text-to-image (see [9-image-generation](9-image-generation.md)).

### Optional Configuration

- **System prompt**: choose from saved system prompts, or inherit the global profile setting;
- **Custom header scheme**: choose a scheme defined in `custom-headers.json`, with the option to "inherit global" or "use none";
- **Auto-compress**: when `enableAutoCompress` is on, history messages are automatically compressed when context usage reaches the threshold `autoCompressThreshold` (percentage);
- **Google search (Gemini)**: when `googleSearch` is enabled, Gemini chat requests inject the Google Search tool for real-time web grounding; the separate vision-model section has its own `visionGoogleSearch` switch for vision requests;
- **Responses Fast Mode**: when the request method is `responses`, you can enable `responsesFastMode` so the server processes Responses requests in fast mode.

The form validates fields per request method: switching methods resets or skips fields that do not apply (such as reasoning effort or Responses-only options), preventing invalid combinations from being submitted.

The fields above are stored as one row for the profile in the `api_configs` table of the app database; a copy of the currently active profile is synced to the `snowcfg` field of `~/.snow/config.json`, shared with Snow CLI.

## 3. Switching Profiles

Toggle the **Enable profile** switch in API Settings to switch the currently active profile; the active profile name is recorded in the `activeProfile` field of `~/.snow/active-profile.json`. Agents can also switch directly with the config tool (see [5.1 ④](#51-quick-reference-agent-follow-along)).

## 4. Advanced Options

Some advanced parameters can be configured in the Runtime area of the UI (such as max context, max generation tokens, stream idle timeout, retry count and delay); the rest can be edited directly in the `snowcfg` field of `~/.snow/config.json`:

| Field | Description |
| --- | --- |
| `maxContextTokens` | Max context tokens |
| `maxTokens` | Max tokens per generation |
| `streamIdleTimeoutSec` | Stream response idle timeout (seconds) |
| `maxRetries` | Max request retries |
| `retryDelayMs` | Retry interval (milliseconds) |
| `showThinking` | Whether to show the thinking process |
| `chatThinking.reasoning_effort` | Reasoning effort (e.g. `max`) |
| `toolResultTokenLimit` | Token limit for tool results written into the context |

> **Tip**: after editing `config.json` directly, restart the app for the changes to take effect.

## 5. AI / CLI Configuration (config tool)

Snow App ships a built-in `config` tool; AI agents can read/write the same
config that the UI uses — **the `snowcfg` scope operates on the currently
active profile**:

| Tool | Purpose |
| --- | --- |
| `config-list scope=snowcfg` | List the full config of the currently active profile |
| `config-get scope=snowcfg key=baseUrl` | Read a single key (`apiKey` is always masked, e.g. `sk-****abcd`) |
| `config-set scope=snowcfg key=baseUrl value="..."` | Write a single key (whitelist + type check + auto backup + atomic write) |
| `config-set scope=app key=activeProfile value="profile-name"` | Switch the currently active profile (writes `active-profile.json`) |

### 5.1 Quick Reference (agents, follow along)

#### ① View the currently active profile

```
config-list scope=snowcfg   # full config of the active profile (apiKey masked)
config-list scope=app       # see activeProfile = the active profile name
```

#### ② Change the API key

```
config-set scope=snowcfg key=apiKey value="sk-new-key"
```

Note: `apiKey`/`visionApiKey` are always masked when read — **never ask for or
display plaintext keys**; the user provides the key, you write it, and every
write is backed up automatically to `~/.snow/.config-backups/`.

#### ③ Change the model

```
config-set scope=snowcfg key=advancedModel value="new-model"   # advanced model
config-set scope=snowcfg key=basicModel value="new-model"      # basic model
config-set scope=snowcfg key=visionModel value="new-model"     # vision model (when configured separately)
```

Or update several fields at once (omitting `key` writes the object):

```jsonc
config-set scope=snowcfg value={
  "advancedModel": "gpt-4o",
  "maxTokens": 8192,
  "showThinking": true
}
```

#### ④ Switch the active profile

```
config-set scope=app key=activeProfile value="profile-name"
```

- The profile name must exist (`api_configs.profile_name` in the app database);
- If the agent cannot enumerate profiles, first run `config-list scope=app` to
  see the current value, then ask the user to confirm the available profile
  names in **Settings → API Settings**;
- This is file-backed — a restart or UI re-save fully applies the switch.

#### ⑤ Create a new profile (UI only — agent guides the user)

The config tool **cannot** create profiles directly; the agent should open the
settings page for the user:

```
app-control-openSettings page=api-settings
```

Guide the user through: profile name (unique), display name, Base URL (+ mode),
API Key, request method, advanced model, basic model, vision model (optional),
etc. After saving, the profile appears in `api_configs` and can be activated
with the **Enable profile** switch in API Settings.

### 5.2 Effect of writes

`snowcfg`/`app` are file-backed — changes take effect after an app restart or a
UI re-save; `apiKey`/`visionApiKey` are always masked — never ask for or display
plaintext keys; every write is backed up automatically to `~/.snow/.config-backups/`.

## 6. FAQ

| Symptom | Cause & fix |
| --- | --- |
| Requests return 401/403 | Check whether `apiKey` and `baseUrl` are correct and whether the key has expired |
| The model doesn't support thinking | Turn off `showThinking` or adjust `chatThinking.reasoning_effort` |
| Vision model unavailable | Configure `visionBaseUrl`, `visionApiKey`, `visionModel` separately |
| Profile switch has no effect | Verify the value of `activeProfile` in `active-profile.json` |

## 6. Reference

- Full field documentation: [3-reference/1-settings-json-reference](../3-reference/1-settings-json-reference.md)
