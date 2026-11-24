"use client";

// The delivery time and timezone form. The save action arrives as a prop from page.tsx
// (this file imports no server module). Two native <select>s (VoiceOver reads them as
// pop-up buttons) and one watermelon Save button. When the user has never saved, the
// zone starts at the one the browser reports. Results and errors are announced through a
// polite live region.

import { useId, useState, useSyncExternalStore, useTransition } from "react";
import {
  DELIVERY_ERROR_MESSAGES,
  DELIVERY_TIMES,
  currentZoneName,
  isKnownTimezone,
  timeLabel,
  timezoneLabel,
  type DeliverySettings,
  type SaveOutcome,
} from "../../lib/schedule/delivery";

type Message = { kind: "error" | "done"; text: string };

const noSubscribe = () => () => {};
function browserZone(): string | null {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isKnownTimezone(tz) ? currentZoneName(tz) : null;
}

export function DeliveryForm({
  initial,
  initialNext,
  timezones,
  save,
}: {
  initial: DeliverySettings & { saved: boolean };
  initialNext: string | null;
  timezones: string[];
  save(input: DeliverySettings): Promise<SaveOutcome>;
}) {
  const timeId = useId();
  const zoneId = useId();
  const [saved, setSaved] = useState<(DeliverySettings & { saved: boolean })>(initial);
  const [next, setNext] = useState<string | null>(initialNext);
  const [deliveryTime, setDeliveryTime] = useState(initial.deliveryTime);
  // Never saved: start from the browser's own zone (null while rendering on the server).
  const detected = useSyncExternalStore(noSubscribe, browserZone, () => null);
  const [chosenZone, setTimezone] = useState<string | null>(initial.saved ? initial.timezone : null);
  const timezone = chosenZone ?? detected ?? initial.timezone;
  const zones = timezones.includes(timezone) ? timezones : [...timezones, timezone];
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  const times = DELIVERY_TIMES.includes(deliveryTime) ? DELIVERY_TIMES : [deliveryTime, ...DELIVERY_TIMES];
  const changed = !saved.saved || deliveryTime !== saved.deliveryTime || timezone !== saved.timezone;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      let out: SaveOutcome;
      try {
        out = await save({ deliveryTime, timezone });
      } catch {
        out = { ok: false, error: "save_failed" };
      }
      if ("error" in out) {
        setMessage({ kind: "error", text: DELIVERY_ERROR_MESSAGES[out.error] });
        return;
      }
      setSaved({ ...out.value, saved: true });
      setTimezone(out.value.timezone);
      setNext(out.next);
      setMessage({ kind: "done", text: out.next ? `Saved. Your next briefing: ${out.next}.` : "Saved." });
    });
  }

  return (
    <>
      <section className="px-card-green" aria-labelledby="next-heading">
        <span id="next-heading" className="px-label">
          Schedule
        </span>
        <p className="px-h2" data-testid="next-briefing">
          {next ? `Your next briefing: ${next}` : "Your next briefing: not available right now"}
        </p>
        <p className="px-body" data-testid="saved-zone">
          {saved.saved
            ? `${timeLabel(saved.deliveryTime)} every day, ${timezoneLabel(saved.timezone)} time.`
            : `Not set yet. Until you save, briefings are ready at ${timeLabel(saved.deliveryTime)} UTC.`}
        </p>
      </section>

      <form className="px-card" onSubmit={onSubmit} aria-label="Briefing schedule" data-testid="delivery-form">
        <div className="px-field">
          <label htmlFor={timeId} className="px-label">
            Delivery time
          </label>
          <select id={timeId} className="px-input" value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)}>
            {times.map((t) => (
              <option key={t} value={t}>
                {timeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="px-field">
          <label htmlFor={zoneId} className="px-label">
            Time zone
          </label>
          <select id={zoneId} className="px-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {timezoneLabel(z)}
              </option>
            ))}
          </select>
        </div>
        <div className="px-row">
          <button type="submit" className="px-btn px-btn-primary" disabled={pending || !changed} data-testid="save">
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
        <div aria-live="polite" role="status">
          {message ? (
            <p className={message.kind === "error" ? "px-alert" : "px-alert px-done"} data-testid={message.kind === "error" ? "settings-error" : "settings-done"}>
              {message.text}
            </p>
          ) : null}
        </div>
      </form>
    </>
  );
}
