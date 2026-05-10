import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, useLocation } from "wouter";
import {
  ShoppingBag,
  LogOut,
  Menu,
  X,
  ChevronRight,
  Search,
  Globe,
  AlertTriangle,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Star,
  StarOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "@/components/CommandPalette";
import { GlobalSearch } from "@/components/GlobalSearch";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useLanguage } from "@/lib/useLanguage";
import { useAdminAuth } from "@/lib/adminAuthContext";
import { safeLocalGet, safeLocalSet } from "@/lib/safeStorage";
import { tDual, type TranslationKey, LANGUAGE_OPTIONS } from "@workspace/i18n";
import { io, type Socket } from "socket.io-client";
import { adminFetch } from "@/lib/adminFetcher";
import { getAdminTiming } from "@/lib/adminTiming";
import { lockBodyScroll } from "@/lib/domSafety";
import {
  NAV_GROUPS,
  NAV_DESCRIPTIONS,
  BOTTOM_NAV,
  NAV_ITEMS as navItems,
  isActivePath,
  readFavorites,
  writeFavorites,
} from "@/lib/navConfig";
import { StockNotificationBell } from "@/components/StockNotificationBell";

// NAV_GROUPS, NAV_DESCRIPTIONS, BOTTOM_NAV and navItems are imported from
// `@/lib/navConfig` so the command palette, breadcrumbs and any future
// favorites/pinned UI all read from one source of truth.

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { state, logout } = useAdminAuth();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => safeLocalGet("ajkmart_sidebar_collapsed") === "true");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [cmdHintVisible, setCmdHintVisible] = useState(() => safeLocalGet("cmd_palette_hinted") !== "true");
  const cmdHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { language, setLanguage, loading: langLoading } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const globalSearchRef = useRef<HTMLInputElement>(null);

  useKeyboardShortcuts({
    onOpenSearch: () => { globalSearchRef.current?.focus(); },
    onCloseModal: () => { setIsMobileMenuOpen(false); setUserMenuOpen(false); setLangOpen(false); window.dispatchEvent(new CustomEvent("admin:close-modal")); },
    onNewItem: () => { window.dispatchEvent(new CustomEvent("admin:new-item")); },
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const active = NAV_GROUPS.find(g => g.items.some(i => isActivePath(location, i.href)));
    return new Set(active ? [active.key] : [NAV_GROUPS[0]!.key]);
  });

  // In-sidebar text filter — narrows the visible nav items as the admin types.
  // Independent from the Cmd+K command palette which still does cross-action search.
  const [navFilter, setNavFilter] = useState("");
  const navFilterTrim = navFilter.trim().toLowerCase();

  // Pinned favorites — persisted as comma-joined hrefs in localStorage.
  // Star icon next to each item toggles membership; pinned items render at the
  // top of the sidebar above the group list for one-click access.
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites(safeLocalGet));
  const toggleFavorite = useCallback((href: string) => {
    setFavorites(prev => {
      const next = prev.includes(href) ? prev.filter(h => h !== href) : [...prev, href];
      writeFavorites(safeLocalSet, next);
      return next;
    });
  }, []);

  const [sosCount, setSosCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [pendingRidersCount, setPendingRidersCount] = useState(0);
  const [pendingOrdersCount, setPendingOrdersCount] = useState(0);
  const [pendingWithdrawalsCount, setPendingWithdrawalsCount] = useState(0);
  const [pendingDepositsCount, setPendingDepositsCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      // Failures are logged inside safeLocalSet under [safeStorage]; we
      // intentionally still flip the in-memory state even if persistence
      // fails so the admin's click is never ignored.
      safeLocalSet("ajkmart_sidebar_collapsed", String(next));
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 4-second auto-dismiss for ⌘K hint
  useEffect(() => {
    if (!cmdHintVisible) return;
    cmdHintTimerRef.current = setTimeout(() => {
      setCmdHintVisible(false);
      safeLocalSet("cmd_palette_hinted", "true");
    }, 4000);
    return () => { if (cmdHintTimerRef.current) clearTimeout(cmdHintTimerRef.current); };
  }, [cmdHintVisible]);

  // Socket + data fetching
  useEffect(() => {
    adminFetch("/sos/alerts?limit=1")
      .then((data: { activeCount?: number }) => { if (typeof data.activeCount === "number") setSosCount(data.activeCount); })
      .catch((err) => { console.error("[AdminLayout] SOS badge fetch failed:", err); });

    adminFetch("/error-reports/new-count")
      .then((data: { count?: number }) => { if (typeof data.count === "number") setErrorCount(data.count); })
      .catch((err) => { console.error("[AdminLayout] Error count fetch failed:", err); });

    // Fetch all pending badge counts in one round-trip
    const fetchPendingCounts = () => {
      adminFetch("/pending-counts")
        .then((data: { pendingRiders?: number; pendingOrders?: number; pendingWithdrawals?: number; pendingDeposits?: number }) => {
          if (typeof data.pendingRiders === "number") setPendingRidersCount(data.pendingRiders);
          if (typeof data.pendingOrders === "number") setPendingOrdersCount(data.pendingOrders);
          if (typeof data.pendingWithdrawals === "number") setPendingWithdrawalsCount(data.pendingWithdrawals);
          if (typeof data.pendingDeposits === "number") setPendingDepositsCount(data.pendingDeposits);
        })
        .catch((err) => { console.error("[AdminLayout] Pending counts fetch failed:", err); });
    };
    fetchPendingCounts();

    const errorInterval = setInterval(() => {
      adminFetch("/error-reports/new-count")
        .then((data: { count?: number }) => { if (typeof data.count === "number") setErrorCount(data.count); })
        .catch((err) => { console.error("[AdminLayout] Error count interval fetch failed:", err); });
    }, getAdminTiming().layoutErrorPollIntervalMs);
    const cleanupErrorInterval = () => clearInterval(errorInterval);

    // Socket uses in-memory access token from adminAuthContext
    const socket = io(window.location.origin, {
      path: "/api/socket.io",
      query: { rooms: "admin-fleet" },
      auth: (cb: (data: Record<string, string>) => void) => cb({ token: state.accessToken || "" }),
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;
    socket.on("connect", () => socket.emit("join", "admin-fleet"));
    socket.on("sos:new", () => {
      setSosCount(c => c + 1);
      if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
    });
    socket.on("sos:resolved", () => setSosCount(c => Math.max(0, c - 1)));

    // Pending orders: increment on new order, refresh on any status update
    socket.on("order:new", (data: { status?: string }) => {
      if (!data || data.status === "pending") setPendingOrdersCount(c => c + 1);
    });
    socket.on("order:update", (data: { status?: string }) => {
      // When an order leaves pending state, decrement; re-fetch to stay accurate
      if (data?.status && data.status !== "pending") {
        fetchPendingCounts();
      }
    });

    // Pending rider approvals: any rider status change → refresh
    socket.on("rider:status", () => { fetchPendingCounts(); });

    // Pending withdrawals/deposits: refresh when one is approved/rejected
    socket.on("wallet:deposit-approved", () => { fetchPendingCounts(); });
    socket.on("wallet:withdrawal-approved", () => { fetchPendingCounts(); });
    socket.on("wallet:withdrawal-rejected", () => { fetchPendingCounts(); });

    return () => { socket.disconnect(); socketRef.current = null; cleanupErrorInterval(); };
  }, [state.accessToken]);

  useEffect(() => {
    setIsMobileMenuOpen(false);
    const active = NAV_GROUPS.find(g => g.items.some(i => isActivePath(location, i.href)));
    if (active) {
      setExpandedGroups(prev => {
        if (prev.has(active.key)) return prev;
        const next = new Set(prev);
        next.add(active.key);
        return next;
      });
    }

    // Restore sidebar scroll position and scroll active item into view
    if (sidebarScrollRef.current) {
      const scrollKey = `sidebar_scroll_${location}`;
      const savedScroll = sessionStorage.getItem(scrollKey);
      if (savedScroll) {
        const scrollPos = parseInt(savedScroll, 10);
        setTimeout(() => {
          if (sidebarScrollRef.current) {
            sidebarScrollRef.current.scrollTop = scrollPos;
          }
        }, 0);
      } else {
        // If no saved position, scroll active item into view
        setTimeout(() => {
          if (sidebarScrollRef.current) {
            const activeElement = sidebarScrollRef.current.querySelector('[data-sidebar-active="true"]');
            if (activeElement) {
              activeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        }, 50);
      }
    }
  }, [location]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setCmdOpen(o => !o); }
      if (e.key === "Escape" && isMobileMenuOpen) setIsMobileMenuOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMobileMenuOpen]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const release = lockBodyScroll();
    return release;
  }, [isMobileMenuOpen]);

  /* Focus trap for mobile nav drawer — WCAG 2.1.2 / 2.4.3 */
  useEffect(() => {
    if (!isMobileMenuOpen || !mobileDrawerRef.current) return;
    const drawer = mobileDrawerRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    /* Move focus to first focusable item in drawer */
    const first = drawer.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const trapTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      } else {
        if (document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };

    document.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("keydown", trapTab);
      /* Restore focus to trigger element on drawer close */
      previousFocus?.focus?.();
    };
  }, [isMobileMenuOpen]);

  const handleLogout = async () => {
    await logout();
    setLocation("/login");
  };

  const isActive = (href: string) => isActivePath(location, href);

  const currentItem = navItems.find(i => isActive(i.href));
  const currentPageName = currentItem ? T(currentItem.nameKey) : "AJKMart Admin";
  const currentLangLabel = LANGUAGE_OPTIONS.find(o => o.value === language)?.label || language.toUpperCase();

  const sidebarWidth = collapsed ? 72 : 264;

  const SidebarContent = ({ mini, isMobile }: { mini?: boolean; isMobile?: boolean }) => (
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
    <div
      className="flex flex-col h-full select-none"
      style={{
        width: isMobile ? 280 : mini ? 72 : 264,
        background: "linear-gradient(180deg, #0F172A 0%, #0B1120 50%, #0F172A 100%)",
        borderRight: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 64,
          padding: mini ? "0 16px" : "0 20px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: "linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)",
            boxShadow: "0 4px 16px rgba(99,102,241,0.4), inset 0 1px 1px rgba(255,255,255,0.15)",
          }}
        >
          <ShoppingBag className="w-5 h-5 text-white" />
        </div>
        {(!mini || isMobile) && (
          <div className="ml-3 overflow-hidden">
            <span className="font-bold text-[17px] tracking-tight text-white leading-tight block">AJKMart</span>
            <span className="text-[10px] font-semibold tracking-[0.15em] uppercase" style={{ color: "#818CF8" }}>Admin Console</span>
          </div>
        )}
        {isMobile && (
          <button
            onClick={() => setIsMobileMenuOpen(false)}
            aria-label="Close navigation menu"
            className="ml-auto w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4 text-white/50" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* SOS alert banner */}
      {sosCount > 0 && (
        <Link href="/sos-alerts" onClick={() => isMobile && setIsMobileMenuOpen(false)}>
          <div
            className="relative overflow-hidden flex items-center gap-2.5 cursor-pointer transition-opacity hover:opacity-90"
            style={{
              margin: mini ? "8px 8px" : "10px 12px",
              background: "linear-gradient(135deg, #DC2626, #B91C1C)",
              borderRadius: 14,
              padding: mini ? "10px" : "10px 14px",
              boxShadow: "0 4px 20px rgba(220,38,38,0.35)",
            }}
          >
            <span className="absolute inset-0 rounded-xl animate-ping" style={{ background: "rgba(239,68,68,0.2)", animationDuration: "2s" }} />
            <AlertTriangle className="w-4 h-4 text-white animate-pulse relative z-10 shrink-0" />
            {(!mini || isMobile) && (
              <div className="flex-1 min-w-0 relative z-10">
                <p className="text-[11px] font-bold text-white leading-tight">{sosCount} Active SOS</p>
                <p className="text-[10px] leading-tight" style={{ color: "rgba(255,255,255,0.7)" }}>Tap to respond</p>
              </div>
            )}
            <span
              className="relative z-10 text-[10px] font-black rounded-full flex items-center justify-center shrink-0"
              style={{ background: "rgba(255,255,255,0.2)", color: "#fff", minWidth: 22, height: 22, padding: "0 5px" }}
            >
              {sosCount}
            </span>
          </div>
        </Link>
      )}

      {/* In-sidebar quick filter — narrows the visible nav items live as the
          admin types. Hidden when the sidebar is collapsed to icons-only. */}
      {(!mini || isMobile) && (
        <div className="px-3 pt-3 pb-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "rgba(255,255,255,0.35)" }} />
            <input
              type="text"
              value={navFilter}
              placeholder="Filter menu…"
              onChange={(e) => setNavFilter(e.target.value)}
              className="w-full h-8 pl-8 pr-7 rounded-lg bg-white/[0.04] text-[12px] text-white placeholder:text-white/35 border border-white/[0.06] focus:outline-none focus:border-white/20 focus:bg-white/[0.06] admin-transition"
              aria-label="Filter sidebar items"
            />
            {navFilter && (
              <button
                type="button"
                onClick={() => setNavFilter("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded admin-focus-ring"
                aria-label="Clear filter"
                title="Clear filter"
              >
                <X className="w-3 h-3" style={{ color: "rgba(255,255,255,0.4)" }} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Pinned favorites — surfaced above group nav for one-click access. Only
          shown when there's at least one pinned item and not in icons-only mode. */}
      {(!mini || isMobile) && favorites.length > 0 && !navFilterTrim && (
        <div className="px-3 pt-2">
          <p className="px-2.5 text-[10px] font-bold uppercase tracking-[0.12em] mb-1" style={{ color: "rgba(255,255,255,0.3)" }}>
            <Star className="w-2.5 h-2.5 inline -mt-0.5 mr-1" style={{ color: "#FBBF24", fill: "#FBBF24" }} />
            Pinned
          </p>
          <div className="space-y-0.5 mb-1">
            {favorites.map(href => {
              const item = navItems.find(n => n.href === href);
              if (!item) return null;
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link key={href} href={item.href} onClick={() => {
                  // Store scroll position before navigating
                  if (sidebarScrollRef.current) {
                    const scrollKey = `sidebar_scroll_${item.href}`;
                    sessionStorage.setItem(scrollKey, String(sidebarScrollRef.current.scrollTop));
                  }
                  isMobile && setIsMobileMenuOpen(false);
                }}>
                  <div
                    className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg admin-transition cursor-pointer group"
                    data-sidebar-active={active ? "true" : "false"}
                    style={{
                      background: active ? "rgba(99,102,241,0.14)" : "transparent",
                      border: active ? "1px solid rgba(99,102,241,0.25)" : "1px solid transparent",
                    }}
                    onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <Icon className="w-[16px] h-[16px] shrink-0" style={{ color: active ? "#A5B4FC" : "rgba(255,255,255,0.55)" }} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: active ? "#E0E7FF" : "rgba(255,255,255,0.55)", fontWeight: active ? 600 : 400 }}>
                      {T(item.nameKey)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.href); }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 admin-focus-ring rounded shrink-0"
                      aria-label="Unpin from favorites"
                      title="Unpin"
                    >
                      <Star className="w-3 h-3" style={{ color: "#FBBF24", fill: "#FBBF24" }} />
                    </button>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Nav groups */}
      <div
        ref={sidebarScrollRef}
        className="flex-1 overflow-y-auto py-2"
        style={{ scrollbarWidth: "none" }}
      >
        {navFilterTrim && NAV_GROUPS.every(g => g.items.every(i => {
          const label = T(i.nameKey).toLowerCase();
          const desc = (NAV_DESCRIPTIONS[i.href] || "").toLowerCase();
          return !label.includes(navFilterTrim) && !desc.includes(navFilterTrim) && !i.href.toLowerCase().includes(navFilterTrim);
        })) && (
          <div className="px-5 py-6 text-center">
            <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>No menu items match "{navFilter}"</p>
          </div>
        )}
        {NAV_GROUPS.map(group => {
          const isExpanded = expandedGroups.has(group.key);
          const showMini = mini && !isMobile;
          // When the user is filtering, show every group expanded so matches across
          // groups are visible at once.
          const filteredItems = navFilterTrim
            ? group.items.filter(item => {
                const label = T(item.nameKey).toLowerCase();
                const desc = (NAV_DESCRIPTIONS[item.href] || "").toLowerCase();
                return label.includes(navFilterTrim) || desc.includes(navFilterTrim) || item.href.toLowerCase().includes(navFilterTrim);
              })
            : group.items;
          if (navFilterTrim && filteredItems.length === 0) return null;
          const effectiveExpanded = navFilterTrim ? true : isExpanded;
          const hasActiveItem = filteredItems.some(i => isActive(i.href));

          return (
            <div key={group.key} className="mb-0.5" style={{ padding: showMini ? "0 8px" : "0 10px" }}>
              {/* Group header */}
              {showMini ? (
                <div className="flex justify-center py-2">
                  <div className="w-6 h-[2px] rounded-full" style={{ background: `${group.color}40` }} />
                </div>
              ) : (
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center w-full gap-2 px-2.5 py-2 mt-1 rounded-lg transition-colors hover:bg-white/[0.04] group/header"
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 transition-all" style={{ background: hasActiveItem ? group.color : `${group.color}60` }} />
                  <span
                    className="text-[10px] font-bold uppercase tracking-[0.12em] truncate flex-1 text-left transition-colors"
                    style={{ color: hasActiveItem ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.25)" }}
                  >
                    {T(group.labelKey)}
                  </span>
                  <ChevronDown
                    className="w-3 h-3 shrink-0 transition-transform duration-200"
                    style={{
                      color: "rgba(255,255,255,0.2)",
                      transform: effectiveExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                    }}
                  />
                </button>
              )}

              {/* Group items */}
              <div
                className="overflow-hidden transition-all duration-200 ease-out"
                style={{
                  maxHeight: showMini ? "none" : effectiveExpanded ? `${filteredItems.length * 44}px` : "0px",
                  opacity: showMini ? 1 : effectiveExpanded ? 1 : 0,
                }}
              >
                <div className="space-y-0.5 pb-1">
                  {filteredItems.map(item => {
                    const active = isActive(item.href);
                    const Icon = item.icon;
                    const showSosBadge = item.sosBadge && sosCount > 0;
                    const showErrorBadge = item.errorBadge && errorCount > 0;
                    const showPendingRidersBadge = item.pendingRidersBadge && pendingRidersCount > 0;
                    const showPendingOrdersBadge = item.pendingOrdersBadge && pendingOrdersCount > 0;
                    const showPendingWithdrawalsBadge = item.pendingWithdrawalsBadge && pendingWithdrawalsCount > 0;
                    const showPendingDepositsBadge = item.pendingDepositsBadge && pendingDepositsCount > 0;
                    const hasBadge = showSosBadge || showErrorBadge || showPendingRidersBadge || showPendingOrdersBadge || showPendingWithdrawalsBadge || showPendingDepositsBadge;
                    const isFav = favorites.includes(item.href);

                    const itemNode = (
                      <Link key={item.href} href={item.href} onClick={() => {
                        // Store scroll position before navigating
                        if (sidebarScrollRef.current) {
                          const scrollKey = `sidebar_scroll_${item.href}`;
                          sessionStorage.setItem(scrollKey, String(sidebarScrollRef.current.scrollTop));
                        }
                        isMobile && setIsMobileMenuOpen(false);
                      }}>
                        <div
                          className="flex items-center transition-all duration-150 cursor-pointer group relative"
                          data-sidebar-active={active ? "true" : "false"}
                          style={{
                            borderRadius: 10,
                            padding: showMini ? "10px 0" : "8px 10px",
                            justifyContent: showMini ? "center" : "flex-start",
                            background: active
                              ? `linear-gradient(135deg, ${group.color}18 0%, ${group.color}0A 100%)`
                              : "transparent",
                            border: active ? `1px solid ${group.color}30` : "1px solid transparent",
                          }}
                          onMouseEnter={e => {
                            if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                          }}
                          onMouseLeave={e => {
                            if (!active) (e.currentTarget as HTMLElement).style.background = "transparent";
                          }}
                        >
                          {active && !showMini && (
                            <span
                              className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full"
                              style={{ background: group.color }}
                            />
                          )}

                          <div className="relative shrink-0" style={{ margin: showMini ? 0 : "0 10px 0 6px" }}>
                            <Icon
                              className="w-[18px] h-[18px] transition-colors duration-150"
                              style={{ color: active ? group.color : showSosBadge ? "#EF4444" : showErrorBadge ? "#F59E0B" : showPendingRidersBadge ? "#3B82F6" : showPendingOrdersBadge ? "#F97316" : showPendingWithdrawalsBadge ? "#22C55E" : showPendingDepositsBadge ? "#06B6D4" : "rgba(255,255,255,0.38)" }}
                            />
                            {showSosBadge && (
                              <>
                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 animate-ping opacity-75" />
                                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-600 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                  {sosCount > 9 ? "9+" : sosCount}
                                </span>
                              </>
                            )}
                            {showErrorBadge && !showSosBadge && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-amber-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                {errorCount > 99 ? "99+" : errorCount}
                              </span>
                            )}
                            {showPendingRidersBadge && !showSosBadge && !showErrorBadge && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-blue-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                {pendingRidersCount > 99 ? "99+" : pendingRidersCount}
                              </span>
                            )}
                            {showPendingOrdersBadge && !showSosBadge && !showErrorBadge && !showPendingRidersBadge && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-orange-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                {pendingOrdersCount > 99 ? "99+" : pendingOrdersCount}
                              </span>
                            )}
                            {showPendingWithdrawalsBadge && !showSosBadge && !showErrorBadge && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-green-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                {pendingWithdrawalsCount > 99 ? "99+" : pendingWithdrawalsCount}
                              </span>
                            )}
                            {showPendingDepositsBadge && !showSosBadge && !showErrorBadge && (
                              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-cyan-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                                {pendingDepositsCount > 99 ? "99+" : pendingDepositsCount}
                              </span>
                            )}
                          </div>

                          {!showMini && (
                            <>
                              <span
                                className="text-[13px] flex-1 truncate transition-colors"
                                style={{
                                  color: active ? "#E0E7FF" : "rgba(255,255,255,0.58)",
                                  fontWeight: active ? 600 : 400,
                                }}
                              >
                                {T(item.nameKey)}
                              </span>
                              {showSosBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(239,68,68,0.2)", color: "#FCA5A5" }}>
                                  {sosCount > 9 ? "9+" : sosCount}
                                </span>
                              )}
                              {showErrorBadge && !showSosBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.2)", color: "#FCD34D" }}>
                                  {errorCount > 99 ? "99+" : errorCount}
                                </span>
                              )}
                              {showPendingRidersBadge && !showSosBadge && !showErrorBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(59,130,246,0.2)", color: "#93C5FD" }}>
                                  {pendingRidersCount > 99 ? "99+" : pendingRidersCount}
                                </span>
                              )}
                              {showPendingOrdersBadge && !showSosBadge && !showErrorBadge && !showPendingRidersBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(249,115,22,0.2)", color: "#FDBA74" }}>
                                  {pendingOrdersCount > 99 ? "99+" : pendingOrdersCount}
                                </span>
                              )}
                              {showPendingWithdrawalsBadge && !showSosBadge && !showErrorBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(34,197,94,0.2)", color: "#86EFAC" }}>
                                  {pendingWithdrawalsCount > 99 ? "99+" : pendingWithdrawalsCount}
                                </span>
                              )}
                              {showPendingDepositsBadge && !showSosBadge && !showErrorBadge && (
                                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "rgba(6,182,212,0.2)", color: "#67E8F9" }}>
                                  {pendingDepositsCount > 99 ? "99+" : pendingDepositsCount}
                                </span>
                              )}
                              {/* Favorite star — visible on hover, persisted on click. Hidden when mini. */}
                              <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.href); }}
                                className={`shrink-0 w-5 h-5 -mr-1 flex items-center justify-center rounded transition-opacity duration-150 ${isFav ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"} admin-focus-ring`}
                                title={isFav ? "Remove from favorites" : "Add to favorites"}
                                aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                              >
                                {isFav
                                  ? <Star className="w-3.5 h-3.5" style={{ color: "#FBBF24", fill: "#FBBF24" }} />
                                  : <StarOff className="w-3.5 h-3.5" style={{ color: "rgba(255,255,255,0.35)" }} />}
                              </button>
                              {active && !hasBadge && (
                                <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: `${group.color}60` }} />
                              )}
                            </>
                          )}
                        </div>
                      </Link>
                    );

                    if (showMini) {
                      const description = NAV_DESCRIPTIONS[item.href];
                      return (
                        <Tooltip key={item.href} delayDuration={150}>
                          <TooltipTrigger asChild>{itemNode}</TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[220px]">
                            <div className="text-[10px] font-bold uppercase tracking-wide opacity-60">{T(group.labelKey)}</div>
                            <div className="text-xs font-semibold leading-tight">{T(item.nameKey)}</div>
                            {description && <div className="text-[11px] opacity-80 leading-snug mt-0.5">{description}</div>}
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                    const description = NAV_DESCRIPTIONS[item.href];
                    if (description) {
                      return (
                        <Tooltip key={item.href} delayDuration={600}>
                          <TooltipTrigger asChild>{itemNode}</TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[220px]">
                            <div className="text-xs font-semibold leading-tight">{T(item.nameKey)}</div>
                            <div className="text-[11px] opacity-80 leading-snug mt-0.5">{description}</div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                    return <React.Fragment key={item.href}>{itemNode}</React.Fragment>;
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom section */}
      <div className="shrink-0" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: showMiniFooter(mini, isMobile) ? "12px 10px" : "14px 14px" }}>
        {/* Profile card */}
        <div
          className="flex items-center rounded-xl transition-all duration-150"
          style={{
            padding: showMiniFooter(mini, isMobile) ? "8px 0" : "10px 12px",
            justifyContent: showMiniFooter(mini, isMobile) ? "center" : "flex-start",
            background: showMiniFooter(mini, isMobile) ? "transparent" : "rgba(255,255,255,0.03)",
            border: showMiniFooter(mini, isMobile) ? "none" : "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
            style={{
              background: "linear-gradient(135deg, #6366F1, #8B5CF6)",
              color: "#fff",
              boxShadow: "0 2px 10px rgba(99,102,241,0.35)",
            }}
          >
            A
          </div>
          {!showMiniFooter(mini, isMobile) && (
            <div className="ml-2.5 flex-1 min-w-0">
              <p className="text-[12px] font-semibold truncate" style={{ color: "rgba(255,255,255,0.85)" }}>Administrator</p>
              <p className="text-[10px] truncate" style={{ color: "rgba(255,255,255,0.3)" }}>admin@ajkmart.pk</p>
            </div>
          )}
        </div>

        {/* Logout button */}
        <button
          onClick={handleLogout}
          title={showMiniFooter(mini, isMobile) ? "Logout" : undefined}
          className="flex items-center w-full rounded-xl transition-all duration-200 mt-2 group/logout"
          style={{
            padding: showMiniFooter(mini, isMobile) ? "9px 0" : "9px 12px",
            justifyContent: showMiniFooter(mini, isMobile) ? "center" : "flex-start",
            color: "rgba(255,255,255,0.3)",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)";
            (e.currentTarget as HTMLElement).style.color = "#F87171";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.3)";
          }}
        >
          <LogOut className="w-[17px] h-[17px] shrink-0" style={{ margin: showMiniFooter(mini, isMobile) ? 0 : "0 10px 0 4px" }} />
          {!showMiniFooter(mini, isMobile) && <span className="text-[13px] font-medium">{T("logout")}</span>}
        </button>
      </div>
    </div>
    </TooltipProvider>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#F1F5F9" }}>
      {/* Skip-to-main navigation link — visible only on keyboard focus */}
      <a href="#main-content" className="admin-skip-link">Skip to main content</a>
      {/* Desktop sidebar */}
      <div
        className="hidden lg:block h-full z-20 shrink-0 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ width: sidebarWidth }}
      >
        <SidebarContent mini={collapsed} />
      </div>

      {/* Mobile drawer overlay */}
      {isMobileMenuOpen && (
        <div
          id="mobile-nav-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-[6px] transition-opacity duration-300"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
            style={{ animation: "fadeIn 200ms ease-out" }}
          />
          <div
            ref={mobileDrawerRef}
            className="relative z-10 h-full"
            style={{
              width: 280,
              animation: "slideInLeft 250ms cubic-bezier(0.16,1,0.3,1)",
              boxShadow: "4px 0 32px rgba(0,0,0,0.3)",
            }}
          >
            <SidebarContent isMobile />
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* SOS top banner */}
        {sosCount > 0 && (
          <Link href="/sos-alerts">
            <div
              className="relative overflow-hidden flex items-center justify-center gap-2 text-white cursor-pointer z-20"
              style={{ background: "linear-gradient(90deg, #B91C1C, #DC2626, #B91C1C)", padding: "7px 16px" }}
            >
              <span className="absolute inset-0 animate-pulse" style={{ background: "rgba(239,68,68,0.30)", animationDuration: "1s" }} />
              <AlertTriangle className="w-3.5 h-3.5 relative z-10" />
              <span className="relative z-10 text-xs font-bold tracking-wide">
                {sosCount} Active SOS Alert{sosCount !== 1 ? "s" : ""} — Tap for immediate response
              </span>
              <AlertTriangle className="w-3.5 h-3.5 relative z-10" />
            </div>
          </Link>
        )}

        {/* Header */}
        <header
          className="flex items-center justify-between shrink-0 z-10"
          style={{
            height: 60,
            padding: "0 20px 0 16px",
            background: "rgba(255,255,255,0.95)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            borderBottom: "1px solid rgba(0,0,0,0.06)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          {/* Left */}
          <div className="flex items-center gap-2">
            <button
              onClick={toggleCollapsed}
              className="hidden lg:flex w-8 h-8 items-center justify-center rounded-lg transition-all duration-150 hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="lg:hidden w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors text-slate-500"
              aria-label="Open navigation menu"
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-nav-drawer"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="lg:hidden w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #6366F1, #8B5CF6)" }}>
              <ShoppingBag className="w-3.5 h-3.5 text-white" />
            </div>

            <div className="flex items-center gap-1.5">
              <span className="hidden sm:block text-xs text-slate-400 font-medium">AJKMart</span>
              <ChevronRight className="hidden sm:block w-3 h-3 text-slate-300" />
              <span className="text-sm font-semibold text-slate-700">{currentPageName}</span>
            </div>
          </div>

          {/* Center: global search + ⌘K hint */}
          <div className="hidden sm:flex items-center gap-2 relative">
            <GlobalSearch inputRef={globalSearchRef} />
            <button
              onClick={() => setCmdOpen(true)}
              aria-label="Open command palette (⌘K)"
              title="Command palette (⌘K)"
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs transition-all duration-150 hover:bg-slate-50 shrink-0"
              style={{ borderColor: "rgba(0,0,0,0.08)", color: "#94A3B8" }}
            >
              <kbd className="font-mono text-[10px]">⌘K</kbd>
            </button>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              onClick={() => setCmdOpen(true)}
              aria-label="Open search"
              aria-expanded={cmdOpen}
              className="sm:hidden w-8 h-8 flex items-center justify-center rounded-xl border hover:bg-slate-50 transition-colors"
              style={{ borderColor: "rgba(0,0,0,0.08)" }}
            >
              <Search className="w-4 h-4 text-slate-400" aria-hidden="true" />
            </button>

            {/* Live indicator */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg" style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.12)" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] font-semibold text-emerald-600">{T("live")}</span>
            </div>

            {/* SOS badge */}
            {sosCount > 0 && (
              <Link href="/sos-alerts">
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all animate-pulse"
                  style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#DC2626" }}
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-bold">{sosCount} SOS</span>
                </div>
              </Link>
            )}

            {/* Stock notification bell */}
            <StockNotificationBell />

            {/* Language selector */}
            <div className="relative hidden sm:block" ref={langRef}>
              <button
                onClick={() => setLangOpen(o => !o)}
                disabled={langLoading}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150 hover:bg-slate-50"
                style={{ borderColor: "rgba(0,0,0,0.08)", color: "#64748B" }}
              >
                <Globe className="w-3.5 h-3.5" />
                {currentLangLabel}
                <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${langOpen ? "rotate-180" : ""}`} />
              </button>
              {langOpen && (
                <div
                  className="absolute right-0 top-full mt-1.5 rounded-xl overflow-hidden z-50"
                  style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.08)", boxShadow: "0 8px 30px rgba(0,0,0,0.12)", minWidth: 150 }}
                >
                  {LANGUAGE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => { setLanguage(opt.value as "en" | "ur"); setLangOpen(false); }}
                      className="w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2"
                      style={{
                        fontWeight: language === opt.value ? 600 : 400,
                        color: language === opt.value ? "#6366F1" : "#374151",
                        background: language === opt.value ? "rgba(99,102,241,0.06)" : "transparent",
                      }}
                      onMouseEnter={e => { if (language !== opt.value) (e.currentTarget as HTMLElement).style.background = "#F8FAFC"; }}
                      onMouseLeave={e => { if (language !== opt.value) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <Globe className="w-3.5 h-3.5" />
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative hidden sm:block" ref={userRef}>
              <button
                onClick={() => setUserMenuOpen(o => !o)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-xl transition-all duration-150 hover:bg-slate-50"
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ background: "linear-gradient(135deg, #6366F1, #8B5CF6)", color: "#fff", boxShadow: "0 2px 6px rgba(99,102,241,0.3)" }}
                >
                  A
                </div>
                <ChevronDown className={`w-3 h-3 transition-transform duration-200 text-slate-400 ${userMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {userMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1.5 rounded-xl overflow-hidden z-50"
                  style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.08)", boxShadow: "0 8px 30px rgba(0,0,0,0.12)", minWidth: 190 }}
                >
                  <div className="px-4 py-3" style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                    <p className="text-sm font-semibold text-slate-700">{state.user?.name || "Administrator"}</p>
                    <p className="text-xs text-slate-400">{state.user?.email || "admin@ajkmart.pk"}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 text-red-500 transition-colors"
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.06)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                  >
                    <LogOut className="w-4 h-4" />
                    {T("logout")}
                  </button>
                </div>
              )}
            </div>

            {/* Mobile logout */}
            <button
              onClick={handleLogout}
              className="sm:hidden w-8 h-8 flex items-center justify-center rounded-xl hover:bg-red-50 transition-colors text-slate-400 hover:text-red-500"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        <ErrorBoundary fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"><div className="bg-white rounded-2xl p-6 text-center shadow-xl"><p className="font-semibold text-red-600">{T("errorCommandPalette" as TranslationKey)}</p></div></div>}>
          <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
        </ErrorBoundary>

        {/* Page content */}
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto pb-20 lg:pb-6 focus:outline-none" style={{ background: "#F1F5F9" }}>
          <div className="max-w-7xl mx-auto p-3 sm:p-5 lg:p-7 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out">
            <Breadcrumbs />
            {children}
          </div>
        </main>

        {/* Mobile bottom nav */}
        <nav
          className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t safe-area-inset-bottom"
          style={{
            background: "rgba(255,255,255,0.97)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            borderColor: "rgba(0,0,0,0.06)",
            boxShadow: "0 -2px 20px rgba(0,0,0,0.04)",
          }}
        >
          <div className="flex items-stretch h-16 max-w-md mx-auto">
            {BOTTOM_NAV.map(item => {
              const active = item.href !== "__more__" && isActive(item.href);
              const Icon = item.icon;
              const hasSosAlert = item.isSos && sosCount > 0;

              if (item.href === "__more__") {
                return (
                  <button
                    key="more"
                    onClick={() => setIsMobileMenuOpen(true)}
                    className="flex-1 flex flex-col items-center justify-center gap-1 transition-colors"
                    style={{ color: "#94A3B8" }}
                  >
                    <Menu className="w-5 h-5" />
                    <span className="text-[10px] font-semibold">{T("navMore")}</span>
                  </button>
                );
              }

              return (
                <Link key={item.href} href={item.href} className="flex-1">
                  <div
                    className="flex flex-col items-center justify-center h-full gap-1 transition-all"
                    style={{ color: hasSosAlert ? "#DC2626" : active ? "#6366F1" : "#94A3B8" }}
                  >
                    {hasSosAlert ? (
                      <div className="relative">
                        <div className="absolute inset-0 rounded-full animate-ping" style={{ background: "rgba(220,38,38,0.2)" }} />
                        <div
                          className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg"
                          style={{ background: "linear-gradient(135deg, #DC2626, #EF4444)", boxShadow: "0 4px 12px rgba(220,38,38,0.4)" }}
                        >
                          <Icon className="w-4 h-4 text-white" />
                        </div>
                        <span
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 text-white text-[9px] font-black rounded-full flex items-center justify-center"
                          style={{ background: "#fff", color: "#DC2626", border: "1.5px solid #FECACA", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}
                        >
                          {sosCount > 9 ? "9+" : sosCount}
                        </span>
                      </div>
                    ) : (
                      <div className="relative">
                        {active && (
                          <span className="absolute -inset-1.5 rounded-xl" style={{ background: "rgba(99,102,241,0.10)" }} />
                        )}
                        <Icon className="w-5 h-5 relative z-10" />
                      </div>
                    )}
                    <span className="text-[10px] font-semibold">
                      {hasSosAlert ? "SOS!" : T(item.nameKey)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

function showMiniFooter(mini?: boolean, isMobile?: boolean): boolean {
  return !!mini && !isMobile;
}
