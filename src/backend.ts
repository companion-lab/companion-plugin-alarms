// Backend access layer: typed wrappers over ctx.backend.call plus a hook
// replacement for the former host useAlarms().

import { useCallback, useEffect, useState } from "react";
import type { PluginContext } from "../../sdk/js/@companion/plugin";
import type { Alarm } from "./alarms";

type ListReply = { alarms: Alarm[] };

export function makeAlarmsApi(ctx: PluginContext) {
  return {
    list: () => ctx.backend.call<ListReply>("alarms.list").then((r) => r.alarms),
    save: (alarm: Alarm) =>
      ctx.backend
        .call<ListReply>("alarms.save", { alarm })
        .then((r) => r.alarms),
    remove: (id: string) =>
      ctx.backend.call<ListReply>("alarms.delete", { id }).then((r) => r.alarms),
    toggle: (id: string, enabled: boolean) =>
      ctx.backend
        .call<ListReply>("alarms.toggle", { id, enabled })
        .then((r) => r.alarms),
    test: (a: Pick<Alarm, "label" | "message" | "loop_sound">) =>
      ctx.backend.call("alarms.test", {
        label: a.label,
        message: a.message,
        loop_sound: !!a.loop_sound,
      }),
  };
}

export type AlarmsApi = ReturnType<typeof makeAlarmsApi>;

/** Former host useAlarms(), now backed by the plugin backend. */
export function useAlarms(ctx: PluginContext) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The api object is cheap; keep a stable ref so hooks below stay put.
  const api = makeAlarmsApi(ctx);

  const refresh = useCallback(async () => {
    try {
      setAlarms(await api.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    // Backend pushes this whenever the stored list changes (any window).
    return ctx.events.on("alarms-changed", () => void refresh());
  }, [refresh, ctx]);

  const save = useCallback(
    async (a: Alarm) => {
      try {
        setAlarms(await api.save(a));
        return null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return msg;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      setAlarms(await api.remove(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      setAlarms(await api.toggle(id, enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { alarms, error, save, remove, toggle, refresh, api };
}
