// Runs in the page before any app code (page.addInitScript). It watches the microphone
// and the audio elements so tests can check the CLAUDE.md rule: no briefing audio plays
// while the mic is open. It changes no app behavior; it only records.

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
  /** When true, the probe tries to start the briefing right after the mic opens. */
  attackOnMicOpen: boolean;
  attacks: string[];
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
    attackOnMicOpen: false,
    attacks: [],
  };
  window.__probe = probe;
  const live = new Set<MediaStreamTrack>();

  const briefing = () =>
    document.querySelector<HTMLAudioElement>('[data-testid="briefing-audio"]');

  const check = (when: string) => {
    const audio = briefing();
    if (live.size > 0 && audio && !audio.paused) {
      probe.violations.push(`${when}: briefing playing at ${audio.currentTime.toFixed(2)}s with mic open`);
    }
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
