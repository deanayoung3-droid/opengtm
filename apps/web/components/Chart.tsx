"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** c1-c4: one color per series (campaigns); prev: the period before, drawn quiet behind the current one. */
export type Series = { name: string; values: number[]; color: "c1" | "c2" | "c3" | "c4" | "c5" | "prev" };
type Format = "int" | "usd";

const usdDigits = (v: number, compact: boolean) => (v === 0 || v >= (compact ? 10 : 100) ? 0 : v >= 1 && compact ? 1 : 2);
const fmt = (v: number, f: Format, compact = false) =>
  f === "usd"
    ? v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: usdDigits(v, compact), maximumFractionDigits: usdDigits(v, compact) })
    : compact && v >= 1000
      ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}K`
      : Math.round(v).toLocaleString("en-US");

/** A clean upper bound for the y-axis (1, 2, 5 × 10^n). */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const PAD = { top: 8, right: 4, bottom: 22, left: 30 };

/** A smooth line through the points that never overshoots them (monotone cubic, Fritsch-Carlson). */
function smooth(pts: (readonly [number, number])[]): string {
  const n = pts.length;
  if (n < 3) return pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
  const dx = pts.slice(1).map(([px], i) => px - pts[i]![0]);
  const m = pts.slice(1).map(([, py], i) => (py - pts[i]![1]) / (dx[i] || 1));
  const t = pts.map((_, i) => (i === 0 ? m[0]! : i === n - 1 ? m[n - 2]! : m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]!; t[i + 1] = k * b * m[i]!; }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!, h = dx[i]! / 3;
    d += ` C${x0 + h},${y0 + t[i]! * h} ${x1 - h},${y1 - t[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

/**
 * Animated mini chart for the dashboard: stacked columns or an area line, with a hover tooltip.
 * Columns grow from the baseline and the line draws itself on load; both respect reduced motion.
 */
export function Chart({ labels, series, kind, format = "int", fullLabels, height: H = 132 }: { labels: string[]; series: Series[]; kind: "columns" | "area" | "lines"; format?: Format; fullLabels?: string[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const gid = useId().replace(/:/g, "");

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const peak = Math.max(...(kind === "columns" ? totals : series.flatMap((s) => s.values)));
  // Counts get whole-number ticks (0, 1, 2 at least); money can be fractional.
  const max = format === "int" ? Math.max(2, Math.ceil(niceMax(peak) / 2) * 2) : niceMax(peak);
  const iw = Math.max(0, w - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom;
  const band = n ? iw / n : 0;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const empty = totals.every((t) => t === 0);
  const every = n > 14 ? Math.ceil(n / 7) : 1;

  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.left) / band);
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div className={`chart${shown ? " in" : ""}${hover !== null ? " hovering" : ""}`} style={{ height: H }} ref={box} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${series.map((s) => s.name).join(" and ")} per day`}>
          <defs>
            {(["c1", "c2"] as const).map((c) => (
              <linearGradient key={c} id={`${gid}-${c}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className={`stop-${c}`} stopOpacity={0.22} />
                <stop offset="100%" className={`stop-${c}`} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "grid" : "grid mid"} />
              <text x={PAD.left - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {fmt(t, format, true)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 || i === n - 1 ? (
              <text key={i} x={x(i)} y={H - 6} className={`tick${hover === i ? " on" : ""}`} textAnchor="middle">
                {l}
              </text>
            ) : null,
          )}
          {hover !== null && kind === "columns" && <rect x={PAD.left + band * hover} y={PAD.top} width={band} height={ih} rx={6} className="hover-band" />}
          {hover !== null && kind !== "columns" && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} className="cross" />}

          {kind === "columns" &&
            labels.map((_, i) => {
              const bw = Math.min(H > 160 ? 22 : 18, band * 0.56);
              let base = y(0);
              return (
                <g key={i} className={`col${hover === i ? " on" : ""}`} style={{ animationDelay: `${i * (300 / n)}ms` }}>
                  {series.map((s, k) => {
                    const v = s.values[i] ?? 0;
                    if (!v) return null;
                    const gap = base < y(0) ? 2 : 0; // surface gap between stacked segments
                    const yb = base - gap;
                    const h = Math.max(2, y(0) - y(v));
                    const isTop = series.slice(k + 1).every((t) => !(t.values[i] ?? 0));
                    const r = isTop ? Math.min(6, h, bw / 2) : 0;
                    const x0 = x(i) - bw / 2;
                    const d = `M${x0},${yb} V${yb - h + r} Q${x0},${yb - h} ${x0 + r},${yb - h} H${x0 + bw - r} Q${x0 + bw},${yb - h} ${x0 + bw},${yb - h + r} V${yb} Z`;
                    base = yb - h;
                    return <path key={s.name} d={d} className={`fill-${s.color}`} />;
                  })}
                </g>
              );
            })}

          {kind !== "columns" &&
            series.map((s) => {
              const pts = s.values.map((v, i) => [x(i), y(v)] as const);
              const line = smooth(pts);
              const area = `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
              const last = pts.at(-1);
              return (
                <g key={s.name}>
                  {!empty && kind === "area" && <path d={area} className="area" fill={`url(#${gid}-${s.color})`} />}
                  {!empty && <path d={line} pathLength={1} className={`line stroke-${s.color}`} />}
                  {last && !empty && hover === null && kind === "area" && <circle cx={last[0]} cy={last[1]} r={4} className={`dot fill-${s.color}`} />}
                  {hover !== null && pts[hover] && <circle cx={pts[hover]![0]} cy={pts[hover]![1]} r={4} className={`dot fill-${s.color}`} />}
                </g>
              );
            })}
        </svg>
      )}
      {empty && <div className="chart-empty">No activity yet</div>}
      {hover !== null && w > 0 && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover), 70), w - 70) }}>
          <div className="t">{fullLabels?.[hover] ?? labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="r">
              <span className={`key bg-${s.color}`} />
              <b>{fmt(s.values[hover] ?? 0, format)}</b> {s.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DIGITS = "0123456789".split("");

/**
 * The number rolls into place like an odometer: every digit spins up from 0, the left ones a beat later.
 * Screen readers get the plain value; reduced motion shows it at once (the CSS drops the transition).
 */
export function CountUp({ value, format = "int" }: { value: number; format?: Format | "pct" }) {
  const text = format === "pct" ? `${value.toFixed(1)}%` : fmt(value, format);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const chars = text.split("");
  const digitCount = chars.filter((c) => c >= "0" && c <= "9").length;
  let seen = 0;
  return (
    <span className="countup roll" aria-label={text}>
      {chars.map((c, i) => {
        if (c < "0" || c > "9") return <span key={i} aria-hidden>{c}</span>;
        const order = seen++;
        return (
          <span key={i} className="roll-d" aria-hidden>
            <span style={{ transform: `translateY(-${(shown ? Number(c) : 0) * 10}%)`, transitionDelay: `${(digitCount - 1 - order) * 60}ms` }}>
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** A tiny trend line for a KPI (no axes; the number beside it carries the value). Flat and quiet when empty. */
export function Sparkline({ values, color = "c1", label }: { values: number[]; color?: "c1" | "c2" | "hot" | "good" | "bad" | "flat"; label: string }) {
  const gid = useId().replace(/:/g, "");
  const W = 100;
  const H = 28;
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * W : W / 2, H - 2 - ((v - lo) / span) * (H - 4)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join(" ");
  const flat = hi === lo;
  return (
    <svg className={`spark spark-${color}${flat ? " flat" : ""}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${gid}-s`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopOpacity={0.2} />
          <stop offset="100%" stopOpacity={0} />
        </linearGradient>
      </defs>
      {!flat && <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${gid}-s)`} className="spark-area" />}
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A row of tiny day bars beside a KPI: the latest day is ink, the rest quiet (no axes; the number carries the value). */
export function BarSpark({ values, label }: { values: number[]; label: string }) {
  const hi = Math.max(...values, 0);
  const W = 64;
  const H = 30;
  const n = values.length;
  const gap = n > 14 ? 1 : 2;
  const bw = Math.max(1.5, (W - gap * (n - 1)) / n);
  return (
    <svg className="barspark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = hi ? Math.max(3, (v / hi) * H) : 3;
        return <rect key={i} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(1.5, bw / 2)} className={i === n - 1 ? "now" : ""} style={{ animationDelay: `${i * 25}ms` }} />;
      })}
    </svg>
  );
}

