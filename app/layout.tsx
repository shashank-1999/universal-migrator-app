export const metadata = { title: "Universal Migrator (MVP)" };

import Header from "./components/Header";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <div style={{ padding: 16 }}>{children}</div>
      </body>
    </html>
  );
}