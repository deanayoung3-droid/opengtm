"use client";

import { useFormStatus } from "react-dom";

/** Submit button that asks for confirmation and shows pending state. */
export function ConfirmButton({
  children,
  confirm,
  className,
  name,
  value,
  formAction,
}: {
  children: React.ReactNode;
  confirm?: string;
  className?: string;
  name?: string;
  value?: string;
  formAction?: (fd: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      name={name}
      value={value}
      formAction={formAction}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Working..." : children}
    </button>
  );
}
