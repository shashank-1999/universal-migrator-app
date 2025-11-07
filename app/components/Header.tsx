"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";



export default function Header() {
  const pathname = usePathname() || "/";
  const showLinks = pathname !== "/";

  return (
    <div style={{ padding: 12, borderBottom: "1px solid #eee", display: "flex", gap: 12 }}>
      <Link
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700 }}
        aria-label="Home"
        title="Home"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M3 10.5L12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10.5z" fill="#111827" />
        </svg>
      </Link>

      {showLinks && (
        <>
          <Link href="/workflow">Workflow</Link>
          <Link href="/logs">Logs</Link>
          <Link href="/scheduling">Scheduling</Link>
        </>
      )}
    </div>
  );
}
