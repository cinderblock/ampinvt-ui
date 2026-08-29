import { useCallback, useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { readHistory, type HistoryResult, type HistorySeries } from '../api';
import { REGISTERS, asSigned, type RegisterDef } from '../registers';

/** Every live register gets a chart; settings only move when written. */
const CHART_REGS: RegisterDef[] = REGISTERS.filter((r) => r.kind === 'live');

const WINDOW_HOURS = 48;
/**
 * The logger emits a point at least every 60s while running, so a spacing
 * beyond three heartbeats means it was not running. Render that as a hole in
 * the line — a flat interpolation across an outage would be a fabrication.
 */
const GAP_SECS = 180;
const REFRESH_MS = 60_000;

function decode(def: RegisterDef, raw: number): number {
  return (def.signed ? asSigned(raw) : raw) * def.scale;
}

/** uPlot columns with nulls punched in wherever the log has a hole. */
function toPlotData(def: RegisterDef, series: HistorySeries): uPlot.AlignedData {
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  let prev: number | null = null;
  for (const [t, raw] of series.points) {
    if (prev !== null && t - prev > GAP_SECS) {
      xs.push(prev + 1);
      ys.push(null);
    }
    xs.push(t);
    ys.push(decode(def, raw));
    prev = t;
  }
  return [xs, ys];
}

/** Local-calendar-day key, sortable. The user lives in local time; UTC days would split every evening in half. */
function dayKey(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

interface DayEnergy {
  day: string;
  wh: Map<string, number>;
  /** True when the 48h window opened after this day began — the total is a floor, not the day's real figure. */
  partial: boolean;
}

/**
 * Step-integrate power over time, bucketed by local day.
 *
 * Each slice holds the last reading for at most GAP_SECS — integrating across
 * a logging outage would invent energy that was never measured, so outages
 * simply contribute nothing.
 */
function integrate(
  defs: { key: string; series: HistorySeries }[],
  windowStart: number,
): DayEnergy[] {
  const days = new Map<string, Map<string, number>>();
  for (const { key, series } of defs) {
    for (let i = 0; i + 1 < series.points.length; i++) {
      const [t0, raw] = series.points[i];
      const dt = Math.min(series.points[i + 1][0] - t0, GAP_SECS);
      const day = dayKey(t0);
      let bucket = days.get(day);
      if (!bucket) {
        bucket = new Map();
        days.set(day, bucket);
      }
      bucket.set(key, (bucket.get(key) ?? 0) + (raw * dt) / 3600);
    }
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, wh]) => ({ day, wh, partial: day === dayKey(windowStart) }));
}

/**
 * Running Wh accumulated since local midnight, reset at each midnight — the
 * integrator drawn as a line so the shape of the day is visible, not just its
 * total.
 */
function cumulative(series: HistorySeries): uPlot.AlignedData {
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  let acc = 0;
  let day = '';
  for (let i = 0; i < series.points.length; i++) {
    const t = series.points[i][0];
    const d = dayKey(t);
    if (d !== day) {
      day = d;
      acc = 0;
    }
    if (i > 0) {
      const [t0, raw0] = series.points[i - 1];
      if (t - t0 > GAP_SECS) {
        xs.push(t0 + 1);
        ys.push(null);
      } else if (dayKey(t0) === d) {
        acc += (raw0 * (t - t0)) / 3600;
      }
    }
    xs.push(t);
    ys.push(Math.round(acc));
  }
  return [xs, ys];
}

