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
- **Box positioning** — viewport layers follow image bounds on scroll, resize, and layout shifts; boxes use normalized CSS percentages. Cropped/object-fit images and rotated images may need additional alignment support.

## Development

The extension has no build step and no runtime dependencies; `package.json` only holds dev tooling. `node_modules/` sits in the extension folder and Chrome ignores it.

- `npm install` once (Node 22 or later, Python 3 for the bridge tests).
- `npm run check` runs everything that is free and offline: `npm run lint` (ESLint, bug rules only: undefined names, unused code) and `npm test` (the `tests/*.test.cjs` Node tests and the `tests/test_*.py` bridge tests). GitHub Actions runs the same command on pushes to `main` and on pull requests.
- `npm run test:e2e` is the paid, online reader check described below. It is not part of `check`.
- Files are plain scripts that share globals. When a page loads another script's global (as `reader.html` does with `EH` and `Balloon`), declare it in `eslint.config.mjs`.

## Overlay usability (0.4.0)

Panels and image controls now use a Shadow DOM with isolated styles and a top-layer host. The fixed panel header keeps Close, Copy, and Minimize available while long results scroll. Closing a request suppresses its later progress updates; it does not cancel server inference. Escape closes the panel, then closes boxes on a second press.

Numbered regions work with keyboard focus and clicks. Click a region for selectable translation text and expandable original/checked OCR. The bottom toolbar offers All translations, Hide/Show boxes, and Close boxes. Image layers follow scrolling and layout movement and are removed when their image disappears.

Progress distinguishes waiting, thinking, and writing. Output-limit failures are reported explicitly. Settings validate the endpoint and language, offer a five-second connection check against the models endpoint, and explain diagnostic columns on hover. Connection checks do not run inference. Reload the unpacked extension and refresh existing pages to activate the new UI.

UI regression fixture: run `node tests/serve-ui.cjs`, then open `http://127.0.0.1:8766`. It exercises hostile page CSS, RTL layout, long results, dismissal during progress, image movement and removal. Check at normal and narrow window widths. Run `node --test tests/stream.test.cjs` for streaming regressions. The fixture tests the real renderer but does not replace checking injection in Chrome on actual reader sites.

## Optional Vertex Gemini presets (0.5.0)

Run `powershell -ExecutionPolicy Bypass -File .\Start-VertexBridge.ps1`, reload the unpacked extension, then select a model preset in the popup and **Save**:

- **Local Gemma**: existing local endpoint and verification flow.
- **Gemini 3.6 Flash Minimal**: fast cloud detection and image-verified translation.
- **Gemini 3.8 Flash Low**: cloud detection and translation using 3.8.
- **Gemini 3.6 detect + 3.8 translate**: 3.6 grounding, then 3.8 image verification/translation; text translation also uses 3.8.
- **Gemini 4 Argon Low**: cloud detection and translation using `gemini-4-argon` at thinking level LOW (Argon has no MINIMAL level).

Cloud mode sends selected text/images to Google and bills project `buoyant-program-477612-e3`. The bridge uses location `us`: the requested `us-central1` returned 404 for 3.8. Existing settings are retained until you select and save a preset. The Gemma server is independent and can remain running. Disable image verification only if you want the older direct-image/marker-batch flow.

`vertex_bridge.py` listens only on `127.0.0.1:8001` and uses your existing **gcloud application-default credentials**. Python and Google Cloud CLI must be installed; if authentication expires, run `gcloud auth application-default login`. Tokens stay in bridge memory and are never placed in extension storage. Ordinary web-page origins are rejected; Chrome extension origins and local CLI clients are supported. The bridge accepts only the named Gemini model aliases listed at `/v1/models` and inline image data, with high image resolution and at most 4096 output tokens (2048 for extension text requests). It does not start automatically after reboot. Stop it using `Start-VertexBridge.ps1 -Stop`. Logs and the owned process ID are in `%LOCALAPPDATA%\LMTranslate`.

The popup's **Test connection** checks bridge reachability and model aliases; it does not establish cloud authorization or run paid inference. The first translation after starting the bridge also refreshes Google credentials and can take longer.

Validation: `python -B -m unittest discover -s tests -p 'test_vertex_bridge.py'` and `node --test tests/stream.test.cjs`. `node tests/vertex-live.cjs --go` is an explicit paid live benchmark using this machine's existing MangaSet assets; it refuses to overwrite results. Quality and timing reports are under `C:\Users\sqz269\Downloads\MangaSet-review\vertex-translations`.

## Translated reader for e-hentai galleries (0.6.0)

The reader translates a whole e-hentai gallery in its own extension tab. Open it in any of these ways:
- Click **Translated reader (LM Translate)** in the gallery page's link list, under Archive Download.
- Right-click a gallery page or a page viewer and choose **Open this gallery in the translated reader**.
- Right-click a link to a gallery or page and choose **Open linked gallery in the translated reader**. A link to page N starts the range at N.

