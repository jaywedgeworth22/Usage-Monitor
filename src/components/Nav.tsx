"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, Search, Sun } from "lucide-react";
import { setStoredDisplayDensity, useDisplayDensity } from "@/lib/display-density";
import CommandPalette from "@/components/CommandPalette";

type NavLink = { href: string; label: string };

const PRIMARY_LINKS: NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/providers", label: "Providers" },
  { href: "/money", label: "Money" },
  { href: "/projects", label: "Projects" },
  { href: "/alerts", label: "Alerts" },
  { href: "/ops", label: "Ops" },
  { href: "/settings", label: "Settings" },
];

const SECONDARY_LINKS: NavLink[] = [{ href: "/attribution", label: "Keys & apps" }];

function isLinkActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);

  const { theme, setTheme } = useTheme();
  const density = useDisplayDensity();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [moreOpen]);

  const handleLogout = async () => {
    setLogoutPending(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Log out failed");
      }
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Log out failed");
    } finally {
      setLogoutPending(false);
    }
  };

  if (pathname === "/login" || pathname.startsWith("/login/")) return null;

  const secondaryActive = SECONDARY_LINKS.some((link) => isLinkActive(pathname, link.href));
  const mobileLinks = [...PRIMARY_LINKS, ...SECONDARY_LINKS];

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="sticky top-0 z-50 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex min-w-0 items-center gap-3 lg:gap-6">
              <Link href="/" className="flex shrink-0 items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600">
                  <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <span className="hidden text-lg font-semibold text-gray-900 dark:text-gray-100 sm:inline">
                  Usage Monitor
                </span>
              </Link>
              <div className="hidden items-center gap-0.5 md:flex">
                {PRIMARY_LINKS.map((link) => {
                  const isActive = isLinkActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`rounded-md px-2.5 py-2 text-sm font-medium transition-colors lg:px-3 ${
                        isActive
                          ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                      }`}
                    >
                      {link.label}
                    </Link>
                  );
                })}
                <div className="relative" ref={moreRef}>
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    aria-haspopup="menu"
                    onClick={() => setMoreOpen((v) => !v)}
                    className={`rounded-md px-2.5 py-2 text-sm font-medium transition-colors lg:px-3 ${
                      secondaryActive || moreOpen
                        ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    More
                    <span className="ml-1 text-[10px] opacity-70" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {moreOpen && (
                    <div
                      role="menu"
                      className="absolute left-0 top-full z-50 mt-1 min-w-[10rem] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
                    >
                      {SECONDARY_LINKS.map((link) => {
                        const isActive = isLinkActive(pathname, link.href);
                        return (
                          <Link
                            key={link.href}
                            role="menuitem"
                            href={link.href}
                            onClick={() => setMoreOpen(false)}
                            aria-current={isActive ? "page" : undefined}
                            className={`block px-3 py-2 text-sm ${
                              isActive
                                ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                                : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                            }`}
                          >
                            {link.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="hidden items-center gap-3 md:flex">
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                aria-label="Open command palette"
                title="Command palette (⌘K)"
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-gray-600 hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <Search size={16} aria-hidden="true" />
                <kbd className="hidden rounded border border-gray-200 px-1 text-[10px] font-medium text-gray-500 dark:border-gray-600 dark:text-gray-400 xl:inline">
                  ⌘K
                </kbd>
              </button>
              {mounted && (
                <>
                  <div
                    className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                    role="group"
                    aria-label="Theme selector"
                  >
                    {(["light", "dark", "system"] as const).map((t) => {
                      const active = theme === t;
                      const Icon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
                      const label = t.charAt(0).toUpperCase() + t.slice(1);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTheme(t)}
                          aria-pressed={active}
                          title={`Set theme to ${label}`}
                          aria-label={`Set theme to ${label}`}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                            active
                              ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                              : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                          }`}
                        >
                          <Icon size={13} />
                          <span className="hidden lg:inline">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div
                    className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                    role="group"
                    aria-label="Display density selector"
                  >
                    {(["compact", "comfortable"] as const).map((d) => {
                      const active = density === d;
                      const label = d === "compact" ? "Compact" : "Comfortable";
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setStoredDisplayDensity(d)}
                          aria-pressed={active}
                          title={`Set display density to ${label}`}
                          aria-label={`Set display density to ${label}`}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                            active
                              ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                              : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {logoutError && (
                <span role="alert" className="max-w-48 text-xs text-red-600 dark:text-red-300">
                  {logoutError}
                </span>
              )}
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutPending}
                className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                {logoutPending ? "Logging out…" : "Log out"}
              </button>
            </div>

            <div className="flex items-center gap-1 md:hidden">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setCommandOpen(true);
                }}
                aria-label="Open command palette"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <Search className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-expanded={menuOpen}
                aria-controls="mobile-navigation"
                aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={menuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"}
                  />
                </svg>
              </button>
            </div>
          </div>

          {menuOpen && (
            <div
              id="mobile-navigation"
              className="space-y-2 border-t border-gray-200 py-3 dark:border-gray-800 md:hidden"
            >
              {mobileLinks.map((link) => {
                const isActive = isLinkActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    aria-current={isActive ? "page" : undefined}
                    className={`block min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium ${
                      isActive
                        ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <div className="space-y-2 px-3 py-2">
                {mounted && (
                  <>
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Theme</div>
                    <div
                      className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                      role="group"
                      aria-label="Theme selector"
                    >
                      {(["light", "dark", "system"] as const).map((t) => {
                        const active = theme === t;
                        const Icon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
                        const label = t.charAt(0).toUpperCase() + t.slice(1);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setTheme(t)}
                            aria-pressed={active}
                            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            }`}
                          >
                            <Icon size={14} />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Density</div>
                    <div
                      className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                      role="group"
                      aria-label="Display density selector"
                    >
                      {(["compact", "comfortable"] as const).map((d) => {
                        const active = density === d;
                        const label = d === "compact" ? "Compact" : "Comfortable";
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setStoredDisplayDensity(d)}
                            aria-pressed={active}
                            className={`min-h-11 flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutPending}
                className="block min-h-11 w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                {logoutPending ? "Logging out…" : "Log out"}
              </button>
              {logoutError && (
                <p role="alert" className="px-3 py-1 text-xs text-red-600 dark:text-red-300">
                  {logoutError}
                </p>
              )}
            </div>
          )}
        </div>
      </nav>
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </>
  );
}
