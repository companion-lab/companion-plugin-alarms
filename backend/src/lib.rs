//! Alarms feature plugin backend.
//!
//! Port of the former host module `src-tauri/src/alarms.rs` plus the
//! model-facing alarm tools from the former builtin MCP server in `mcp.rs`.
//!
//! - Storage: `{data_dir}/alarms.json` (the dir the host passes via
//!   `PluginCtx::data_dir()`; legacy profiles are migrated by the host).
//! - Scheduler: a plain 20s thread; on fire it emits the namespaced event
//!   `plugin:alarms:alarm-fired`, which this plugin's frontend banner and any
//!   interested listener receive.
//! - Tools: `alarm_list/create/update/delete/toggle` reach the chat model as
//!   `alarms__<name>` and arrive as `handle("tool", {name, args})`.

use chrono::{Datelike, Local, TimeZone, Timelike};
use companion_plugin_sdk::{export_plugin, Plugin, PluginCtx, ToolDef};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `weekdays` is a bitmask with bit0 = Monday .. bit6 = Sunday. Zero means a
/// one-shot alarm: it fires at the next matching HH:MM, then disables itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alarm {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub hour: u8,
    pub minute: u8,
    #[serde(default)]
    pub weekdays: u8,
    #[serde(default)]
    pub message: String,
    /// Repeat the announcement until stopped or snoozed.
    #[serde(default)]
    pub loop_sound: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Minutes since epoch of the last fire, so a tick never double-fires.
    #[serde(default)]
    pub last_fired: Option<i64>,
    /// Absolute unix-seconds fire time for "in N minutes" timers.
    /// Takes precedence over the HH:MM/weekday schedule when set.
    #[serde(default)]
    pub fire_at: Option<i64>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Serialize)]
pub struct AlarmFired {
    pub id: String,
    pub label: String,
    pub message: String,
    pub loop_sound: bool,
}

struct Alarms {
    alarms: Arc<Mutex<Vec<Alarm>>>,
    data_dir: PathBuf,
    stop: Arc<AtomicBool>,
}

impl Alarms {
    fn load(&mut self) {
        let path = self.data_dir.join("alarms.json");
        let list: Vec<Alarm> = match std::fs::read_to_string(&path) {
            Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if let Ok(mut guard) = self.alarms.lock() {
            *guard = list;
        }
    }

    fn write(&self, list: &[Alarm]) -> Result<(), String> {
        let path = self.data_dir.join("alarms.json");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("write alarms: {e}"))
    }

    /// Persist the current list and notify listeners (settings section).
    fn persist(&self) -> Result<Vec<Alarm>, String> {
        let list = self
            .alarms
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        self.write(&list)?;
        Ok(list)
    }

