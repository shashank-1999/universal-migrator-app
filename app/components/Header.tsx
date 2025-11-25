"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Header.module.css";

const NAV_ITEMS = [
  { href: "/workflow", label: "Workflow" },
  { href: "/logs", label: "Logs" },
  { href: "/scheduling", label: "Scheduling" },
  { href: "/query", label: "Query" },
];

export default function Header() {
  const pathname = usePathname() || "/";

  return (
    <header className={styles.shell}>
      <Link href="/" className={styles.brand}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" role="img" aria-hidden="true">
          <path
            d="M3 10.5L12 4l9 6.5v8.5c0 .55-.45 1-1 1h-5v-6H9v6H4c-.55 0-1-.45-1-1V10.5z"
            fill="url(#brandGrad)"
          />
          <defs>
            <linearGradient id="brandGrad" x1="3" y1="4" x2="21" y2="19" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4f46e5" />
              <stop offset="1" stopColor="#14b8a6" />
            </linearGradient>
          </defs>
        </svg>
        Universal Migrator
      </Link>

      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${active ? styles.active : ""}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
