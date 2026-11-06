// Alarms feature plugin: settings tab, ringing banner widget, and alarm
// tools (registered on the Rust backend side via `tools()`).

import { definePlugin, type PluginContext } from "@companion-lab/plugin";
import { AlarmsSection } from "./AlarmsSection";
import { RingBanner } from "./RingBanner";

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating alarms plugin");

  // Settings: same tab and section ids the core used, so overrides and user
  // habits carry over unchanged.
  ctx.settings.registerTab({
    id: "alarms",
    label: "Alarms",
    group: "Companion",
    order: 20,
    desc: "Timed reminders with daily or weekly repeat.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 1.5" /><path d="M5 3 2 6" /><path d="m19 3 3 3" /></svg>
    ),
  });
  ctx.settings.registerSection({
    id: "alarms.alarms",
    tabId: "alarms",
    slot: "top",
    order: 100,
    component: function AlarmsSectionViaCtx() {
      return <AlarmsSection ctx={ctx} />;
    },
  });

  // Main window: the ringing banner (announces via ctx.services.tts(),
  // drives the avatar via ctx.avatar).
  ctx.main.registerWidget({
    slot: "main.bottom",
    component: function AlarmsRingBanner() {
      return <RingBanner ctx={ctx} />;
    },
  });
});
