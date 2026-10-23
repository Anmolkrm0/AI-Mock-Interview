"use client";

import { cn } from "@/lib/utils";

export interface Choice<T extends string | number> {
  value: T;
  label: string;
  description?: string;
}

/** Radio group with large, keyboard-accessible options (native inputs). */
export function ChoiceGroup<T extends string | number>({
  name,
  legend,
  choices,
  value,
  onChange,
  columns = 1,
  error,
}: {
  name: string;
  legend: string;
  choices: Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  columns?: 1 | 2 | 3 | 4;
  error?: string;
}) {
  return (
    <fieldset aria-invalid={!!error || undefined}>
      <legend className="mb-3 text-sm font-medium">{legend}</legend>
      <div
        className={cn(
          "grid gap-2.5",
          columns === 2 && "sm:grid-cols-2",
          columns === 3 && "sm:grid-cols-3",
          columns === 4 && "grid-cols-2 sm:grid-cols-4",
        )}
      >
        {choices.map((c) => {
          const id = `${name}-${c.value}`;
          const checked = value === c.value;
          return (
            <label
              key={String(c.value)}
              htmlFor={id}
              className={cn(
                "relative flex cursor-pointer flex-col rounded-md border bg-surface px-4 py-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ink",
                checked
                  ? "border-ink shadow-[inset_0_0_0_1px_var(--color-ink)]"
                  : "border-line-strong hover:border-slate",
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(c.value)}
              />
              <span className="font-medium">{c.label}</span>
              {c.description && <span className="mt-0.5 text-sm text-slate">{c.description}</span>}
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-signal">
          {error}
        </p>
      )}
    </fieldset>
  );
}
