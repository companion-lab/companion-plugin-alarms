// Banner styles, inlined: plugin bundles cannot rely on the host loading
// a separate stylesheet; the widget injects this once on first render.

let injected = false;

export function injectBannerStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.id = "alarms-plugin-banner-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* Alarm ringing banner — shown over the avatar when an alarm fires.
   Lives in the main window, which loads no other stylesheet, so tokens are
   repeated here instead of imported from settings.css. */

.alarm-banner {
  --ab-accent: #f7768e;
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9998;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: calc(100% - 20px);
  padding: 8px 10px 8px 12px;
  border-radius: 10px;
  background: rgba(24, 16, 22, 0.92);
  border: 1px solid rgba(247, 118, 142, 0.45);
  color: #f0f3f6;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  pointer-events: auto;
  animation: alarm-banner-in 180ms ease-out;
}

@keyframes alarm-banner-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

/* Icon pulses while the announcement repeats. */
.alarm-banner-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  animation: alarm-banner-pulse 1.6s ease-in-out infinite;
}

@keyframes alarm-banner-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(0.92);
  }
}

.alarm-banner-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.alarm-banner-title {
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alarm-banner-sub {
  font-size: 10px;
  font-weight: 500;
  color: rgba(240, 243, 246, 0.6);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alarm-banner-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.alarm-banner-btn {
  padding: 6px 12px;
  min-height: 28px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  border-radius: 7px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.alarm-banner-btn:focus-visible {
  outline: 2px solid rgba(122, 162, 247, 0.8);
  outline-offset: 2px;
}

.alarm-banner-btn-snooze {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.14);
  color: #f0f3f6;
}

.alarm-banner-btn-snooze:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.24);
}

.alarm-banner-btn-stop {
  background: var(--ab-accent);
  color: #1a1015;
}

.alarm-banner-btn-stop:hover {
  background: #ff8fa3;
}

.alarm-banner-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Narrow window: let the label use the full width and buttons span below. */
@media (max-width: 320px) {
  .alarm-banner {
    flex-wrap: wrap;
    row-gap: 8px;
  }
  .alarm-banner-text {
    flex: 1 1 auto;
  }
  .alarm-banner-actions {
    flex: 1 1 100%;
  }
  .alarm-banner-btn {
    flex: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .alarm-banner,
  .alarm-banner-icon {
    animation: none;
  }
}
`;
