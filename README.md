# chrome-ext-translate-lm

Chrome extension that translates text and images via a locally hosted LM (LM Studio, Ollama, or anything OpenAI-compatible). No data leaves your machine.

## Install

1. Clone this repo
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this directory
3. Start your local inference server (defaults assume LM Studio on `localhost:1234`)

## Usage

Right-click anywhere to get:

| Context menu                        | What it does                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Translate selection**             | Sends selected text to the LM, shows result in a corner overlay.                                   |
| **Translate image**                 | Sends the image to a vision model, dumps all extracted + translated text into the corner overlay.  |
| **Translate image (hover boxes)**   | Two-pass: detects text regions with bounding boxes, then translates each. Draws boxes on the image — hover a box to see original + translation. |

The hover-box mode expects a model that returns Gemma-style grounding output:

```json
[{"box_2d": [ymin, xmin, ymax, xmax], "label": "..."}]
```

with coordinates normalized to 0–1000. Gemma 3/4 vision models do this reliably when prompted; the prompt is editable in settings.

## Configuration

Click the extension icon to open settings:

- **Endpoint** — defaults to `http://localhost:1234/v1/chat/completions`
- **Model** — leave blank to use whatever's loaded; set explicitly if you run multiple
- **Target language** — what to translate *into*
- **System prompt** — translation instruction (use `{LANG}` as placeholder)
- **Detection prompt** — the grounding prompt for hover-box mode

Settings persist via `chrome.storage.sync`.

## Diagnostics

The popup shows per-call stats for the last 20 requests:

- **TTFT** — time to first token (measured via streaming)
- **Total** — wall-clock request time
- **TBT** — average ms between tokens after the first: `(total − TTFT) / (completion_tokens − 1)`
- **tok/s** — generation throughput
- **P/C** — prompt tokens / completion tokens

Calls are tagged by kind (`text`, `image`, `detect`, `batch`) so the two-pass hover-box flow shows as two separate rows. Updates live while the popup is open.

## Model requirements

| Feature              | Needs                                              |
| -------------------- | -------------------------------------------------- |
| Text translation     | Any instruct model                                 |
| Image → text dump    | Any vision model (Qwen2-VL, LLaVA, MiniCPM-V, ...) |
| Hover boxes          | Vision model with grounding (Gemma 3/4 vision)     |

## Architecture

- **MV3 service worker** (`background.js`) — context menus, LM client, SSE streaming, stat collection
- **Programmatic injection** — overlay UIs are injected on demand via `chrome.scripting.executeScript`; no persistent content script
- **Image fetching** — done from the service worker to bypass page CSP; requires `<all_urls>` host permission
- **Box positioning** — overlay container anchored to image document coords; boxes use CSS percentages (`coord / 10`) so they scale with the rendered image
