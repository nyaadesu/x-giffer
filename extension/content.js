(() => {
  const MARK = "xgdAttached";
  const SRC_RE = /video\.twimg\.com\/tweet_video\/([\w-]+)\.mp4/;
  const POSTER_RE = /pbs\.twimg\.com\/tweet_video_thumb\/([\w-]+)\./;

  // X only uses /tweet_video/ for GIFs; real videos stream via blob: URLs
  // with amplify_video / ext_tw_video posters, so they never match here.
  function gifMediaId(video) {
    const srcs = [video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map((s) => s.src)];
    for (const s of srcs) {
      const m = s && s.match(SRC_RE);
      if (m) return m[1];
    }
    const m = video.poster && video.poster.match(POSTER_RE);
    return m ? m[1] : null;
  }

  function tweetInfo(video) {
    const article = video.closest("article");
    const link = article?.querySelector('a[href*="/status/"] time')?.closest("a");
    const path = link?.getAttribute("href") || location.pathname;
    const m = path.match(/^\/([^/]+)\/status\/(\d+)/);
    return m ? { user: m[1], id: m[2] } : null;
  }

  function basenameFor(video, mediaId) {
    const info = tweetInfo(video);
    const name = info ? `${info.user}_${info.id}` : `x-gif_${mediaId}`;
    return name.replace(/[^\w.-]/g, "_");
  }

  function swallow(e) {
    // Keep X from opening the media viewer / toggling playback.
    e.stopPropagation();
    if (e.type === "click") e.preventDefault();
  }

  function run(button, video, mediaId, format) {
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "…";

    const reset = (text) => {
      button.textContent = text;
      setTimeout(() => {
        button.textContent = label;
        button.disabled = false;
      }, text === label ? 0 : 2500);
    };

    const port = browser.runtime.connect({ name: "xgd-download" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        button.textContent = msg.stage === "fetch" ? "…" : `${Math.round(msg.value * 100)}%`;
      } else if (msg.type === "done") {
        reset("✓");
        port.disconnect();
      } else if (msg.type === "error") {
        button.title = msg.message;
        reset("✗");
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (button.disabled && button.textContent !== "✓" && button.textContent !== "✗") reset("✗");
    });
    port.postMessage({
      url: `https://video.twimg.com/tweet_video/${mediaId}.mp4`,
      basename: basenameFor(video, mediaId),
      format,
    });
  }

  function makeButton(text, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "xgd-btn";
    b.textContent = text;
    b.title = title;
    for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
      b.addEventListener(ev, swallow);
    }
    b.addEventListener("click", (e) => {
      swallow(e);
      onClick(b);
    });
    return b;
  }

  function attach(video) {
    if (video.dataset[MARK]) return;
    const mediaId = gifMediaId(video);
    if (!mediaId) return;
    video.dataset[MARK] = "1";

    const host = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const bar = document.createElement("div");
    bar.className = "xgd-bar";
    bar.append(
      makeButton("GIF", "Download as GIF", (b) => run(b, video, mediaId, "gif")),
      makeButton("MP4", "Download original MP4", (b) => run(b, video, mediaId, "mp4")),
    );
    host.append(bar);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === "VIDEO") attach(root);
    else root.querySelectorAll?.("video").forEach(attach);
  }

  scan(document.body);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        // A <video> may get its src/poster after it was inserted.
        if (m.target.tagName === "VIDEO") attach(m.target);
      } else {
        m.addedNodes.forEach(scan);
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "poster"],
  });
})();
