# addons.mozilla.org listing

Copy-paste material for the AMO submission form. `metadata.json` holds the same fields for
`web-ext sign --channel listed --amo-metadata amo/metadata.json`.

## Name

X Giffer

## Summary (max 250 characters)

Save GIFs from X (Twitter) as real .gif files. Adds GIF and MP4 download buttons to every GIF on x.com and converts it on your device. No servers, no tracking.

## Description

X stores "GIFs" as silent MP4 videos, so saving one usually gets you a video file. Or nothing at all.

X Giffer (pronounced "jiffer") adds two small buttons to every GIF on x.com:

- **GIF** downloads it as a real animated .gif
- **MP4** saves the original video file

The conversion runs entirely inside Firefox. Nothing is uploaded anywhere, and the extension
collects no data.

**Quality presets** (in the add-on's preferences):

- **Original** (default): full size, every source frame, exact timing
- **Balanced**: up to 720px, 30 fps
- **Small**: up to 480px, 20 fps
- **Tiny**: 320px, 12 fps, 128 colours, for chat apps with upload limits

The converter reads each frame's timing straight from the video, so animations play at their
original speed. It uses one shared colour palette for the whole GIF, so colours don't flicker.

Open source (MIT): https://github.com/nyaadesu/x-giffer

Not affiliated with X Corp.

## Categories

- Firefox: Photos, Music & Videos
- Android: Photos & Media

## Tags

gif, twitter, x, download, video, converter

## Support / homepage

- Homepage: https://github.com/nyaadesu/x-giffer
- Support site: https://github.com/nyaadesu/x-giffer/issues

## License

MIT

## Privacy policy

None needed: the add-on collects and transmits no user data (declared via
`data_collection_permissions: none` in the manifest).

## Source code question

"Do you need to submit source code?" → **No.** All extension code is plain, unminified
JavaScript. The only minified file is a third-party library, included unmodified (see notes
to reviewer).

## Notes to reviewer

```
X Giffer converts the MP4 that x.com uses for "GIFs" into an animated GIF, entirely locally.

How it works:
- content.js finds <video> elements on x.com whose src or poster points at
  video.twimg.com/tweet_video/ (X only uses that path for GIFs) and adds GIF / MP4 buttons.
- On click, background.js fetches https://video.twimg.com/tweet_video/<id>.mp4 (hence the
  video.twimg.com host permission), decodes it frame by frame in a <video> element in the
  background page, and encodes a GIF on a canvas (converter.js, mp4.js).
- The result is saved with downloads.download (hence the "downloads" permission).
- "storage" holds the user's quality preset only.
No remote code, no analytics, no data leaves the browser except the MP4 request to X's CDN.

Third-party library:
- vendor/gifenc.js is gifenc 1.0.3 by Matt DesLauriers (MIT), unmodified:
  https://registry.npmjs.org/gifenc/-/gifenc-1.0.3.tgz  -> package/dist/gifenc.esm.js
  https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js
  sha256 217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093

To test: open any post on x.com containing a GIF (tweets with the "GIF" badge), hover the GIF,
click "GIF". No account is needed for public posts.
```

## Screenshots to take (1280x800 recommended)

1. A post on x.com with a GIF, showing the GIF / MP4 buttons in the corner.
2. The GIF button mid-conversion (shows a percentage).
3. The preferences panel with the quality dropdown (about:addons → X Giffer → Preferences).
