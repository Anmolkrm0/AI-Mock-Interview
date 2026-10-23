import { AppHeader } from "@/components/common/app-header";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader />
      {children}
    </>
  );
}
