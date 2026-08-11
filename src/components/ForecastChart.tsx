/**
 * @file Recharts composed chart for a forecast series.
 *
 * The selected metric is drawn as a line (plus a dashed "feels like" companion
 * when showing temperature), with precipitation probability as bars on a
 * secondary axis so rain risk is readable alongside any metric.
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { unitSymbols, type ForecastPoint, type ForecastSeries } from "../openweather.ts";
import styles from "../mcp-app.module.css";

export const METRICS = ["temp", "humidity", "wind", "pressure"] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABELS: Record<Metric, string> = {
  temp: "Temperature",
  humidity: "Humidity",
  wind: "Wind",
  pressure: "Pressure",
};

/** Colours are picked to stay distinguishable in both light and dark themes. */
const SERIES_COLOR = "#2563eb";
const COMPANION_COLOR = "#9333ea";
const POP_COLOR = "#38bdf8";

function metricConfig(metric: Metric, series: ForecastSeries) {
  const { temp, speed } = unitSymbols(series.units);
  switch (metric) {
    case "temp":
      return { key: "temp" as const, unit: temp, companion: "feelsLike" as const };
    case "humidity":
      return { key: "humidity" as const, unit: "%", companion: null };
    case "wind":
      return { key: "windSpeed" as const, unit: speed, companion: null };
    case "pressure":
      return { key: "pressure" as const, unit: "hPa", companion: null };
  }
}

interface TooltipPayloadItem {
  payload: ForecastPoint;
}

function ChartTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  unit: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipLabel}>
        {point.label} — {point.description}
      </p>
      <p className={styles.tooltipRow}>
        Temp {point.temp.toFixed(1)}
        {unit} (feels {point.feelsLike.toFixed(1)}
        {unit})
      </p>
      <p className={styles.tooltipRow}>Precipitation chance {point.pop}%</p>
      {point.rain > 0 && <p className={styles.tooltipRow}>Rain {point.rain} mm / 3h</p>}
      {point.snow > 0 && <p className={styles.tooltipRow}>Snow {point.snow} mm / 3h</p>}
      <p className={styles.tooltipRow}>Humidity {point.humidity}%</p>
    </div>
  );
}

export function ForecastChart({ series, metric }: { series: ForecastSeries; metric: Metric }) {
  const config = metricConfig(metric, series);

  return (
    // A definite height comes from the wrapper class; ResponsiveContainer
    // collapses to nothing without one.
    <div className={styles.chartWrap} data-testid="forecast-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series.points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--app-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--app-fg-muted)" }}
            stroke="var(--app-border)"
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            yAxisId="metric"
            tick={{ fontSize: 11, fill: "var(--app-fg-muted)" }}
            stroke="var(--app-border)"
            unit={config.unit}
            width={62}
          />
          <YAxis
            yAxisId="pop"
            orientation="right"
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: "var(--app-fg-muted)" }}
            stroke="var(--app-border)"
            unit="%"
            width={44}
          />
          <Tooltip content={<ChartTooltip unit={unitSymbols(series.units).temp} />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            yAxisId="pop"
            dataKey="pop"
            name="Precipitation chance"
            fill={POP_COLOR}
            fillOpacity={0.35}
            barSize={10}
          />
          <Line
            yAxisId="metric"
            type="monotone"
            dataKey={config.key}
            name={METRIC_LABELS[metric]}
            stroke={SERIES_COLOR}
            strokeWidth={2}
            dot={false}
            // Animation off keeps the Playwright assertions deterministic.
            isAnimationActive={false}
          />
          {config.companion && (
            <Line
              yAxisId="metric"
              type="monotone"
              dataKey={config.companion}
              name="Feels like"
              stroke={COMPANION_COLOR}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
