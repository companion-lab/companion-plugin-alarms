// Alarms settings section (ported from the host's organisms/AlarmsSection.tsx;
// UI kit comes from the host via ctx.ui and storage from the plugin backend).

import { useEffect, useId, useRef, useState } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { useAlarms, type AlarmsApi } from "./backend";
import {
  WEEKDAYS,
  emptyAlarm,
  weekdaySet,
  toggleWeekday,
  timeLabel,
  fireLabel,
  type Alarm,
} from "./alarms";

type Ampm = "AM" | "PM";

function to12h(hour24: number): { h12: number; ampm: Ampm } {
  return { h12: hour24 % 12 === 0 ? 12 : hour24 % 12, ampm: hour24 < 12 ? "AM" : "PM" };
}

function to24h(h12: number, ampm: Ampm): number {
  return (Math.min(12, Math.max(1, h12)) % 12) + (ampm === "PM" ? 12 : 0);
}

function format12h(hour: number, minute: number): string {
  const { h12, ampm } = to12h(hour);
  return `${String(h12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function parseTime(raw: string): { hour: number; minute: number } | null {
  let s = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  let ampm: Ampm | null = null;
  const ap = s.match(/\s*([ap])(m?)\s*$/);
  if (ap) {
    ampm = ap[1] === "a" ? "AM" : "PM";
    s = s.slice(0, ap.index).trim();
  }
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    return { hour: to24h(h, ampm), minute: min };
  }
  if (h > 23) return null;
  return { hour: h, minute: min };
}

function TimePicker({ ui, hour, minute, onChange, onClear, placeholder }: {
  ui: PluginContext["ui"];
  hour?: number | null;
  minute?: number | null;
  onChange: (hour: number, minute: number) => void;
  onClear?: () => void;
  placeholder?: string;
}) {
  const hasValue = hour != null && minute != null;
  const safeHour = hour ?? 12;
  const safeMinute = minute ?? 0;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => (hasValue ? format12h(safeHour, safeMinute) : ""));
  const [hourText, setHourText] = useState(() => String(to12h(safeHour).h12));
  const [minuteText, setMinuteText] = useState(() => String(safeMinute).padStart(2, "0"));
  const [bad, setBad] = useState(false);
  const [hourFocused, setHourFocused] = useState(false);
  const [minuteFocused, setMinuteFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const hourListId = `tp-hour-${uid}`;
  const minuteListId = `tp-minute-${uid}`;
  const { h12, ampm } = to12h(safeHour);

  useEffect(() => {
    if (hour != null && minute != null) {
      setText(format12h(hour, minute));
      setBad(false);
      if (!hourFocused) setHourText(String(to12h(hour).h12));
      if (!minuteFocused) setMinuteText(String(minute).padStart(2, "0"));
    } else {
      setText("");
      setBad(false);
    }
  }, [hour, minute, hourFocused, minuteFocused]);

  useEffect(() => {
    if (!open) return;
    setHourText(String(to12h(hour ?? 12).h12));
    setMinuteText(String(minute ?? 0).padStart(2, "0"));
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, hour, minute]);

  const commit = () => {
    if (!text.trim()) {
      if (onClear) {
        setBad(false);
        onClear();
        return;
      }
    }
    const p = parseTime(text);
    if (p) {
      setBad(false);
      if (p.hour !== hour || p.minute !== minute) onChange(p.hour, p.minute);
      else setText(format12h(p.hour, p.minute));
    } else {
      setBad(true);
      setText(hasValue ? format12h(safeHour, safeMinute) : "");
    }
  };

  const onHourBox = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    if (!digits) {
      setHourText("");
      return;
    }
    const h = Math.min(12, Number(digits));
    setHourText(String(h));
    if (h >= 1) onChange(to24h(h, ampm), safeMinute);
  };

  const onMinuteBox = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    setMinuteText(digits);
    if (!digits) return;
    const m = Math.min(59, Number(digits));
    if (m !== safeMinute) onChange(safeHour, m);
  };

  const commitHourBox = () => {
    const h = Number(hourText);
    setHourText(!hourText || !Number.isInteger(h) || h < 1 ? String(h12) : String(Math.min(12, h)));
  };

  const commitMinuteBox = () => {
    const m = Number(minuteText);
    setMinuteText(minuteText === "" || !Number.isInteger(m) || m < 0 ? String(safeMinute).padStart(2, "0") : String(Math.min(59, m)).padStart(2, "0"));
  };

  const useNow = () => {
    const n = new Date();
    onChange(n.getHours(), n.getMinutes());
  };

  const handleClear = () => {
    if (onClear) {
      onClear();
      setOpen(false);
    } else {
      onChange(0, 0);
    }
  };

  const { TextInput } = ui;
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <TextInput
          aria-label="Time"
          placeholder={placeholder ?? "HH:MM"}
          value={text}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ width: "100%", paddingRight: 34, ...(bad ? { borderColor: "var(--danger)" } : null) }}
        />
        <button
          type="button"
          aria-label="Pick time"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            opacity: 0.55,
            padding: 6,
            color: "inherit",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </button>
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: 4,
            padding: "16px 16px 10px",
            background: "var(--bg-input)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--text-secondary)" }}>Enter time</div>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <TextInput
              aria-label="Hour"
              inputMode="numeric"
              list={hourListId}
              value={hourText}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onHourBox(e.target.value)}
              onBlur={() => {
                setHourFocused(false);
                commitHourBox();
              }}
              onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                setHourFocused(true);
                e.target.select();
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 40, textAlign: "center", padding: "10px 0", background: "rgba(127,127,127,0.15)", borderColor: "transparent" }}
            />
            <datalist id={hourListId}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <div aria-hidden="true" style={{ alignSelf: "center", fontSize: 30, fontWeight: 700, opacity: 0.7 }}>:</div>
            <TextInput
              aria-label="Minute"
              inputMode="numeric"
              list={minuteListId}
              value={minuteText}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onMinuteBox(e.target.value)}
              onBlur={() => {
                setMinuteFocused(false);
                commitMinuteBox();
              }}
              onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                setMinuteFocused(true);
                e.target.select();
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 40, textAlign: "center", padding: "10px 0", background: "rgba(127,127,127,0.15)", borderColor: "transparent" }}
            />
            <datalist id={minuteListId}>
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={String(m).padStart(2, "0")} />
              ))}
            </datalist>
            <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border-subtle)", borderRadius: 8, overflow: "hidden", width: 64, flexShrink: 0 }}>
              {(["AM", "PM"] as const).map((a, i) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => onChange(to24h(h12, a), safeMinute)}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    fontSize: 13,
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background: a === ampm ? "var(--accent-subtle)" : "transparent",
                    color: a === ampm ? "var(--accent-hover)" : "var(--text-muted)",
                    ...(i === 0 ? { borderBottom: "1px solid var(--border-subtle)" } : null),
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-subtle)", marginTop: 12, paddingTop: 8 }}>
            <button
              type="button"
              onClick={useNow}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent-hover)", fontSize: 13, fontWeight: 600, padding: "4px 8px" }}
            >
              Now
            </button>
            <button
              type="button"
              onClick={handleClear}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent-hover)", fontSize: 13, fontWeight: 600, padding: "4px 8px" }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AlarmEditor({ ui, api, initial, onSave, onClose }: {
  ui: PluginContext["ui"];
  api: AlarmsApi;
  initial: Alarm;
  onSave: (a: Alarm) => Promise<string | null>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Alarm>({ ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { FormField, Button, TextInput } = ui;

  const commit = async () => {
    setSaving(true);
    const err = await onSave(draft);
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="item-row" style={{ display: "block", borderStyle: "dashed" }}>
      <FormField label="Time" hint='Type it ("7:30 pm", "07:30") or use the clock. 12h or 24h.'>
        <TimePicker
          ui={ui}
          hour={draft.hour}
          minute={draft.minute}
          onChange={(hour, minute) => setDraft({ ...draft, hour, minute })}
        />
      </FormField>
      <div className="st-field">
        <span className="st-field-label">Repeat</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {WEEKDAYS.map((name, d) => (
            <button
              key={name}
              type="button"
              className={weekdaySet(draft.weekdays, d) ? "chip chip-active" : "chip"}
              style={{ padding: "4px 8px" }}
              onClick={() => setDraft({ ...draft, weekdays: toggleWeekday(draft.weekdays, d) })}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="st-field-hint">No days = one-time alarm</span>
      </div>
      <FormField label="Label">
        <TextInput
          value={draft.label}
          maxLength={60}
          placeholder="e.g. Morning standup"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, label: e.target.value })}
        />
      </FormField>
      <FormField
        label="Sound"
        hint="Loop repeats the message until you stop or snooze it."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            variant={!draft.loop_sound ? "primary" : "secondary"}
            onClick={() => setDraft({ ...draft, loop_sound: false })}
            style={{ padding: "5px 12px", fontSize: 11 }}
          >
            Once
          </Button>
          <Button
            variant={draft.loop_sound ? "primary" : "secondary"}
            onClick={() => setDraft({ ...draft, loop_sound: true })}
            style={{ padding: "5px 12px", fontSize: 11 }}
          >
            Loop
          </Button>
        </div>
      </FormField>
      <FormField
        label="Spoken message"
        hint="Said out loud when the alarm fires. Empty = label only."
      >
        <TextInput
          value={draft.message}
          maxLength={280}
          placeholder="e.g. Time to get up, standup in ten minutes"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, message: e.target.value })}
        />
      </FormField>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <Button variant="primary" onClick={commit} disabled={saving} style={{ flex: 1 }}>
          {saving ? "Saving..." : "Save alarm"}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AlarmRow({ ui, api, a, onEdit, onDelete, onToggle }: {
  ui: PluginContext["ui"];
  api: AlarmsApi;
  a: Alarm;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const { Button } = ui;
  const test = async () => {
    try {
      await api.test(a);
    } catch (e) {
      console.error("alarm test failed", e);
    }
  };

  return (
    <div className={`item-row${a.enabled ? "" : " item-row-dim"}`} style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label title="Enable alarm" style={{ display: "flex", alignItems: "center", cursor: "pointer", flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={a.enabled}
            onChange={(e) => onToggle(a.id, e.target.checked)}
          />
        </label>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="item-title">
            {a.fire_at
              ? `⏱ ${new Date(a.fire_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : timeLabel(a.hour, a.minute)}
            {a.label ? ` • ${a.label}` : ""}
          </div>
          <div className="item-meta">{fireLabel(a)}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button variant="primary" onClick={test} style={{ padding: "5px 10px", fontSize: 11 }}>
            Test
          </Button>
          <Button variant="secondary" onClick={onEdit} style={{ padding: "5px 10px", fontSize: 11 }}>
            Edit
          </Button>
          <Button variant="danger" onClick={onDelete} style={{ padding: "5px 10px", fontSize: 11 }}>
            Delete
          </Button>
        </div>
      </div>
      {!a.enabled && <div className="item-meta">paused</div>}
      {a.weekdays === 0 && a.enabled && (
        <div className="item-meta">fires once, then turns off</div>
      )}
      {a.message && <div className="item-meta">says: {a.message}</div>}
      {a.loop_sound && <div className="item-meta">loops until stopped or snoozed</div>}
      {a.fire_at != null && a.enabled && (
        <div className="item-meta">relative timer, fires once then turns off</div>
      )}
    </div>
  );
}