**Images are not stored or served.** Each page is fetched into the reader tab's memory and shown through a `blob:` URL. It is re-encoded as JPEG q0.92, like the context-menu capture, and sent to the background worker, which forwards it only to the configured model endpoint. Nothing writes image data to extension storage, and it is gone when the tab closes. The browser's normal HTTP cache still applies, as for any page you view. The reader keeps text only, in the extension's IndexedDB: translations (boxes and source text), glossaries and your feedback. `tests/reader-e2e.cjs` checks this.

**Site etiquette.** Gallery listings are fetched once when the reader opens, 1.5 s apart. Each page viewer is fetched at least 3 s after the previous one, one at a time, and at most `Parallel` pages ahead of translation. A 509 image (viewing limit used up), HTTP 403/429/503/509 or a temporary-ban page stops further downloads. Pages already downloaded still finish. If an image fails, the reader asks for it once more from another image server, as the site's "Reload broken image" link does. A gallery behind a content warning has to be opened once in a normal tab first. Only `e-hentai.org` is supported.

**Controls**
- **Pages a to b, Parallel 1–3, Start / Pause / Cancel.**
  - Pause lets running pages finish. Cancel aborts in-flight model calls, as does closing the tab.
  - Pages translated earlier only reload their image and make no model calls. **Redo translated** translates them again.
  - Each page also has its own **Translate** / **Retranslate** button.
- **View**
  - **Text** sets English over the page. The translate step also returns each region's **placement**, and the lettering follows it:
    - `bubble` (speech or thought balloon, caption box): the Japanese is covered in the balloon's own colour, sampled from the page in memory, and re-lettered at the largest size that fits without splitting words.
      - **Balloon fitting** (`balloon.js`): the English uses the balloon's interior, not just the narrow column the Japanese occupied.
      - **How it works:** one flood fill per page finds each balloon, and a balloon shared by two text boxes is split between them. Glyph strokes and symbols inside the balloon count as interior. The English goes in the largest rectangle that contains the text's centre, kept a margin away from the outline.
      - **Fallbacks:** a fill that reaches the page edge, grows past 15% of the page, or isn't mostly bounded by a dark outline is treated as a leak, and that region keeps the old padded box. So does a balloon with no more room than the text box.
      - **Eval pages:** 70% of bubble regions get a fitted balloon, with a median of 1.9× more room (over 4× for the top tenth) and about 5 ms per page.
    - `art` (dialogue or asides drawn on the artwork with no balloon): dark text with a white outline over the art; nothing is erased.
    - `sfx` (sound effects drawn as part of the art): a small semi-transparent label, with the original lettering still visible. The **SFX** setting switches this to outlined text or hides sound-effect translations.
    - `sign` (signs, screens, labels): a small label.
    - **Safety net:** a pixel check only allows erasing on a plain ground. A region called `bubble` that sits on busy art gets outlined text instead.
    - **Older pages:** pages saved before placement existed use the pixel check alone.
  - **Boxes** shows numbered outlines, coloured by placement (blue bubble, green art, orange SFX, purple sign); hover to read.
  - **Original** hides the translation. Hold **Shift** to peek at the original art.
  - **Width** sets the page size.
  - **Script** shows each page's numbered translations beside it, with the Japanese under each line. The list sticks while its page is on screen and scrolls on its own when long. Hovering a line highlights its region on the page, and the reverse. Narrow windows put the script under the page.
  - **Pin progress** keeps the progress bar visible under the controls while you scroll.
- **Click any region** to see the Japanese (detected and image-checked). Mark it **Good** or **Wrong**, or **Edit** it into a correction. Corrections replace the shown text, and feedback is tied to that translation of the page.
- **Export** downloads JSON: gallery metadata, glossary, and each region's box, OCR, checked source, translation and your rating or correction. No image data.

**Use previous pages (text memory, on by default).**
- **What it sends:** each page's translation request also gets the two nearest earlier translated pages' Japanese and English, about 2,500 characters at most. No images are resent. Earlier pages can come from this run or from a saved translation, and your corrections replace the model's text, so a fix carries forward.
- **How it runs:** detection still runs `Parallel` pages at a time, ahead of translation. Translation then goes strictly in page order. The card shows which pages were used ("context p4, p5"), and so do the region inspector and the export (`context_pages`).
- **Eval-v2 result** (16 books, blind book-level judge): consistency 4.31 / 5 vs 3.94 without context. It was ranked the most consistent version in 9 of 16 books, with 17 vs 29 issues. Per-line accuracy was unchanged (92.5% vs 92.6%), and the cost was about 4.5% more per page.
- **Known failure mode:** it can over-apply a name it has just seen. In one book it turned the joke social-media handle 色々 ("Iroiro") into "Iroha".
- **Turning it off:** clear the checkbox to go back to independent, fully parallel pages.

