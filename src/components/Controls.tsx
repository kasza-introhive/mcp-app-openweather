/**
 * @file Toggle bar.
 *
 * Two distinct kinds of control, which is the point worth noticing:
 *   - Metric  -> pure client-side reshape of data already held.
 *   - Units / days -> requires a NEW tool call to the server.
 * The E2E specs assert exactly that difference.
 */
import { METRIC_LABELS, METRICS, type Metric } from "./ForecastChart.tsx";
import { UNITS, type Units } from "../openweather.ts";
import styles from "../mcp-app.module.css";

const UNIT_LABELS: Record<Units, string> = {
  metric: "°C",
  imperial: "°F",
  standard: "K",
};

const DAY_OPTIONS = [1, 3, 5] as const;

interface ControlsProps {
  metric: Metric;
  units: Units;
  days: number;
  /** Disables the server-backed controls while a request is in flight. */
  busy: boolean;
  onMetricChange: (metric: Metric) => void;
  onUnitsChange: (units: Units) => void;
  onDaysChange: (days: number) => void;
}

export function Controls({
  metric,
  units,
  days,
  busy,
  onMetricChange,
  onUnitsChange,
  onDaysChange,
}: ControlsProps) {
  return (
    <div className={styles.controls}>
      {/* Client-only: no tool call. */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Metric</span>
        <div className={styles.segmented} role="group" aria-label="Metric">
          {METRICS.map((m) => (
            <button
              key={m}
              type="button"
              className={styles.segment}
              aria-pressed={metric === m}
              data-testid={`metric-${m}`}
              onClick={() => onMetricChange(m)}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Server-backed: each of these triggers app.callServerTool(). */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Units</span>
        <div className={styles.segmented} role="group" aria-label="Units">
          {UNITS.map((u) => (
            <button
              key={u}
              type="button"
              className={styles.segment}
              aria-pressed={units === u}
              disabled={busy}
              data-testid={`units-${u}`}
              onClick={() => onUnitsChange(u)}
            >
              {UNIT_LABELS[u]}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Days</span>
        <div className={styles.segmented} role="group" aria-label="Days">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={styles.segment}
              aria-pressed={days === d}
              disabled={busy}
              data-testid={`days-${d}`}
              onClick={() => onDaysChange(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
