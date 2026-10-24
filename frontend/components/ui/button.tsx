import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-white hover:bg-ink-soft",
        secondary: "bg-surface text-ink border border-line-strong hover:border-ink",
        ghost: "text-ink hover:bg-line/60",
        danger: "bg-signal text-white hover:bg-signal/90",
        link: "text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink px-0",
      },
      size: {
        sm: "min-h-[44px] sm:min-h-9 h-auto py-2 sm:py-0 sm:h-9 rounded-sm px-3 text-sm",
        md: "h-11 rounded-md px-5 text-[15px]",
        lg: "h-13 rounded-md px-7 text-base",
        icon: "size-11 rounded-md",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
