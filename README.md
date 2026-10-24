# X Giffer

*pronounced "jiffer"*

**[Get X Giffer for Firefox](https://addons.mozilla.org/en-US/firefox/addon/x-giffer/)** (desktop and
Android) · **[Open the Android share app](https://nyaadesu.github.io/x-giffer/)**

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

**Install:** get it from Firefox Add-ons at
<https://addons.mozilla.org/en-US/firefox/addon/x-giffer/>. It works in Firefox on desktop and
in Firefox for Android (version 142 or newer).

**From source (temporary install):** open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on…** and pick `extension/manifest.json`. The add-on stays loaded until you
restart Firefox.

**Your own signed build:** release Firefox only installs signed add-ons. If you've modified it,
you can sign your own copy as an unlisted add-on (free, automatic, and not published). First
change `browser_specific_settings.gecko.id` in `extension/manifest.json` to an ID of your own,
because the published add-on's ID is taken:

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

It's hosted at **<https://nyaadesu.github.io/x-giffer/>**, deployed from `main` by
`.github/workflows/pages.yml`. A fork can host its own copy by setting **Settings → Pages →
Source** to **GitHub Actions**.

1. On your phone, open <https://nyaadesu.github.io/x-giffer/> in **Chrome** and choose
   **⋮ → Add to Home screen → Install**.
2. In the X app, open a post with a GIF and tap **Share → X Giffer**. The app opens, converts the
   GIF with your chosen quality preset, and saves it to Downloads. **Share GIF** (to send it
   straight to another app) and **Save GIF** are there too.

You can also paste a post link into the app directly. Pasted links are never saved automatically.

Settings in the app (remembered on the device):

- **Quality** is used for every conversion, including shared posts.
- **Save automatically when shared** is on by default. Turn it off to pick Share or Save yourself.
- **Then close the app** closes the window once the GIF is saved, so a share drops you back in
  the X app. The app still has to open while it converts: Android always opens a share target's
  window, and a web app can't convert or save files in the background.

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

## License

MIT, see [LICENSE](LICENSE). Bundles [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 (MIT), unmodified.

Not affiliated with X Corp.
