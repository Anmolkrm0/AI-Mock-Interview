import { Wordmark } from "@/components/common/site-header-client";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto w-full max-w-6xl px-5 py-5 sm:px-8">
        <Wordmark />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-5 pb-16 pt-6 sm:pt-16">
        <div className="w-full max-w-md">
          <h1 className="text-4xl font-semibold">{title}</h1>
          <p className="mt-3 text-slate">{subtitle}</p>
          <div className="mt-8 rounded-lg border border-line bg-surface p-6 sm:p-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
