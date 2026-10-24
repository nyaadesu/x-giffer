# X Giffer

*pronounced "jiffer"*

Save GIFs from X (Twitter) as real `.gif` files. X stores "GIFs" as silent MP4s
(`video.twimg.com/tweet_video/<id>.mp4`). This project fetches that MP4 and converts it to an
animated GIF on your own device: it steps through the video frame by frame onto a canvas and
encodes the frames with [gifenc](https://github.com/mattdesl/gifenc). No third-party conversion
service is involved.

It has two parts that share `extension/converter.js`:

| Part | What it does |
| --- | --- |
| `extension/` | Firefox extension. Adds **GIF** and **MP4** buttons to every GIF on x.com. |
| `pwa/` | Small web app for Android. Share an X post to it and it gives you back the GIF. |

## Firefox extension

**Try it now (temporary install):** open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on…** and pick `extension/manifest.json`. The add-on stays loaded until you
restart Firefox.

**Permanent install:** release Firefox only installs signed add-ons. You can sign it yourself as
an unlisted add-on (free, automatic, and it isn't published on AMO):

```sh
npx web-ext sign -s extension --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

Get the keys at <https://addons.mozilla.org/developers/addon/api/key/>, then open the `.xpi` it
writes to `web-ext-artifacts/` in Firefox. Alternatively, set `xpinstall.signatures.required` to
`false` in Developer Edition, Nightly or ESR.

Using it: hover a GIF on X and the **GIF** / **MP4** buttons appear in its top-right corner. The
GIF button shows conversion progress, and the file lands in your Downloads folder as
`<user>_<postid>.gif`.

### Quality presets

Pick one in the add-on's **Preferences**, or in the dropdown in the PWA:

| Preset | Size | Frame rate | Colours |
| --- | --- | --- | --- |
| **Original** (default) | source size | every source frame, exact timing | 256 |
| Balanced | up to 720 px wide | up to 30 fps | 256 |
| Small | up to 480 px wide | up to 20 fps | 256 |
| Tiny | up to 320 px wide | up to 12 fps | 128 |

The converter reads the frame timestamps from the MP4, so it keeps the source's own frames and
durations instead of resampling. It also merges identical consecutive frames. GIFs can't play
faster than 50 fps, so higher frame rates are thinned to fit.

Colours come from a single palette built from samples of every frame, so gradients don't band
differently from frame to frame. Pixels that haven't changed are left transparent so the previous
frame shows through, and so are pixels that differ only by compression noise. Static areas stay
steady, and files come out about 30% smaller.

## Android share shortcut (PWA)

The PWA has to be served over HTTPS. The included workflow (`.github/workflows/pages.yml`)
deploys it to GitHub Pages:

1. Push this repo to GitHub and set **Settings → Pages → Source** to **GitHub Actions**.
2. On your phone, open `https://<you>.github.io/<repo>/` in **Chrome** and choose
   **⋮ → Add to Home screen → Install**.
3. In the X app, open a post with a GIF and tap **Share → X Giffer**. The app opens, converts the
   GIF, and offers **Share GIF** (to send it straight to another app) or **Save GIF**.

You can also paste a post link into the app directly.

Notes:

- Android only offers *installed* PWAs in the share sheet, and Firefox for Android doesn't
  support Web Share Targets. You need Chrome, or a Chromium-based browser such as Edge, Brave
  or Samsung Internet, to install the PWA. Once installed, the shortcut works from any app.
- The app looks up the post with the public [FxTwitter API](https://github.com/FxEmbed/FxEmbed)
  (`api.fxtwitter.com`), because X's own API needs authentication. The MP4 is then downloaded
  directly from X's CDN.

## How it works / gotchas

- `video.twimg.com` returns **403 for any `Referer` that isn't X's**, so every MP4 fetch uses
  `referrerPolicy: "no-referrer"`.
- In the extension, the conversion runs in the background page (Firefox background pages have
  a DOM), so it isn't affected by x.com's CSP and doesn't slow down the tab.
- Real X *videos* are streamed through MSE (`blob:` URLs) and don't use `/tweet_video/`, so
  the buttons only appear on GIFs.
