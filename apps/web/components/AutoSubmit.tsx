"use client";

/** A select that applies its filter as soon as it changes (no separate Filter button). */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}

/** A toggle that saves as soon as it is flipped. */
export function AutoSubmitToggle(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" role="switch" className="switch" {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}

/** A text field that saves when you leave it (or press Enter), only if it changed. */
export function AutoSubmitInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      onBlur={(e) => {
        if (e.currentTarget.value !== String(props.defaultValue ?? "")) e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