    fn sanitize(alarm: &mut Alarm) {
        alarm.hour = alarm.hour.min(23);
        alarm.minute = alarm.minute.min(59);
        alarm.weekdays &= 0b0111_1111;
        alarm.label = alarm.label.trim().to_string();
        alarm.message = alarm.message.trim().to_string();
        if alarm.id.trim().is_empty() {
            alarm.id = format!(
                "alarm-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            );
        }
    }

    // -- core operations (former tauri commands) ----------------------------

    fn op_save(&self, alarm: Alarm) -> Result<Vec<Alarm>, String> {
        let mut a = alarm;
        Self::sanitize(&mut a);
        let mut guard = self.alarms.lock().map_err(|e| e.to_string())?;
        match guard.iter().position(|x| x.id == a.id) {
            Some(i) => guard[i] = a,
            None => guard.push(a),
        }
        drop(guard);
        self.persist()
    }

    fn op_delete(&self, id: &str) -> Result<Vec<Alarm>, String> {
        let mut guard = self.alarms.lock().map_err(|e| e.to_string())?;
        guard.retain(|a| a.id != id);
        drop(guard);
        self.persist()
    }

    fn op_toggle(&self, id: &str, enabled: bool) -> Result<Vec<Alarm>, String> {
        {
            let mut guard = self.alarms.lock().map_err(|e| e.to_string())?;
            if let Some(a) = guard.iter_mut().find(|a| a.id == id) {
                a.enabled = enabled;
                if enabled {
                    a.last_fired = None;
                }
            }
        }
        self.persist()
    }

    /// "Remind me in N minutes": a one-shot timer visible in the alarm list.
    fn op_in(
        &self,
        minutes: f64,
        label: Option<String>,
        message: Option<String>,
        loop_sound: Option<bool>,
    ) -> Result<Vec<Alarm>, String> {
        if !minutes.is_finite() || minutes <= 0.0 || minutes > 60.0 * 24.0 * 7.0 {
            return Err("minutes must be between 0 and 10080 (one week)".into());
        }
        let fire_at = Local::now().timestamp() + (minutes * 60.0).round() as i64;
        let mut a = Alarm {
            id: String::new(),
            label: label.unwrap_or_default(),
            hour: 0,
            minute: 0,
            weekdays: 0,
            message: message.unwrap_or_default(),
            loop_sound: loop_sound.unwrap_or(false),
            enabled: true,
            last_fired: None,
            fire_at: Some(fire_at),
        };
        Self::sanitize(&mut a);
        let mut guard = self.alarms.lock().map_err(|e| e.to_string())?;
        guard.push(a);
        drop(guard);
        self.persist()
    }

    /// Fire path smoke test: emits the same event a scheduler tick would.
    fn op_test(&self, ctx: &PluginCtx, label: String, message: String, loop_sound: Option<bool>) {
        let fired = AlarmFired {
            id: "test".into(),
            label: label.trim().to_string(),
            message: message.trim().to_string(),
            loop_sound: loop_sound.unwrap_or(false),
        };
        ctx.info("test fire");
        ctx.emit("alarm-fired", &serde_json::to_value(&fired).unwrap_or(Value::Null));
    }

    // -- model-facing tools (former builtin MCP server) ---------------------

    fn tool_list(&self) -> Result<String, String> {
        let list = self.alarms.lock().map_err(|e| e.to_string())?.clone();
        if list.is_empty() {
            return Ok("No alarms set.".into());
        }
        let now = Local::now();
        Ok(list
            .iter()
            .map(|a| format_alarm_line(a, now))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    fn tool_create(&self, args: &Value) -> Result<String, String> {
        if let Some(mins) = arg_minutes(args) {
            self.op_in(mins, Some(arg_str(args, "label")), Some(arg_str(args, "message")), Some(arg_bool(args, "loop_sound")))?;
            return Ok(format!(
                "Timer set for {mins} minute{} from now.",
                if mins == 1.0 { "" } else { "s" }
            ));
        }
        let (hour, minute) = match (
            args.get("hour").and_then(|v| v.as_u64()),
            args.get("minute").and_then(|v| v.as_u64()),
        ) {
            (Some(h), Some(m)) if h <= 23 && m <= 59 => (h as u8, m as u8),
            _ => {
                let text = [arg_str(args, "time"), arg_str(args, "at")]
                    .iter()
                    .find(|s| !s.is_empty())
                    .cloned()
                    .unwrap_or_default();
                match parse_clock_text(&text) {
                    Some((h, m)) => (h, m),
                    None => {
                        return Err("could not read the time. Use hour and minute, or a string like '07:30'.".into())
                    }
                }
            }
        };
        let alarm = Alarm {
            id: String::new(),
            label: arg_str(args, "label"),
            hour,
            minute,
            weekdays: parse_weekdays_value(
                args.get("weekdays")
                    .or_else(|| args.get("days"))
                    .or_else(|| args.get("repeat")),
            ),
            message: arg_str(args, "message"),
            loop_sound: arg_bool(args, "loop_sound"),
            enabled: true,
            last_fired: None,
            fire_at: None,
        };
        let weekdays = alarm.weekdays;
        let (h, m) = (alarm.hour, alarm.minute);
        self.op_save(alarm)?;
        let days = if weekdays != 0 {
            format!("every {}", weekday_names(weekdays).join("/"))
        } else {
            "once".to_string()
        };
        Ok(format!("Created alarm at {}, {days}.", human_clock(h, m)))
    }

    fn tool_update(&self, args: &Value) -> Result<String, String> {
        let id = arg_str(args, "id");
        if id.is_empty() {
            return Err("id is required. Call alarm_list to find it.".into());
        }
        let found = {
            let guard = self.alarms.lock().map_err(|e| e.to_string())?;
            guard
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or("no alarm with that id. Call alarm_list to find it.")?
        };
        // Partial patch: only fields present in the args change; the rest
        // keep the stored value, so the model never has to restate them.
        let mut a = found;
        if let Some(mins) = arg_minutes(args) {
            if mins > 60.0 * 24.0 * 7.0 {
                return Err("minutes must be at most 10080 (one week).".into());
            }
            a.fire_at = Some(Local::now().timestamp() + (mins * 60.0).round() as i64);
            a.hour = 0;
            a.minute = 0;
            a.weekdays = 0;
        } else if args.get("hour").is_some() || args.get("minute").is_some() {
            let text = [arg_str(args, "time"), arg_str(args, "at")]
                .iter()
                .find(|s| !s.is_empty())
                .cloned()
                .unwrap_or_default();
            let text_clock = parse_clock_text(&text);
            let h = args
                .get("hour")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or_else(|| text_clock.map(|(h, _)| h as u32));
            let m = args
                .get("minute")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or_else(|| text_clock.map(|(_, m)| m as u32));
            match (h, m) {
                (Some(h), Some(m)) if h <= 23 && m <= 59 => {
                    a.hour = h as u8;
                    a.minute = m as u8;
                    a.fire_at = None;
                }
                (Some(h), _) if h > 23 => return Err("hour must be 0-23.".into()),
                (_, Some(m)) if m > 59 => return Err("minute must be 0-59.".into()),
                _ => {
                    return Err(
                        "pass both hour and minute (0-23, 0-59), or a string like '07:30'.".into()
                    )
                }
            }
        }
        if let Some(v) = args
            .get("weekdays")
            .or_else(|| args.get("days"))
            .or_else(|| args.get("repeat"))
        {
            a.weekdays = parse_weekdays_value(Some(v));
            if a.weekdays != 0 {
                a.fire_at = None;
            }
        }
        if args.get("label").is_some() {
            a.label = arg_str(args, "label");
        }
        if args.get("message").is_some() {
            a.message = arg_str(args, "message");
        }
        if args.get("loop_sound").or_else(|| args.get("loop")).is_some() {
            a.loop_sound = arg_bool(args, "loop_sound");
        }
        if let Some(enabled) = args.get("enabled").and_then(|v| v.as_bool()) {
            a.enabled = enabled;
            if enabled {
                a.last_fired = None;
            }
        }
        let weekdays = a.weekdays;
        let (h, m) = (a.hour, a.minute);
        self.op_save(a)?;
        let days = if weekdays != 0 {
            format!("every {}", weekday_names(weekdays).join("/"))
        } else {
            "once".to_string()
        };
        Ok(format!("Updated alarm at {}, {days}.", human_clock(h, m)))
    }

    fn tool_delete(&self, args: &Value) -> Result<String, String> {
        let id = arg_str(args, "id");
        if id.is_empty() {
            return Err("id is required. Call alarm_list to find it.".into());
        }
        self.op_delete(&id)?;
        Ok("Deleted that alarm.".into())
    }

    fn tool_toggle(&self, args: &Value) -> Result<String, String> {
        let id = arg_str(args, "id");
        if id.is_empty() {
            return Err("id is required. Call alarm_list to find it.".into());
        }
        let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        self.op_toggle(&id, enabled)?;
        Ok(format!(
            "{} that alarm.",
            if enabled { "Resumed" } else { "Paused" }
        ))
    }

    fn handle_tool(&self, ctx: &PluginCtx, name: &str, args: Value) -> Result<Value, String> {
        let result = match name {
            "alarm_list" => self.tool_list(),
            "alarm_create" => self.tool_create(&args),
            "alarm_update" => self.tool_update(&args),
            "alarm_delete" => self.tool_delete(&args),
            "alarm_toggle" => self.tool_toggle(&args),
            other => return Err(format!("unknown tool: {other}")),
        }?;
        ctx.info(&format!("tool {name}"));
        // Tool results cross back as JSON strings (the chat loop stringifies
        // tool content); keep that contract explicit.
        Ok(Value::String(result))
    }

    /// Route one frontend/backend request. `ctx` carries the plugin identity
    /// for emits (test fires, etc.).
    fn route(&self, ctx: &PluginCtx, method: &str, payload: Value) -> Result<Value, String> {
        match method {
            "alarms.list" => {
                let list = self.alarms.lock().map_err(|e| e.to_string())?.clone();
                Ok(json!({ "alarms": list }))
            }
            "alarms.save" => {
                let alarm: Alarm = serde_json::from_value(
                    payload.get("alarm").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| format!("bad alarm: {e}"))?;
                let list = self.op_save(alarm)?;
                Ok(json!({ "alarms": list }))
            }
            "alarms.delete" => {
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("id is required")?;
                let list = self.op_delete(id)?;
                Ok(json!({ "alarms": list }))
            }
            "alarms.toggle" => {
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("id is required")?;
                let enabled = payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("enabled is required")?;
                let list = self.op_toggle(id, enabled)?;
                Ok(json!({ "alarms": list }))
            }
            "alarms.in" => {
                let minutes = payload
                    .get("minutes")
                    .and_then(Value::as_f64)
                    .ok_or("minutes is required")?;
                let label = payload
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let loop_sound = payload.get("loop_sound").and_then(Value::as_bool);
                let list = self.op_in(minutes, label, message, loop_sound)?;
                Ok(json!({ "alarms": list }))
            }
            "alarms.test" => {
                let label = payload
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let loop_sound = payload.get("loop_sound").and_then(Value::as_bool);
                self.op_test(ctx, label, message, loop_sound);
                Ok(json!({ "ok": true }))
            }
            "tool" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("tool name missing")?;
                let args = payload.get("args").cloned().unwrap_or(Value::Null);
                self.handle_tool(ctx, name, args)
            }
            "alarms.ping" => Ok(json!({ "pong": true })),
            other => Err(format!("unknown method: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Scheduling (ported from alarms.rs; pure helpers stay testable)
// ---------------------------------------------------------------------------

/// Bit for a weekday, matching the frontend's Mon=0 .. Sun=6 mask.
fn weekday_bit(now: chrono::DateTime<Local>) -> u8 {
    1u8 << now.weekday().num_days_from_monday()
}

/// True when `alarm` should fire at `now`'s minute.
fn is_due(alarm: &Alarm, now: chrono::DateTime<Local>, minute_stamp: i64) -> bool {
    if !alarm.enabled {
        return false;
    }
    if let Some(fire_at) = alarm.fire_at {
        // Relative timer: due once the wall clock passes the target.
        // last_fired still guards against double-fire across ticks.
        return now.timestamp() >= fire_at && alarm.last_fired != Some(minute_stamp);
    }
    if alarm.hour != now.hour() as u8 || alarm.minute != now.minute() as u8 {
        return false;
    }
    if alarm.weekdays != 0 && alarm.weekdays & weekday_bit(now) == 0 {
        return false;
    }
    alarm.last_fired != Some(minute_stamp)
}

fn tick(alarms: &Mutex<Vec<Alarm>>, write: &dyn Fn(&[Alarm]) -> Result<(), String>) -> Vec<AlarmFired> {
    let now = Local::now();
    let minute_stamp = now.timestamp() / 60;
    let mut fired: Vec<AlarmFired> = Vec::new();
    if let Ok(mut guard) = alarms.lock() {
        let mut changed = false;
        for alarm in guard.iter_mut() {
            if !is_due(alarm, now, minute_stamp) {
                continue;
            }
            alarm.last_fired = Some(minute_stamp);
            // One-shot: retire after firing so it cannot re-trigger.
            // Relative timers are one-shot by nature.
            if alarm.fire_at.is_some() || alarm.weekdays == 0 {
                alarm.enabled = false;
            }
            fired.push(AlarmFired {
                id: alarm.id.clone(),
                label: alarm.label.clone(),
                message: alarm.message.clone(),
                loop_sound: alarm.loop_sound,
            });
            changed = true;
        }
        if changed {
            let snapshot = guard.clone();
            if let Err(e) = write(&snapshot) {
                eprintln!("[alarms] persist failed: {e}");
            }
        }
    }
    fired
}

fn spawn_scheduler(ctx: PluginCtx, alarms: Arc<Mutex<Vec<Alarm>>>, data_dir: PathBuf, stop: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("alarms-plugin-scheduler".into())
        .spawn(move || {
            // 20s tick: cheap, and guarantees we land inside the target minute
            // even with normal scheduling jitter.
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_secs(20));
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let write = |list: &[Alarm]| -> Result<(), String> {
                    let path = data_dir.join("alarms.json");
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
                    std::fs::write(&path, json).map_err(|e| format!("write alarms: {e}"))
                };
                for f in tick(&alarms, &write) {
                    ctx.info(&format!("fired {}", f.id));
                    ctx.emit(
                        "alarm-fired",
                        &serde_json::to_value(&f).unwrap_or(Value::Null),
                    );
                    // Ring/stop state lives in the frontend banner; a change to
                    // the stored list is also relevant to the settings section.
                    ctx.emit("alarms-changed", &Value::Null);
                }
            }
        })
        .expect("spawn alarms scheduler thread");
}

// ---------------------------------------------------------------------------
// Model-tool helpers (ported from the former builtin MCP server in mcp.rs)
// ---------------------------------------------------------------------------

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn arg_minutes(args: &Value) -> Option<f64> {
    for key in ["in_minutes", "minutes", "in"] {
        if let Some(n) = args.get(key).and_then(|v| v.as_f64()) {
            if n.is_finite() && n > 0.0 {
                return Some(n);
            }
        }
    }
    None
}

fn arg_bool(args: &Value, key: &str) -> bool {
    if args.get(key).and_then(|v| v.as_bool()).unwrap_or(false) {
        return true;
    }
    // Accept the short alias `loop` for `loop_sound`.
    key == "loop_sound" && args.get("loop").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Lenient "7am" / "7:30" / "19:05" parser.
fn parse_clock_text(s: &str) -> Option<(u8, u8)> {
    let lower = s.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let mer = if lower.ends_with("am") {
        Some("am")
    } else if lower.ends_with("pm") {
        Some("pm")
    } else {
        None
    };
    let body = match mer {
        Some(_) => lower[..lower.len() - 2].trim(),
        None => lower.as_str(),
    };
    let (h_str, m_str) = match body.split_once(':') {
        Some((h, m)) => (h.trim(), Some(m.trim())),
        None => (body, None),
    };
    let mut h: u32 = h_str.parse().ok()?;
    let m: u32 = match m_str {
        Some(s) => s.parse().ok()?,
        None => 0,
    };
    match mer {
        Some("pm") if h < 12 => h += 12,
        Some("am") if h == 12 => h = 0,
        _ => {}
    }
    if h > 23 || m > 59 {
        return None;
    }
    Some((h as u8, m as u8))
}

fn weekday_word_mask(words: &[String]) -> u8 {
    fn bit(w: &str) -> u8 {
        match w {
            "mon" => 1 << 0,
            "tue" | "tues" => 1 << 1,
            "wed" => 1 << 2,
            "thu" | "thur" | "thurs" => 1 << 3,
            "fri" => 1 << 4,
            "sat" => 1 << 5,
            "sun" => 1 << 6,
            "everyday" | "daily" => 0x7f,
            "weekday" | "weekdays" | "workday" | "workdays" => 0x1f,
            "weekend" | "weekends" => 0x60,
            _ => 0,
        }
    }
    let mut mask = 0u8;
    for w in words {
        let lower = w.to_lowercase();
        let key = if lower.len() > 3 { &lower[..3] } else { lower.as_str() };
        // Try full word first (everyday/weekday/weekend), then 3-letter day.
        mask |= bit(lower.as_str());
        mask |= bit(key);
    }
    mask & 0x7f
}

fn parse_weekdays_value(v: Option<&Value>) -> u8 {
    let Some(v) = v else { return 0 };
    if let Some(n) = v.as_u64() {
        return (n as u8) & 0x7f;
    }
    let mut words: Vec<String> = Vec::new();
    match v {
        Value::String(s) => {
            words.extend(
                s.to_lowercase()
                    .split(|c: char| !c.is_alphabetic())
                    .filter(|w| !w.is_empty())
                    .map(|w| w.to_string()),
            );
        }
        Value::Array(arr) => {
            for item in arr {
                if let Some(s) = item.as_str() {
                    words.extend(
                        s.to_lowercase()
                            .split(|c: char| !c.is_alphabetic())
                            .filter(|w| !w.is_empty())
                            .map(|w| w.to_string()),
                    );
                }
            }
        }
        _ => {}
    }
    weekday_word_mask(&words)
}

const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// "10:00 PM" — models read a 12-hour clock back to the user far more
/// naturally than 22:00.
fn human_clock(hour: u8, minute: u8) -> String {
    let (h12, suffix) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour as u32, "AM"),
        12 => (12, "PM"),
        _ => (hour as u32 - 12, "PM"),
    };
    format!("{h12}:{minute:02} {suffix}")
}

fn weekday_names(mask: u8) -> Vec<&'static str> {
    DAY_NAMES
        .iter()
        .enumerate()
        .filter(|(d, _)| mask & (1 << d) != 0)
        .map(|(_, n)| *n)
        .collect()
}

/// Start-of-day plus HH:MM, resolving DST gaps to the earliest valid instant.
fn at_time(day: chrono::NaiveDate, hour: u8, minute: u8) -> chrono::DateTime<Local> {
    day.and_hms_opt(hour as u32, minute as u32, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).earliest())
        .unwrap_or_else(Local::now)
}

/// Next firing moment, mirroring the frontend's nextFire() so the summary and
/// the Settings list always agree.
fn next_fire(a: &Alarm, now: chrono::DateTime<Local>) -> chrono::DateTime<Local> {
    let today = now.date_naive();
    if a.weekdays == 0 {
        let at = at_time(today, a.hour, a.minute);
        return if at > now {
            at
        } else {
            at_time(today + chrono::Duration::days(1), a.hour, a.minute)
        };
    }
    for offset in 0..8i64 {
        let day = today + chrono::Duration::days(offset);
        let bit = 1u8 << day.weekday().num_days_from_monday() as u8;
        if a.weekdays & bit == 0 {
            continue;
        }
        let at = at_time(day, a.hour, a.minute);
        if at > now {
            return at;
        }
    }
    at_time(today, a.hour, a.minute)
}

fn day_word(then: chrono::DateTime<Local>, now: chrono::DateTime<Local>) -> String {
    let days = (then.date_naive() - now.date_naive()).num_days();
    match days {
        d if d <= 0 => "today".into(),
        1 => "tomorrow".into(),
        _ => DAY_NAMES[then.weekday().num_days_from_monday() as usize].to_string(),
    }
}

/// The when-clause in words: "today at 10:00 PM", "every Mon/Wed at 7:30 AM
/// (next Wed)", "in 15m (Fri Mar 14, 3:20 PM)".
fn schedule_phrase(a: &Alarm, now: chrono::DateTime<Local>) -> String {
    if let Some(ts) = a.fire_at {
        let target = chrono::DateTime::from_timestamp(ts, 0)
            .map(|dt| dt.with_timezone(&Local))
            .unwrap_or(now);
        let mins = (((ts - now.timestamp()) as f64) / 60.0).round() as i64;
        let rel = if mins < 1 {
            "due now".to_string()
        } else if mins < 60 {
            format!("in {mins}m")
        } else {
            let h = mins / 60;
            let m = mins % 60;
            if m == 0 {
                format!("in {h}h")
            } else {
                format!("in {h}h {m}m")
            }
        };
        return format!(
            "{rel} ({})",
            target.format("%a %b %d, ").to_string()
                + &human_clock(target.hour() as u8, target.minute() as u8)
        );
    }
    let clock = human_clock(a.hour, a.minute);
    if a.weekdays != 0 {
        let next = next_fire(a, now);
        format!(
            "every {} at {clock} (next {})",
            weekday_names(a.weekdays).join("/"),
            day_word(next, now)
        )
    } else {
        let next = next_fire(a, now);
        format!("once, {} at {clock}", day_word(next, now))
    }
}

fn status_phrase(a: &Alarm, now: chrono::DateTime<Local>) -> &'static str {
    if !a.enabled {
        return "paused";
    }
    if let Some(ts) = a.fire_at {
        if now.timestamp() >= ts {
            return "due now";
        }
    }
    "active"
}

/// One human-readable line per alarm. The internal id stays available but is
/// fenced behind a tool-use-only marker: the model must never read an
/// epoch-millis id such as "alarm-1791042535800" back to the user.
fn format_alarm_line(a: &Alarm, now: chrono::DateTime<Local>) -> String {
    let label = if a.label.trim().is_empty() {
        "Alarm"
    } else {
        a.label.trim()
    };
    let sound = if a.loop_sound {
        ", rings until stopped"
    } else {
        ""
    };
    format!(
        "- {label} — {}{sound} ({}) [id_for_tool_use_only: {}]",
        schedule_phrase(a, now),
        status_phrase(a, now),
        a.id
    )
}

fn tool_defs() -> Vec<ToolDef> {
    let schema = |props: Value, required: &[&str]| json!({
        "type": "object",
        "properties": props,
        "required": required,
    });
    vec![
        ToolDef {
            name: "alarm_list".into(),
            description: "List the user's existing alarms as a human-readable summary: label, when it rings, repeat days, and whether it is active or paused. When you answer the user, describe alarms in words only (e.g. 'your 10 PM reminder'). Never read the internal id aloud — it exists only as the `id` argument for alarm_update, alarm_delete or alarm_toggle.".into(),
            input_schema: schema(json!({}), &[]),
        },
        ToolDef {
            name: "alarm_create".into(),
            description: "Create an alarm. Use for requests like 'wake me at 7am' or 'remind me every weekday at 9'. For relative requests like 'in 10 minutes', pass in_minutes instead of hour/minute. Omit weekdays (or pass empty) for a one-time alarm. Weekdays are names like Mon..Sun. `message` is REQUIRED: the words the avatar speaks when it fires. Pass loop_sound true for 'keep ringing until I stop it'.".into(),
            input_schema: schema(
                json!({
                    "in_minutes": { "type": "number", "description": "Relative timer, e.g. 10 for 'in 10 minutes'. Use instead of hour/minute." },
                    "hour": { "type": "integer", "description": "Hour in 24h local time, 0-23" },
                    "minute": { "type": "integer", "description": "Minute, 0-59" },
                    "weekdays": { "type": "array", "description": "Repeat days. Empty = one-time alarm.", "items": { "type": "string" } },
                    "label": { "type": "string", "description": "Short name, e.g. 'Morning workout'" },
                    "message": { "type": "string", "description": "REQUIRED. What the avatar says out loud when it fires." },
                    "loop_sound": { "type": "boolean", "description": "Repeat the announcement until stopped. Default false (plays once)." },
                }),
                &["message"],
            ),
        },
        ToolDef {
            name: "alarm_update".into(),
            description: "Change an existing alarm by id. Call alarm_list first to find the id. Pass ONLY the fields to change; omitted fields keep their current value. Use for requests like 'move my 7am alarm to 8am' or 'turn off the workout alarm'. Hour/minute use 24h local time.".into(),
            input_schema: schema(
                json!({
                    "id": { "type": "string", "description": "Alarm id from alarm_list" },
                    "hour": { "type": "integer", "description": "New hour in 24h local time, 0-23" },
                    "minute": { "type": "integer", "description": "New minute, 0-59" },
                    "in_minutes": { "type": "number", "description": "Convert to a one-shot timer firing N minutes from now. Use instead of hour/minute." },
                    "weekdays": { "type": "array", "description": "New repeat days (replaces the old ones). Empty = one-time alarm.", "items": { "type": "string" } },
                    "label": { "type": "string", "description": "New short name" },
                    "message": { "type": "string", "description": "New spoken message" },
                    "loop_sound": { "type": "boolean", "description": "New loop behavior" },
                    "enabled": { "type": "boolean", "description": "true to resume, false to pause" },
                }),
                &["id"],
            ),
        },
        ToolDef {
            name: "alarm_delete".into(),
            description: "Delete an alarm by id. Call alarm_list first to find the id.".into(),
            input_schema: schema(
                json!({
                    "id": { "type": "string", "description": "Alarm id from alarm_list" },
                }),
                &["id"],
            ),
        },
        ToolDef {
            name: "alarm_toggle".into(),
            description: "Pause or resume an alarm by id.".into(),
            input_schema: schema(
                json!({
                    "id": { "type": "string", "description": "Alarm id from alarm_list" },
                    "enabled": { "type": "boolean", "description": "true to resume, false to pause" },
                }),
                &["id", "enabled"],
            ),
        },
    ]
}

// ---------------------------------------------------------------------------
// Plugin impl
// ---------------------------------------------------------------------------

/// Concrete plugin type handed to `export_plugin!`. Keeps the ctx so the
/// request router (which runs on `&self`) can emit events.
pub struct AlarmsPlugin {
    inner: Option<Alarms>,
    ctx: Option<PluginCtx>,
}

impl Default for AlarmsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl AlarmsPlugin {
    fn new() -> Self {
        AlarmsPlugin {
            inner: None,
            ctx: None,
        }
    }
}

impl Plugin for AlarmsPlugin {
    fn init(&mut self, ctx: PluginCtx) -> Result<(), String> {
        let data_dir = ctx.data_dir().ok_or("host did not provide a data dir")?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let mut alarms = Alarms {
            alarms: Arc::new(Mutex::new(Vec::new())),
            data_dir,
            stop: Arc::new(AtomicBool::new(false)),
        };
        alarms.load();
        spawn_scheduler(
            ctx.clone(),
            Arc::clone(&alarms.alarms),
            alarms.data_dir.clone(),
            Arc::clone(&alarms.stop),
        );
        ctx.info("alarms ready");
        self.ctx = Some(ctx);
        self.inner = Some(alarms);
        Ok(())
    }