export function AlarmsSection({ ctx }: { ctx: PluginContext }) {
  const { ui } = ctx;
  const { alarms, error, save, remove, toggle, api } = useAlarms(ctx);
  const [editing, setEditing] = useState<Alarm | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Alarm | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { SectionCard, Button, ConfirmModal } = ui;

  const enabled = alarms.filter((a) => a.enabled).length;
  const sorted = [...alarms].sort(
    (x, y) => x.hour - y.hour || x.minute - y.minute || x.label.localeCompare(y.label),
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    await remove(pendingDelete.id);
    setPendingDelete(null);
    setDeleting(false);
  };

  return (
    <SectionCard
      title="Alarms"
      badge={alarms.length ? `${enabled}/${alarms.length} on` : undefined}
    >
      <div style={{ marginBottom: 10 }}>
        {sorted.map((a) =>
          editing && editing !== "new" && editing.id === a.id ? (
            <AlarmEditor key={a.id} ui={ui} api={api} initial={a} onSave={save} onClose={() => setEditing(null)} />
          ) : (
            <AlarmRow
              key={a.id}
              ui={ui}
              api={api}
              a={a}
              onEdit={() => setEditing(a)}
              onDelete={() => setPendingDelete(a)}
              onToggle={toggle}
            />
          ),
        )}
        {!sorted.length && !editing && (
          <div className="item-meta" style={{ marginBottom: 8 }}>
            No alarms yet. Add one below — pick weekdays to repeat, or leave all off for a one-time alarm.
          </div>
        )}
      </div>

      {editing === "new" ? (
        <AlarmEditor ui={ui} api={api} initial={emptyAlarm()} onSave={save} onClose={() => setEditing(null)} />
      ) : (
        <Button
          variant="primary"
          onClick={() => setEditing("new")}
          disabled={editing !== null}
          style={{ width: "100%" }}
        >
          + Add alarm
        </Button>
      )}

      {error && <div className="error-banner">{error}</div>}

      {pendingDelete && (
        <ConfirmModal
          title="Delete alarm?"
          message={`Delete "${timeLabel(pendingDelete.hour, pendingDelete.minute)}${pendingDelete.label ? ` • ${pendingDelete.label}` : ""}"? This cannot be undone.`}
          busy={deleting}
          onClose={() => !deleting && setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </SectionCard>
  );
}