**Book hints and glossary.** Translation requests from the reader add a short "Book context" to the verify prompt:
- the gallery's Japanese title;
- its series (parody) and character tags, title-cased;
- the series glossary (`Japanese = English` lines).

The glossary is shared by every gallery with the same parody tag, so names stay consistent across books. The prompt says to use the hints only to spell names that appear, never to add them.

On the 10 eval-v2 pages where Flash translators wrote 彩葉 as "Ayaha", a re-run without hints still produced Ayaha on 4 pages (8 regions). With title and tags it produced Ayaha on 0 pages (Iroha in 21 regions), and added no names or surnames to regions without one. That held even for the gallery that has no character tags. With no context, prompts are byte-identical to before, so the eval harness still measures the same requests.

**Reliability**
- In the reader, provider capacity errors (429, Resource exhausted, 503, bridge timeout) are retried 3 times, after 15, 30 and 45 s.
- A dropped connection to the model server is retried once after 2 s. If the server is down, the run stops with a message.
- If the verify output fails validation, it is retried once, from the reader and the context menu alike. In eval-v2 this happened on 2 of 125 pages, and a replay fixed both.
- A Google policy block shows on that page as "Blocked by the provider's content policy", and the run continues. The bridge now reports `promptFeedback.blockReason` and policy finish reasons, instead of "no complete answer".
- The bridge's listen backlog is now 64 instead of 5, so parallel pages are not refused.
- **After updating the extension's files**, press Reload on LM Translate in `chrome://extensions`. Chrome keeps running the old background script until then, while the popup and reader pages already load the new files. The reader checks for this mismatch, shows a message and disables Start. A request the background never acknowledges fails after 20 s instead of hanging on "Preparing image…".

**New preset:** Gemini 4 Argon detect + 3.6 translate. It scored best for its speed in eval-v2: 95.5% vs 83.8% for 3.6 + 3.6, at about 27 s vs 8 s per page. Argon capacity varies by day. When Argon is busy, the reader's retries help, but a Flash preset is faster. A 3.6 + 3.6 run measured about 5–10 s per page, and roughly $0.003 per page at intro list prices, estimated from reported tokens.

Live check (paid, online): `node tests/reader-e2e.cjs --go [--pages 2-5] [--preset vertex36|vertexargonflash]`. It loads the unpacked extension into a throwaway headless Chrome profile through the DevTools protocol, because branded Chrome ignores `--load-extension`. It then runs the gallery link, batch, storage audit and cache reuse, and deletes the profile.

## Deployed local Gemma details

Run `powershell -ExecutionPolicy Bypass -File .\Start-LocalGemma.ps1` to start the local setup. Run the same command with `-Stop` to unload the model and stop the Windows bridge. The lab lives at `\\wsl.localhost\Ubuntu-24.04\home\sqz269\vllm-translation-lab`.

The server now uses the local Gemma MTP assistant with four speculative tokens. The main Gemma model verifies proposed tokens. This reduced the warmed OCR + verification median from 11.72 to 8.44 seconds on three test pages, without reducing either 512-token thinking budget or image resolution. It adds about 0.78 GiB of model allocation; the fixed 3.5 GiB KV cache still supports two 8192-token requests. Initial compilation and new image shapes can take longer. The previous server configuration is backed up as `serve-before-systems.sh` in the lab; no extension reload is needed for this server change.

Reload this unpacked extension after updating its files. Version 0.3.0 enables local Gemma image verification and migrates the endpoint/model/detection prompt on first use, preserving previous sync settings in local storage as `beforeGemmaImageVerification512`. Existing target language and text-translation prompt are retained. Later custom settings remain editable; disable the Gemma vLLM checkbox when using another backend.

The profile uses `gemma-translation` at `http://127.0.0.1:8000/v1/chat/completions`, image-first detection, 1120 image soft tokens, label-first JSON, temperature 0.2 and seed 0. Both image menu options now run detection followed by image verification with the original OCR and boxes. Each stage has a 512-token thinking budget and a 4096-token total output cap. Verification returns source and translation with validated region IDs; reordered IDs are mapped correctly and missing/duplicate IDs or empty translations fail visibly. Hover boxes preserve original OCR and show a revised reading when it differs. Text translation still disables thinking and has a 2048-token output cap. The local verification combination measured about 11.1 seconds on six development pages, not a guarantee for other images. Disable “Verify image translations with local Gemma” to restore the earlier image behavior; legacy image/cache checkboxes apply only when verification is disabled.

The Windows bridge binds only `127.0.0.1:8000`, forwards allowed inference routes through WSL to `127.0.1.1:8000`, and does not expose the service on the LAN. It works around this machine's mirrored-localhost routing issue without firewall changes. vLLM retains max length 8192, two sequences, and a fixed 3.5 GiB KV cache (16651 tokens). The 0.70 utilization value is a startup memory guard; it is not a hard cap on all CUDA allocations.

Files from before this deployment are preserved in the lab's `deployment-backup-20260905-thinking512` directory. The deployment does not include an OpenAI API key.
