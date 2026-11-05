"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * A segmented control (time range, inbox views, theme) whose white pill slides to the chosen option
 * instead of jumping. Options stay whatever the page passes in (links or buttons); the one with
 * `className="on"` is chosen. Before JS runs, that option's own `.on` styling shows the choice.
 */
export function Segmented({ as: Tag = "div", className, children, ...rest }: { as?: "div" | "nav"; className: string; children: React.ReactNode } & React.AriaAttributes & { role?: string }) {
  const box = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const [glide, setGlide] = useState<"instant" | "on" | undefined>(undefined);

  // Runs after every render: a navigation or click moves `.on`, and the pill follows it.
  useLayoutEffect(() => {
    const el = box.current;
    const p = pill.current;
    if (!el || !p) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(":scope > .on");
      if (!on) return setGlide(undefined);
      p.style.width = `${on.offsetWidth}px`;
      p.style.height = `${on.offsetHeight}px`;
      p.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      setGlide((g) => g ?? "instant");
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  });
  // The first placement doesn't animate; later moves do.
  useLayoutEffect(() => {
    if (glide !== "instant") return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGlide("on")));
    return () => cancelAnimationFrame(id);
  }, [glide]);

  return (
    <Tag ref={box as React.Ref<HTMLDivElement>} className={className} data-glide={glide} {...rest}>
      {children}
      <span className="glide-pill" ref={pill} aria-hidden />
    </Tag>
  );
}
