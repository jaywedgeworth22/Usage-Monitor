"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  href: string;
  keywords?: string;
}

const STATIC_COMMANDS: CommandItem[] = [
  { id: "overview", label: "Overview", hint: "Dashboard", href: "/", keywords: "home dashboard" },
  { id: "attribution", label: "Keys & apps", hint: "Attribution", href: "/attribution", keywords: "keys attribution project" },
  { id: "settings", label: "Settings", href: "/settings", keywords: "config" },
  { id: "connections", label: "Connections", hint: "Settings", href: "/settings?tab=connections", keywords: "providers" },
  { id: "services", label: "Paid services", hint: "Settings", href: "/settings?tab=services", keywords: "subscriptions billing" },
  { id: "projects", label: "Projects", hint: "Settings", href: "/settings?tab=projects", keywords: "budgets" },
  { id: "notifications", label: "Notifications", hint: "Settings", href: "/settings?tab=notifications", keywords: "alerts slack" },
  { id: "attention", label: "Attention", hint: "Open alerts", href: "/#attention", keywords: "alerts critical" },
  { id: "providers-section", label: "Provider workspace", href: "/#providers", keywords: "table families" },
  { id: "portfolio", label: "Portfolio detail", href: "/#portfolio", keywords: "charts telemetry burn" },
  { id: "ops", label: "Operations", href: "/#operations", keywords: "health sentry receipt" },
];

/**
 * ⌘K / Ctrl+K command palette for quick navigation.
 * Provider rows can be injected so operators jump straight to a detail page.
 */
export default function CommandPalette({
  providerItems = [],
}: {
  providerItems?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const providerCmds: CommandItem[] = providerItems.map((p) => ({
      id: `provider-${p.id}`,
      label: p.label,
      hint: "Provider",
      href: `/providers/${p.id}`,
      keywords: "provider",
    }));
    const all = [...STATIC_COMMANDS, ...providerCmds];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 40);
    return all
      .filter((item) => {
        const hay = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 40);
  }, [providerItems, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const run = useCallback(
    (item: CommandItem) => {
      setOpen(false);
      if (item.href.startsWith("/#")) {
        const id = item.href.slice(2);
        if (window.location.pathname === "/") {
          document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
      router.push(item.href);
    },
    [router]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-800">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to… providers, settings, alerts"
            className="w-full min-h-11 rounded-lg border-0 bg-transparent px-2 text-base text-gray-900 outline-none placeholder:text-gray-400 focus:ring-0 dark:text-gray-100"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && items[active]) {
                e.preventDefault();
                run(items[active]);
              }
            }}
          />
        </div>
        <ul className="max-h-80 overflow-y-auto py-1" role="listbox">
          {items.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-gray-500">No matches</li>
          )}
          {items.map((item, index) => (
            <li key={item.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${
                  index === active
                    ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100"
                    : "text-gray-800 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(item)}
              >
                <span className="font-medium">{item.label}</span>
                {item.hint && (
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <kbd className="rounded border border-gray-200 px-1 dark:border-gray-600">↑↓</kbd> navigate
          {" · "}
          <kbd className="rounded border border-gray-200 px-1 dark:border-gray-600">↵</kbd> open
          {" · "}
          <kbd className="rounded border border-gray-200 px-1 dark:border-gray-600">esc</kbd> close
        </div>
      </div>
    </div>
  );
}
