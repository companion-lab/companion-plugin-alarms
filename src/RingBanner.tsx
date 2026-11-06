// Ringing banner for the main (avatar) window. Owns the whole presentation
// flow that used to live in App.tsx: listen for `alarm-fired` from this
// plugin's backend scheduler, announce via the TTS service, drive the avatar
// (surprised + nod), and show a stop/snooze banner.
//
// Graceful degradation: with the voice plugin absent, ctx.services.tts()
// resolves to a silent provider — alarms still ring visually.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { injectBannerStyles } from "./banner-styles";

const SNOOZE_MS = 5 * 60_000;

type RingingAlarm = { id: string; label: string; message: string; loop: boolean; startedAt: number };

type FiredPayload = {
  id: string;
  label: string;
  message: string;
  loop_sound: boolean;
};

export function RingBanner({ ctx }: { ctx: PluginContext }) {
  injectBannerStyles();
  const [alarm, setAlarm] = useState<RingingAlarm | null>(null);
  const alarmRef = useRef<RingingAlarm | null>(null);
  alarmRef.current = alarm;
  const snoozeTimerRef = useRef<number | null>(null);

  const fire = useCallback(
    (a: RingingAlarm) => {
      const tts = ctx.services.tts();
      const stt = ctx.services.stt();
      tts.stop(); // cut any in-flight announcement first
      if (snoozeTimerRef.current !== null) {
        window.clearTimeout(snoozeTimerRef.current);
        snoozeTimerRef.current = null;
      }
      ctx.avatar.triggerMotion("nod");
      ctx.avatar.setEmotion("surprised");
      void stt?.setSuppress(true);
      // Tag each pass so a loop iteration can't clear a newer alarm's banner.
      const ringing: RingingAlarm = { ...a, startedAt: Date.now() };
      alarmRef.current = ringing;
      setAlarm(ringing);
      const onEnd = () => {
        if (alarmRef.current?.startedAt === ringing.startedAt) {
          alarmRef.current = null;
          setAlarm(null);
        }
        window.setTimeout(() => void stt?.setSuppress(false), 700);
      };
      const onViseme = (name: string, weight?: number) => ctx.avatar.setViseme(name, weight);
      const text = [a.label, a.message].filter(Boolean).join(". ") || "Your alarm is going off.";
      if (ringing.loop) {
        void tts.speakLoop(text, {}, onViseme, onEnd);
      } else {
        void tts.speak(text, {}, onViseme, onEnd);
      }
    },
    [ctx],
  );

  useEffect(() => {
    return ctx.events.on("alarm-fired", (payload) => {
      const f = payload as Partial<FiredPayload> | null;
      if (!f || typeof f !== "object") return;
      fire({
        id: String(f.id ?? ""),
        label: String(f.label ?? ""),
        message: String(f.message ?? ""),
        loop: !!f.loop_sound,
        startedAt: 0,
      });
    });
  }, [ctx, fire]);

  // Halt announcement and clear state.
  const stopAlarmSpeech = useCallback(() => {
    if (snoozeTimerRef.current !== null) {
      window.clearTimeout(snoozeTimerRef.current);
      snoozeTimerRef.current = null;
    }
    alarmRef.current = null;
    setAlarm(null);
    ctx.services.tts().stop();
    void ctx.services.stt()?.setSuppress(false);
    ctx.avatar.setEmotion("neutral");
  }, [ctx]);

  // Silence now, repeat in 5 minutes. Keeps the original loop flag so a
  // looping alarm resumes looping.
  const snoozeAlarm = useCallback(() => {
    const current = alarmRef.current;
    stopAlarmSpeech();
    if (!current) return;
    snoozeTimerRef.current = window.setTimeout(() => {
      snoozeTimerRef.current = null;
      fire({ ...current, startedAt: 0 });
    }, SNOOZE_MS);
  }, [ctx, fire, stopAlarmSpeech]);

  if (!alarm) return null;
  const name = alarm.label.trim() || "Alarm ringing";
  return (
    <div className="alarm-banner" role="alert">
      <span className="alarm-banner-icon" aria-hidden="true">
        ⏰
      </span>
      <span className="alarm-banner-text">
        <span className="alarm-banner-title">{name}</span>
        <span className="alarm-banner-sub">
          {alarm.loop ? "Ringing — stop or snooze" : "Snooze 5 min or stop"}
        </span>
      </span>
      <span className="alarm-banner-actions">
        <button
          type="button"
          className="alarm-banner-btn alarm-banner-btn-snooze"
          onClick={snoozeAlarm}
          aria-label={`Snooze ${name} for 5 minutes`}
        >
          Snooze 5m
        </button>
        <button
          type="button"
          className="alarm-banner-btn alarm-banner-btn-stop"
          onClick={stopAlarmSpeech}
          aria-label={`Stop ${name}`}
        >
          Stop
        </button>
      </span>
    </div>
  );
}
