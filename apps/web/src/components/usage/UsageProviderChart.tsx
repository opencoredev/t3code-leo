import type { UsageProviderKind } from "@t3tools/contracts";
import { useMemo } from "react";

import type { DailyTotals } from "../../usage/usageMerge";
import { formatDayShort, formatTokens, formatUsd } from "../../usage/usageFormat";
import { Area } from "../dither-kit/area";
import { AreaChart } from "../dither-kit/area-chart";
import type { ChartConfig } from "../dither-kit/chart-context";
import { Grid } from "../dither-kit/grid";
import { Tooltip } from "../dither-kit/tooltip";
import { XAxis } from "../dither-kit/x-axis";
import { YAxis } from "../dither-kit/y-axis";
import { PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
}

/** One day's per-provider values, shared by the chart and focused tests. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

function valueFor(
  daily: DailyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = daily?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

/** Retained for scale regression tests and non-canvas consumers. */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

export function buildDayColumns(
  days: readonly string[],
  byDay: ReadonlyMap<string, DailyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return days.map((day) => {
    const entry = byDay.get(day);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

interface UsageChartRow {
  readonly day: string;
  readonly pi: number;
  readonly codex: number;
  readonly claude: number;
}

const DITHER_CONFIG: ChartConfig = {
  pi: { label: PROVIDER_LABEL.pi, color: "nightlyBlue" },
  codex: { label: PROVIDER_LABEL.codex, color: "nightlyIndigo" },
  claude: { label: PROVIDER_LABEL.claude, color: "nightlyPurple" },
};

export function UsageProviderChart({ days, daily, metric }: UsageProviderChartProps) {
  const data = useMemo<UsageChartRow[]>(() => {
    const byDay = new Map(daily.map((entry) => [entry.day, entry]));
    return days.map((day) => ({
      day,
      pi: valueFor(byDay.get(day), "pi", metric),
      codex: valueFor(byDay.get(day), "codex", metric),
      claude: valueFor(byDay.get(day), "claude", metric),
    }));
  }, [daily, days, metric]);
  const format = metric === "tokens" ? formatTokens : formatUsd;

  return (
    <div className="h-64 w-full" role="group" aria-label={`Daily ${metric} by provider`}>
      <AreaChart
        data={data}
        config={DITHER_CONFIG}
        animate={false}
        bloom="off"
        margins={{ top: 12, right: 12, bottom: 28, left: 68 }}
      >
        <Grid horizontal />
        <YAxis tickFormatter={format} />
        <XAxis
          dataKey="day"
          maxTicks={5}
          tickFormatter={(value) => formatDayShort(String(value))}
        />
        {PROVIDER_ORDER.map((provider) => (
          <Area key={provider} dataKey={provider} variant="gradient" isClickable />
        ))}
        <Tooltip labelKey="day" variant="frosted-glass" valueFormatter={(value) => format(value)} />
      </AreaChart>
    </div>
  );
}

export function UsageChartLegend() {
  return (
    <div className="flex items-center gap-4">
      {PROVIDER_ORDER.map((provider) => {
        const Mark = PROVIDER_MARK[provider];
        return (
          <span key={provider} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mark className="size-3.5 shrink-0" aria-hidden />
            {PROVIDER_LABEL[provider]}
          </span>
        );
      })}
    </div>
  );
}