function Chart({
  title,
  data,
  range,
  height = 140,
}: {
  title: string;
  data: uPlot.AlignedData;
  range: [number, number];
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = el.current;
    if (!node) return undefined;

    const css = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;
    const muted = color('--text-muted', '#898781');
    const hairline = color('--hairline', '#e1e0d9');
    const accent = color('--accent', '#2a78d6');

    const plot = new uPlot(
      {
        width: Math.max(node.clientWidth, 280),
        height,
        scales: { x: { time: true, range: () => range } },
        axes: [
          { stroke: muted, grid: { stroke: hairline, width: 1 }, ticks: { stroke: hairline } },
          {
            stroke: muted,
            grid: { stroke: hairline, width: 1 },
            ticks: { stroke: hairline },
            size: 60,
          },
        ],
        series: [
          {},
          {
            stroke: accent,
            width: 1.25,
            // The log is a sample-and-hold record: a value persists until the
            // next point, so steps are the honest rendering, not slopes.
            paths: uPlot.paths.stepped!({ align: 1 }),
            points: { show: false },
            spanGaps: false,
          },
        ],
        legend: { show: false },
        cursor: { sync: { key: 'history' }, points: { size: 6 } },
      },
      data,
      node,
    );

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      plot.setSize({ width: Math.max(width, 280), height });
    });
    ro.observe(node);

    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [data, range, height]);

  return (
    <div className="chart">
      <div className="chart-title">{title}</div>
      <div ref={el} />
    </div>
  );
}

const PV_POWER = REGISTERS.find((r) => r.key === 'pvPower')!;
const INPUT_POWER = REGISTERS.find((r) => r.key === 'inputPower')!;

export default function History() {
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const addrs = CHART_REGS.map((r) => r.addr);
      setHistory(await readHistory(addrs, WINDOW_HOURS));
      setFetchedAt(new Date());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error) {
    return (
      <div className="banner critical">
        <span className="icon" aria-hidden="true">
          ✕
        </span>
        <div className="body">
          <strong>Could not read the log history.</strong> {error}
        </div>
      </div>
    );
  }

  if (!history) {
    return <div className="muted">Reading log history…</div>;
  }

  const byAddr = new Map(history.series.map((s) => [s.addr, s]));
  const range: [number, number] = [history.from, history.to];
  const empty = history.series.every((s) => s.points.length === 0);

  const pvSeries = byAddr.get(PV_POWER.addr);
  const inputSeries = byAddr.get(INPUT_POWER.addr);
  const energy =
    pvSeries && inputSeries
      ? integrate(
          [
            { key: 'pv', series: pvSeries },
            { key: 'input', series: inputSeries },
          ],
          history.from,
        )
      : [];

  return (
    <div className="history">
      <div className="history-head">
        <span className="muted">
          Last {WINDOW_HOURS} h from the register log, refreshed every minute.
          {fetchedAt && ` Updated ${fetchedAt.toLocaleTimeString()}.`}
        </span>
        <div className="spacer" />
        <button onClick={() => void refresh()}>Refresh</button>
      </div>

      {empty && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            !
          </span>
          <div className="body">
            <strong>No log data in the last {WINDOW_HOURS} hours.</strong> Charts fill in
            once logging has been running — it starts with the connection by default.
          </div>
        </div>
      )}

      {energy.length > 0 && (
        <section>
          <h2>Daily energy</h2>
          <p className="desc">
            Integrated from the logged power readings, per local calendar day. Gaps in
            logging contribute nothing, so a day with outages under-counts.
          </p>
          <table className="energy">
            <thead>
              <tr>
                <th>Day</th>
                <th>PV input</th>
                <th>Total input</th>
              </tr>
            </thead>
            <tbody>
              {energy.map(({ day, wh, partial }) => (
                <tr key={day}>
                  <td>
                    {day}
                    {partial && <span className="muted"> (partial)</span>}
                  </td>
                  <td className="mono">{Math.round(wh.get('pv') ?? 0).toLocaleString()} Wh</td>
                  <td className="mono">
                    {Math.round(wh.get('input') ?? 0).toLocaleString()} Wh
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {pvSeries && pvSeries.points.length > 0 && (
        <Chart
          title="PV energy accumulated today (Wh, resets at local midnight)"
          data={cumulative(pvSeries)}
          range={range}
        />
      )}

      {CHART_REGS.map((def) => {
        const series = byAddr.get(def.addr);
        if (!series || series.points.length === 0) return null;
        const title = def.unit ? `${def.label} (${def.unit})` : def.label;
        return <Chart key={def.key} title={title} data={toPlotData(def, series)} range={range} />;
      })}
    </div>
  );
}
