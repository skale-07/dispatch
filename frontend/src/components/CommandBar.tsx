import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/client";
import type { ApplicationsPage } from "../api/types";
import { Icon, type IconName } from "./Icon";
import { AnimatePresence, arriveAndDepart, m } from "./Animated";
import useDebounce from "@/hooks/use-debounce";

/**
 * U4: type-to-jump. Interaction design ported from KokonutUI's
 * action-search-bar (debounced filter, arrow-key navigation, animated
 * dropdown) and rebuilt first-party: house icons instead of lucide,
 * token classes instead of the stock palette, and REAL actions — pages
 * plus a live application search — instead of demo rows. `/` focuses it
 * from anywhere (never swallowing typing or the editor's undo keys).
 */

type Command = {
  id: string;
  label: string;
  detail: string;
  icon: IconName;
  to: string;
};

const PAGE_COMMANDS: Command[] = [
  { id: "p-review", label: "Needs you", detail: "review queue", icon: "inbox", to: "/review" },
  { id: "p-apps", label: "Applications", detail: "every application", icon: "file", to: "/applications" },
  { id: "p-outreach", label: "Outreach", detail: "apply yourself, drafts only", icon: "mail", to: "/outreach" },
  { id: "p-insights", label: "Insights", detail: "charts over the run history", icon: "sparkle", to: "/insights" },
  { id: "p-runs", label: "Runs", detail: "live and past runs", icon: "play", to: "/runs" },
  { id: "p-enqueue", label: "Enqueue", detail: "paste a job in", icon: "arrow-right", to: "/enqueue" },
  { id: "p-settings", label: "Settings", detail: "flags and ceilings", icon: "clock", to: "/settings" },
];

export function CommandBar(): JSX.Element {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [appHits, setAppHits] = useState<Command[]>([]);
  const debounced = useDebounce(query, 200);

  // "/" from anywhere focuses the bar — but never while the user is
  // already typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t?.isContentEditable ?? false);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live application search rides the existing read API; empty query
  // costs nothing.
  useEffect(() => {
    let live = true;
    if (!debounced.trim()) {
      setAppHits([]);
      return;
    }
    apiGet<ApplicationsPage>(
      `/api/applications?q=${encodeURIComponent(debounced.trim())}&limit=6`,
    )
      .then((page) => {
        if (!live) return;
        setAppHits(
          page.rows.slice(0, 6).map((row) => ({
            id: `a-${row.id}`,
            label: `${row.company ?? "Unknown company"} — ${row.role ?? "Unknown role"}`,
            detail: row.state.toLowerCase().replace(/_/g, " "),
            icon: "file" as const,
            to: `/applications/${row.id}`,
          })),
        );
      })
      .catch(() => {
        if (live) setAppHits([]);
      });
    return () => {
      live = false;
    };
  }, [debounced]);

  const commands = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    const pages = q
      ? PAGE_COMMANDS.filter((c) =>
          `${c.label} ${c.detail}`.toLowerCase().includes(q),
        )
      : PAGE_COMMANDS;
    return [...appHits, ...pages].slice(0, 10);
  }, [debounced, appHits]);

  const go = useCallback(
    (cmd: Command): void => {
      navigate(cmd.to);
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [navigate],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open || commands.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((p) => (p < commands.length - 1 ? p + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((p) => (p > 0 ? p - 1 : commands.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = commands[active >= 0 ? active : 0];
      if (cmd) go(cmd);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="command-bar">
      <div className="command-bar-box">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to…  ( / )"
          aria-label="Jump to a page or application"
          role="combobox"
          aria-expanded={open && commands.length > 0}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
      </div>
      <AnimatePresence initial={false}>
        {open && commands.length > 0 ? (
          <m.ul className="command-bar-list" {...arriveAndDepart}>
            {commands.map((cmd, i) => (
              <li key={cmd.id}>
                <button
                  type="button"
                  className={i === active ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(cmd);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <Icon name={cmd.icon} size={13} />
                  <span className="command-label">{cmd.label}</span>
                  <span className="command-detail">{cmd.detail}</span>
                </button>
              </li>
            ))}
          </m.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
