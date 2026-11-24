// Runs in the page before any app code (page.addInitScript). It watches the microphone
// and the audio elements so tests can check the CLAUDE.md rule: no briefing or answer
// audio plays while the mic is open; only the start/end listening cues may. It changes no
// app behavior; it only records (and, when a test asks, presses buttons like a listener).

export type Probe = {
  micLive: number;
  micOpens: number;
  micCloses: number;
  /** Times the briefing audio was playing while a mic track was live. */
  violations: string[];
  /** Cue playbacks: which cue element, its blob URL, whether muted (the silent iPhone
   *  unlock during Start), and the mic state at that moment. */
  cuePlays: { id: string; src: string; muted: boolean; micLive: number; at: number }[];
  /** Media Session handlers the page registered (lock screen / headphone buttons). */
  handlers: Record<string, (() => void) | null>;
  /** Times any other audible sound (not the briefing, not the start/end cue elements)
   *  was playing while a mic track was live: cue Previews, the recording player, etc. */
  otherAudio: string[];
  /** When true, the probe tries to start the briefing right after the mic opens. */
  attackOnMicOpen: boolean;
  /** When true, the probe also tries every other sound on the page right after the mic
   *  opens: each cue Preview button and any player with controls. */
  attackOthersOnMicOpen: boolean;
  attacks: string[];
  /** Plays every other sound on the page, as a listener could; see attackOthersOnMicOpen. */
  attackOthers: () => void;
};

declare global {
  interface Window {
    __probe: Probe;
  }
}

export function installProbe() {
  const probe: Probe = {
    micLive: 0,
    micOpens: 0,
    micCloses: 0,
    violations: [],
    cuePlays: [],
    handlers: {},
    otherAudio: [],
    attackOnMicOpen: false,
    attackOthersOnMicOpen: false,
    attacks: [],
    attackOthers: () => undefined,
  };
  window.__probe = probe;
  const live = new Set<MediaStreamTrack>();

  const briefing = () =>
    document.querySelector<HTMLAudioElement>('[data-testid="briefing-audio"]');

  // Every media element the page has ever played, including ones never added to the
  // document (`new Audio(...)`), so detached players are watched too.
  const played = new Set<HTMLMediaElement>();
  const describe = (element: HTMLMediaElement) =>
    element.dataset?.testid ??
    (!element.isConnected ? "detached new Audio()" : element.controls ? "player with controls" : "audio element");
  const allowedWithMic = (element: HTMLMediaElement) => {
    const id = element.dataset?.testid;
    return id === "cue-start" || id === "cue-end" || id === "briefing-audio";
  };

  const check = (when: string) => {
    if (live.size === 0) return;
    const audio = briefing();
    if (audio && !audio.paused) {
      probe.violations.push(`${when}: briefing playing at ${audio.currentTime.toFixed(2)}s with mic open`);
    }
    // The briefing has its own list above; the two cue elements are the allowed exception.
    for (const element of played) {
      if (!element.paused && !element.muted && !allowedWithMic(element)) {
        probe.otherAudio.push(`${when}: ${describe(element)} playing with mic open`);
      }
    }
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!played.has(this)) {
      played.add(this);
      this.addEventListener("playing", () => check("playing event"));
    }
    return play.call(this);
  };

  const closeTrack = (track: MediaStreamTrack) => {
    if (!live.delete(track)) return;
    probe.micLive = live.size;
    probe.micCloses += 1;
  };

  // Simulates a user tapping Play and a lock-screen "play" while the mic is open.
  const attack = () => {
    const button = Array.from(document.querySelectorAll("button")).find((item) =>
      /^(Play|Start)$/.test(item.textContent?.trim() ?? ""),
    );
    if (button && !button.disabled) {
      probe.attacks.push("tapped on-screen Play");
      button.click();
    }
    const play = probe.handlers.play;
    if (play) {
      probe.attacks.push("Media Session play");
      play();
    }
  };

  // Simulates a listener pressing every other sound control while the mic is open.
  const attackOthers = () => {
    for (const button of Array.from(document.querySelectorAll("button"))) {
      if (button.textContent?.trim() !== "Preview") continue;
      if (button.disabled) {
        probe.attacks.push("Preview disabled");
      } else {
        probe.attacks.push("tapped Preview");
        button.click();
      }
    }
    for (const player of Array.from(document.querySelectorAll<HTMLAudioElement>("audio[controls]"))) {
      probe.attacks.push("played a player with controls");
      void player.play().catch(() => undefined);
    }
  };
  probe.attackOthers = attackOthers;

  const devices = navigator.mediaDevices;
  const getUserMedia = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await getUserMedia(constraints);
    for (const track of stream.getAudioTracks()) {
      live.add(track);
      const stop = track.stop.bind(track);
      track.stop = () => {
        closeTrack(track);
        stop();
      };
      track.addEventListener("ended", () => closeTrack(track));
    }
    probe.micLive = live.size;
    probe.micOpens += 1;
    check("mic open");
    if (probe.attackOnMicOpen) window.setTimeout(attack, 0);
    if (probe.attackOthersOnMicOpen) window.setTimeout(attackOthers, 0);
    return stream;
  };

  if ("mediaSession" in navigator) {
    const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      probe.handlers[action] = handler ? () => handler({ action } as MediaSessionActionDetails) : null;
      setActionHandler(action, handler);
    };
  }

  // Media events do not bubble, but a capturing listener on the document sees them.
  document.addEventListener(
    "play",
    (event) => {
      const element = event.target as HTMLAudioElement;
      const id = element.dataset?.testid;
      if (id === "cue-start" || id === "cue-end") {
        probe.cuePlays.push({
          id,
          src: element.src,
          muted: element.muted,
          micLive: live.size,
          at: performance.now(),
        });
      }
      if (id === "briefing-audio") check("play event");
    },
    true,
  );
  document.addEventListener(
    "playing",
    (event) => {
      if ((event.target as HTMLElement).dataset?.testid === "briefing-audio") check("playing event");
    },
    true,
  );
  window.setInterval(() => check("poll"), 20);
}
