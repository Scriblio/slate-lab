// Encore's YouTube player page (https://sing.scriblio.co/yt-frame).
//
// The Encore app embeds this page, and this page embeds YouTube's player, so
// YouTube sees Encore's website as the embedder instead of a laptop's local
// address. It only relays commands and events between Encore and YouTube's
// IFrame Player API; it never changes the player or what YouTube shows.
(() => {
  const send = (msg) => parent.postMessage({ encoreYt: 1, ...msg }, '*');
  let player = null;
  let ready = false;
  let opts = null;

  function loadApi() {
    return new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function load(o) {
    if (opts) return; // one video per page
    if (!/^[\w-]{11}$/.test(String(o.videoId))) return send({ type: 'error', code: 2 });
    opts = { volume: 100, ...o };
    loadApi().then(
      (YT) => {
        player = new YT.Player('player', {
          videoId: opts.videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: opts.controls ? 1 : 0,
            disablekb: opts.controls ? 0 : 1,
            fs: 0,
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            start: Math.floor(Number(opts.start) || 0),
            origin: location.origin,
          },
          events: {
            onReady: () => {
              ready = true;
              player.setVolume(Number(opts.volume));
              if (opts.muted) player.mute();
              send({ type: 'ready' });
              if (opts.autoplay) player.playVideo();
              setInterval(() => {
                const d = player.getDuration();
                send({ type: 'progress', time: player.getCurrentTime(), duration: d > 0 ? d : undefined });
              }, 1000);
            },
            onStateChange: (e) => send({ type: 'state', state: e.data }),
            onError: (e) => send({ type: 'error', code: e.data }),
          },
        });
      },
      () => send({ type: 'error', code: -1 }),
    );
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.encoreYt !== 1) return;
    if (d.type === 'load') return load(d);
    if (!opts) return;
    // Before YouTube's player is ready, remember what was asked for.
    if (d.type === 'play') ready ? player.playVideo() : (opts.autoplay = true);
    else if (d.type === 'pause') ready ? player.pauseVideo() : (opts.autoplay = false);
    else if (d.type === 'seek') ready ? player.seekTo(Number(d.to) || 0, true) : (opts.start = Number(d.to) || 0);
    else if (d.type === 'volume') {
      opts.volume = Number(d.value);
      opts.muted = Boolean(d.muted);
      if (!ready) return;
      player.setVolume(opts.volume);
      opts.muted ? player.mute() : player.unMute();
    }
  });

  send({ type: 'up' });
})();
