export const metadata = { title: "Universal Migrator (MVP)" };

import "@/lib/scheduleRunner";
import Header from "./components/Header";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-shell">
        <Header />
        <main className="page-wrapper">{children}</main>
      </body>
    </html>
  );
}