    fn handle(&mut self, method: &str, payload: Value) -> Result<Value, String> {
        let (alarms, ctx) = match (self.inner.as_ref(), self.ctx.as_ref()) {
            (Some(a), Some(c)) => (a, c),
            _ => return Err("alarms plugin failed to initialise".into()),
        };
        alarms.route(ctx, method, payload)
    }

    fn tools(&mut self) -> Vec<ToolDef> {
        tool_defs()
    }

    fn shutdown(&mut self) {
        if let Some(alarms) = self.inner.as_ref() {
            alarms.stop.store(true, Ordering::Relaxed);
        }
    }
}

export_plugin!(AlarmsPlugin::new());

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn alarms() -> Alarms {
        let dir = std::env::temp_dir().join(format!(
            "alarms-plugin-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Alarms {
            alarms: Arc::new(Mutex::new(Vec::new())),
            data_dir: dir,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn alarm(hour: u8, minute: u8, weekdays: u8) -> Alarm {
        Alarm {
            id: "a".into(),
            label: "Wake up".into(),
            hour,
            minute,
            weekdays,
            message: "Time to get up".into(),
            loop_sound: false,
            enabled: true,
            last_fired: None,
            fire_at: None,
        }
    }

    fn timer_in(seconds_from_now: i64) -> Alarm {
        let mut a = alarm(0, 0, 0);
        a.fire_at = Some(Local::now().timestamp() + seconds_from_now);
        a
    }

    #[test]
    fn older_files_without_loop_sound_load_as_once() {
        let json = r#"{"id":"a","hour":7,"minute":30,"enabled":true}"#;
        let a: Alarm = serde_json::from_str(json).unwrap();
        assert!(!a.loop_sound, "missing field must default to play-once");
        assert!(a.enabled, "missing enabled must default to true");
    }

    #[test]
    fn sanitizes_out_of_range_values() {
        let mut a = alarm(99, 77, 0xff);
        Alarms::sanitize(&mut a);
        assert_eq!(a.hour, 23);
        assert_eq!(a.minute, 59);
        assert_eq!(a.weekdays, 0x7f);
        assert!(!a.id.trim().is_empty());
    }

    #[test]
    fn weekday_mask_is_mon_first() {
        // 2026-10-05 is a Monday.
        let monday = Local.with_ymd_and_hms(2026, 10, 5, 7, 30, 0).unwrap();
        assert_eq!(weekday_bit(monday), 1);
        let sunday = Local.with_ymd_and_hms(2026, 10, 11, 7, 30, 0).unwrap();
        assert_eq!(weekday_bit(sunday), 1 << 6);
    }

    #[test]
    fn one_shot_is_due_only_once_per_minute() {
        let now = Local.with_ymd_and_hms(2026, 10, 5, 7, 30, 0).unwrap();
        let stamp = now.timestamp() / 60;
        let mut a = alarm(7, 30, 0);
        assert!(is_due(&a, now, stamp));
        a.last_fired = Some(stamp);
        assert!(!is_due(&a, now, stamp), "must not fire twice in the same minute");
        let next = now + chrono::Duration::minutes(1);
        assert!(!is_due(&a, next, stamp + 1), "minute no longer matches");
    }

    #[test]
    fn weekly_respects_weekday_mask() {
        let monday = Local.with_ymd_and_hms(2026, 10, 5, 7, 30, 0).unwrap();
        let stamp = monday.timestamp() / 60;
        let wed_only = alarm(7, 30, 1 << 2);
        assert!(!is_due(&wed_only, monday, stamp));
        let mon_only = alarm(7, 30, 1 << 0);
        assert!(is_due(&mon_only, monday, stamp));
        // Every day set includes Monday.
        let everyday = alarm(7, 30, 0x7f);
        assert!(is_due(&everyday, monday, stamp));
    }

    #[test]
    fn relative_timer_fires_once_past_target() {
        let now = Local::now();
        let stamp = now.timestamp() / 60;
        // Already past the target: due even though HH:MM never matches.
        let mut t = timer_in(-30);
        assert!(is_due(&t, now, stamp));
        t.last_fired = Some(stamp);
        assert!(!is_due(&t, now, stamp), "must not double-fire in the same minute");
        // Future target: not yet due.
        let future = timer_in(3600);
        assert!(!is_due(&future, now, stamp));
        // Disabled timer never fires.
        let mut off = timer_in(-30);
        off.enabled = false;
        assert!(!is_due(&off, now, stamp));
    }

    #[test]
    fn older_files_without_fire_at_load_as_wall_clock() {
        let json = r#"{"id":"a","hour":7,"minute":30,"enabled":true}"#;
        let a: Alarm = serde_json::from_str(json).unwrap();
        assert!(a.fire_at.is_none(), "missing field must default to wall-clock alarms");
    }

    #[test]
    fn time_mismatch_is_never_due() {
        let now = Local.with_ymd_and_hms(2026, 10, 5, 7, 30, 0).unwrap();
        let stamp = now.timestamp() / 60;
        assert!(!is_due(&alarm(7, 31, 0), now, stamp));
        assert!(!is_due(&alarm(8, 30, 0), now, stamp));
        let mut off = alarm(7, 30, 0);
        off.enabled = false;
        assert!(!is_due(&off, now, stamp));
    }

    #[test]
    fn save_and_list_roundtrip() {
        let a = alarms();
        let list = a.op_save(alarm(7, 30, 0)).unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].id.is_empty(), "sanitize assigns an id");
        assert_eq!(a.tool_list().unwrap().lines().count(), 1);
    }

    #[test]
    fn delete_and_toggle() {
        let a = alarms();
        let list = a.op_save(alarm(7, 30, 0)).unwrap();
        let id = list[0].id.clone();
        a.op_toggle(&id, false).unwrap();
        let list = a.op_delete(&id).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn tool_create_parses_relative_timer() {
        let a = alarms();
        let out = a
            .tool_create(&serde_json::json!({ "in_minutes": 10, "message": "stand up" }))
            .unwrap();
        assert!(out.contains("Timer set for 10 minutes"), "{out}");
        let list = a.alarms.lock().unwrap();
        assert!(list[0].fire_at.is_some());
    }

    #[test]
    fn tool_create_parses_weekday_words() {
        let a = alarms();
        a.tool_create(&serde_json::json!({
            "hour": 7, "minute": 30, "weekdays": ["Mon", "wed"], "label": "gym", "message": "go"
        }))
        .unwrap();
        let list = a.alarms.lock().unwrap();
        assert_eq!(list[0].weekdays, (1 << 0) | (1 << 2));
    }

    #[test]
    fn tool_update_partial_patch() {
        let a = alarms();
        a.tool_create(&serde_json::json!({ "hour": 7, "minute": 30, "message": "go" }))
            .unwrap();
        let id = a.alarms.lock().unwrap()[0].id.clone();
        let out = a
            .tool_update(&serde_json::json!({ "id": id, "hour": 8, "minute": 0 }))
            .unwrap();
        assert!(out.contains("8:00 AM"), "{out}");
        let list = a.alarms.lock().unwrap();
        assert_eq!(list[0].hour, 8);
        assert_eq!(list[0].message, "go", "untouched field keeps its value");
    }

    #[test]
    fn tick_fires_due_one_shot_and_retires_it() {
        let a = alarms();
        let mut t = timer_in(-30);
        t.id = "t1".into();
        *a.alarms.lock().unwrap() = vec![t];
        let write =
            |list: &[Alarm]| -> Result<(), String> { a.write(list) };
        let fired = tick(&a.alarms, &write);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, "t1");
        let list = a.alarms.lock().unwrap();
        assert!(!list[0].enabled, "one-shot retires after firing");
    }
}
