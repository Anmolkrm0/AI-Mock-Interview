"use client";

import { FileUp } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { validateDocumentFile } from "@/lib/validation";

export function FileDrop({
  label,
  hint,
  disabled,
  onFile,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept(file: File | undefined) {
    if (!file) return;
    const problem = validateDocumentFile(file);
    setError(problem);
    if (!problem) onFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) accept(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-9 text-center transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ink",
          dragging ? "border-ink bg-paper" : "border-line-strong bg-surface hover:border-slate",
          disabled && "pointer-events-none opacity-60",
        )}
      >
        <FileUp className="size-6 text-slate" aria-hidden />
        <span className="font-medium">{label}</span>
        <span className="text-sm text-slate">{hint}</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          disabled={disabled}
          onChange={(e) => accept(e.target.files?.[0])}
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-signal">
          {error}
        </p>
      )}
    </div>
  );
}
