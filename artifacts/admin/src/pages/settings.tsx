import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { PageHeader } from "@/components/shared";
import {
  Settings2, Save, RefreshCw, Truck, Car, BarChart3,
  ShoppingCart, Globe, Users, Bike, Store, Zap, Info,
  MessageSquare, Shield, Puzzle, Link, KeyRound,
  Wifi, AlertTriangle, CreditCard, CheckCircle2, XCircle,
  Loader2, Eye, EyeOff, ExternalLink, ChevronRight,
  Building2, Banknote, Wallet, Phone, FileText, Lock,
  ToggleRight, Settings, RotateCcw, Package,
  Gift, Star, Percent, ShieldCheck, UserPlus, Server,
  Database, Download, Upload, Trash2, HardDrive, FlaskConical,
  Clock, X, SlidersHorizontal, Palette, MapPin, Gauge, Languages, Bell, ImageUp, List, Bus, Sparkles, ShieldAlert,
  Search,
} from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { fetcher } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toggle, Field, SecretInput, SLabel, ModeBtn } from "@/components/AdminShared";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLanguage } from "@/lib/useLanguage";
import { tDual } from "@workspace/i18n";
import { PaymentSection } from "./settings-payment";
import { IntegrationsSection } from "./settings-integrations";
import { SecuritySection } from "./settings-security";
import { NavigationGuard } from "@/components/NavigationGuard";
import { SystemSection } from "./settings-system";
import { WeatherSection } from "./settings-weather";
import { renderSection, Setting, CatKey, TEXT_KEYS } from "./settings-render";

/* ─────────────────────────────────────────────────────────────────────────
 * TOP-10 settings model
 *
 * The DB still stores ~30 fine-grained `category` values on each setting row
 * (general, features, dispatch, …). The render layer maps those legacy
 * categories into 10 top-level groups via LEGACY_TO_TOP10 below. Every legacy
 * category remains a sub-section inside its top-10 parent — this keeps the
 * existing renderSection() dispatch and dedicated section components
 * untouched while presenting a clean Top-10 navigation.
 *
 * Deep links: both `?tab=` (new) and `?cat=` (legacy) are accepted, and both
 * top-10 keys *and* legacy category names resolve to the right tab.
 * ───────────────────────────────────────────────────────────────────────── */

export type Top10Key =
  | "general" | "services" | "operations" | "roles" | "finance_payments"
  | "communication" | "integrations" | "security_access" | "system_perf" | "widgets";

const TOP10_ORDER: readonly Top10Key[] = [
  "general", "services", "operations", "roles", "finance_payments",
  "communication", "integrations", "security_access", "system_perf", "widgets",
];

/** Map every legacy DB category → its Top-10 parent. */
export const LEGACY_TO_TOP10: Record<string, Top10Key> = {
  // 1. General  (identity + regional + branding theme)
  general:       "general",
  regional:      "general",
  localization:  "general",
  branding:      "general",
  // 2. Services & Features
  features:      "services",
  // 3. Operations & Dispatch  (includes onboarding flows for vendors/riders/customers)
  dispatch:      "operations",
  orders:        "operations",
  delivery:      "operations",
  rides:         "operations",
  van:           "operations",
  onboarding:    "operations",
  // 4. Roles
  customer:      "roles",
  rider:         "roles",
  vendor:        "roles",
  // 5. Finance & Payments
  finance:       "finance_payments",
  payment:       "finance_payments",
  // 6. Communication
  notifications: "communication",
  content:       "communication",
  // 7. Integrations
  integrations:  "integrations",
  // 8. Security & Access  (auth + abuse-prevention: moderation, rate limits, JWT)
  security:      "security_access",
  jwt:           "security_access",
  moderation:    "security_access",
  ratelimit:     "security_access",
  // 9. System & Performance
  system:        "system_perf",
  system_limits: "system_perf",
  cache:         "system_perf",
  network:       "system_perf",
  geo:           "system_perf",
  uploads:       "system_perf",
  pagination:    "system_perf",
  // 10. Widgets & Add-ons
  weather:       "widgets",
};

/** Top-10 group metadata (sidebar entries + section header). */
const TOP10_CONFIG: Record<Top10Key, {
  label: string; emoji: string; icon: any; color: string; bg: string;
  description: string; children: CatKey[];
}> = {
  general: {
    label: "General", emoji: "🏢", icon: Globe,
    color: "text-gray-700", bg: "bg-gray-50",
    description: "App identity, regional formats, locale and brand colors",
    children: ["general", "regional", "localization", "branding"],
  },
  services: {
    label: "Services & Features", emoji: "⚡", icon: Zap,
    color: "text-violet-600", bg: "bg-violet-50",
    description: "Master toggles for every service across the platform",
    children: ["features"],
  },
  operations: {
    label: "Operations & Dispatch", emoji: "🚀", icon: Gauge,
    color: "text-cyan-600", bg: "bg-cyan-50",
    description: "Dispatch, orders, delivery, rides, van and onboarding flows",
    children: ["dispatch", "orders", "delivery", "rides", "van", "onboarding"],
  },
  roles: {
    label: "Role Limits & Rates", emoji: "👤", icon: Users,
    color: "text-blue-600", bg: "bg-blue-50",
    description: "Per-role earnings, wallet limits, commission rates and settlement rules",
    children: ["customer", "rider", "vendor"],
  },
  finance_payments: {
    label: "Finance & Payments", emoji: "💰", icon: BarChart3,
    color: "text-purple-600", bg: "bg-purple-50",
    description: "Tax, commissions, payouts and payment providers",
    children: ["finance", "payment"],
  },
  communication: {
    label: "Communication", emoji: "📢", icon: MessageSquare,
    color: "text-pink-600", bg: "bg-pink-50",
    description: "Notifications, banners and announcements",
    children: ["notifications", "content"],
  },
  integrations: {
    label: "Integrations", emoji: "🔌", icon: Puzzle,
    color: "text-indigo-600", bg: "bg-indigo-50",
    description: "Maps, push, SMS, email, WhatsApp, analytics and monitoring",
    children: ["integrations"],
  },
  security_access: {
    label: "Security & Access", emoji: "🔒", icon: Shield,
    color: "text-red-600", bg: "bg-red-50",
    description: "Auth, OTP, sessions, JWT, content moderation and rate limits",
    children: ["security", "jwt", "moderation", "ratelimit"],
  },
  system_perf: {
    label: "System & Performance", emoji: "🔧", icon: Server,
    color: "text-slate-700", bg: "bg-slate-100",
    description: "Database, limits, cache, network, geo and pagination",
    children: ["system", "system_limits", "cache", "network", "geo", "uploads", "pagination"],
  },
  widgets: {
    label: "Widgets & Add-ons", emoji: "✨", icon: Sparkles,
    color: "text-fuchsia-600", bg: "bg-fuchsia-50",
    description: "Weather widget and other optional dashboard add-ons",
    children: ["weather"],
  },
};

/** Sub-section labels (one per legacy category) — used as headings inside a top-10 group. */
const CATEGORY_CONFIG: Record<CatKey, { label: string; icon: any; color: string; bg: string; activeBg: string; description: string }> = {
  general:      { label: "General",             icon: Globe,        color: "text-gray-600",    bg: "bg-gray-50",    activeBg: "bg-gray-700",    description: "App name, support contact, version and maintenance mode" },
  features:     { label: "Feature Toggles",     icon: Zap,          color: "text-violet-600",  bg: "bg-violet-50",  activeBg: "bg-violet-600",  description: "Enable or disable each service across the entire platform instantly" },
  rides:        { label: "Ride Pricing & Rules", icon: Car,          color: "text-teal-600",    bg: "bg-teal-50",    activeBg: "bg-teal-600",    description: "Bike & car pricing, surge, Mol-Tol bargaining and cancellation rules" },
  orders:       { label: "Order Rules",          icon: ShoppingCart, color: "text-amber-600",   bg: "bg-amber-50",   activeBg: "bg-amber-600",   description: "Min/max cart amounts, scheduling, timing and auto-cancel rules" },
  delivery:     { label: "Delivery Charges",     icon: Truck,        color: "text-sky-600",     bg: "bg-sky-50",     activeBg: "bg-sky-600",     description: "Delivery charges per service and free delivery thresholds" },
  customer:     { label: "Customer App",         icon: Users,        color: "text-blue-600",    bg: "bg-blue-50",    activeBg: "bg-blue-600",    description: "Wallet limits, loyalty points, referral bonuses and order caps for customers" },
  rider:        { label: "Rider App",            icon: Bike,         color: "text-green-600",   bg: "bg-green-50",   activeBg: "bg-green-600",   description: "Earnings %, acceptance radius, payout limits and withdrawal rules for riders" },
  vendor:       { label: "Vendor Portal",        icon: Store,        color: "text-orange-600",  bg: "bg-orange-50",  activeBg: "bg-orange-600",  description: "Commission rate, menu limits, settlement cycle and approval rules" },
  finance:      { label: "Finance & Tax",        icon: BarChart3,    color: "text-purple-600",  bg: "bg-purple-50",  activeBg: "bg-purple-600",  description: "GST/tax, cashback, platform commissions, invoicing and payouts" },
  payment:      { label: "Payment Methods",      icon: CreditCard,   color: "text-emerald-600", bg: "bg-emerald-50", activeBg: "bg-emerald-600", description: "JazzCash, EasyPaisa, Bank Transfer, COD and AJK Wallet settings" },
  content:      { label: "Content & Banners",    icon: MessageSquare,color: "text-pink-600",    bg: "bg-pink-50",    activeBg: "bg-pink-600",    description: "Banners, announcements, notices for riders & vendors, policy links" },
  integrations: { label: "Integrations",         icon: Puzzle,       color: "text-indigo-600",  bg: "bg-indigo-50",  activeBg: "bg-indigo-600",  description: "Push notifications, SMS, WhatsApp, analytics, maps and monitoring" },
  security:     { label: "Security",             icon: Shield,       color: "text-red-600",     bg: "bg-red-50",     activeBg: "bg-red-600",     description: "OTP modes, GPS tracking, rate limits, sessions and API credentials" },
  system:       { label: "System & Data",        icon: Database,     color: "text-rose-600",    bg: "bg-rose-50",    activeBg: "bg-rose-600",    description: "Database stats, backup, restore and data management tools" },
  dispatch:     { label: "Dispatch & Operations", icon: Gauge,       color: "text-cyan-600",    bg: "bg-cyan-50",    activeBg: "bg-cyan-600",    description: "Dispatch timeout, broadcast radius, max fare and counter-offer rules" },
  branding:     { label: "Branding & UI",        icon: Palette,     color: "text-fuchsia-600", bg: "bg-fuchsia-50", activeBg: "bg-fuchsia-600", description: "Service colors, map center coordinates and label" },
  system_limits:{ label: "System Limits",         icon: Server,      color: "text-slate-600",   bg: "bg-slate-50",   activeBg: "bg-slate-600",   description: "Log retention, cache TTL, body limit and upload size" },
  regional:     { label: "Regional & Validation", icon: Languages,   color: "text-lime-600",    bg: "bg-lime-50",    activeBg: "bg-lime-600",    description: "Phone format, timezone, currency symbol and country code" },
  weather:      { label: "Weather Widget",      icon: Globe,        color: "text-sky-600",     bg: "bg-sky-50",     activeBg: "bg-sky-600",     description: "Toggle weather widget and manage displayed cities" },
  notifications:{ label: "Notifications",        icon: Bell,         color: "text-yellow-600",  bg: "bg-yellow-50",  activeBg: "bg-yellow-600",  description: "Email templates, push notification text, fraud alert thresholds" },
  uploads:      { label: "Upload Limits",        icon: ImageUp,      color: "text-cyan-600",    bg: "bg-cyan-50",    activeBg: "bg-cyan-600",    description: "Image/video file size limits and allowed formats" },
  pagination:   { label: "Pagination",           icon: List,         color: "text-lime-600",    bg: "bg-lime-50",    activeBg: "bg-lime-600",    description: "Products per page, trending searches limit, flash deals display" },
  van:          { label: "Van / Transport",      icon: Bus,          color: "text-stone-600",   bg: "bg-stone-50",   activeBg: "bg-stone-600",   description: "Intercity van booking rules, driver limits, pricing surcharges" },
  onboarding:   { label: "Onboarding & UX",     icon: Sparkles,     color: "text-fuchsia-600", bg: "bg-fuchsia-50", activeBg: "bg-fuchsia-600", description: "Vendor auto-schedule, onboarding slides, app experience" },
  moderation:   { label: "Content Moderation",   icon: ShieldAlert,  color: "text-rose-600",    bg: "bg-rose-50",    activeBg: "bg-rose-600",    description: "Auto-masking rules, custom regex patterns, flagged content" },
  cache:        { label: "Cache TTLs",          icon: Clock,        color: "text-amber-600",   bg: "bg-amber-50",   activeBg: "bg-amber-600",   description: "Platform settings, VPN detection, TOR node and zone cache lifetimes" },
  jwt:          { label: "JWT & Sessions",      icon: KeyRound,     color: "text-indigo-600",  bg: "bg-indigo-50",  activeBg: "bg-indigo-600",  description: "Access token, refresh token and 2FA challenge timeouts" },
  ratelimit:    { label: "Endpoint Rate Limits", icon: SlidersHorizontal, color: "text-rose-600", bg: "bg-rose-50", activeBg: "bg-rose-600",    description: "Per-endpoint rate limits for bargaining, booking, cancellation and estimates" },
  geo:          { label: "Geo & Zones",         icon: MapPin,       color: "text-emerald-600", bg: "bg-emerald-50", activeBg: "bg-emerald-600", description: "Default zone radius and open-world fallback behavior" },
  localization: { label: "Localization",        icon: Languages,    color: "text-lime-600",    bg: "bg-lime-50",    activeBg: "bg-lime-600",    description: "Currency code and symbol used across the platform" },
  network:      { label: "Network & Retry",     icon: Wifi,         color: "text-cyan-600",    bg: "bg-cyan-50",    activeBg: "bg-cyan-600",    description: "API timeout, retry attempts, backoff delay, GPS queue size and dismissed-request TTL" },
};

const ALWAYS_VISIBLE = new Set<CatKey>(["payment", "integrations", "security", "system", "weather"]);

/** Resolve a deep-link param (?tab= / ?cat= / route :section / route :subsection)
 *  — accepts both top-10 keys and legacy category names. */
function resolveTop10(raw: string | null | undefined): Top10Key | null {
  if (!raw) return null;
  if ((TOP10_ORDER as readonly string[]).includes(raw)) return raw as Top10Key;
  if (LEGACY_TO_TOP10[raw]) return LEGACY_TO_TOP10[raw];
  return null;
}

/** Parse the wouter-relative path (already base-stripped by wouter's
 *  router base config) for `/settings/:section/:subsection?`. Settings is
 *  mounted on three Route paths so we centralise parsing rather than
 *  threading useParams through each. The input must be the value returned
 *  by `useLocation()` (which strips the `import.meta.env.BASE_URL` prefix
 *  the WouterRouter is configured with), so this stays correct under any
 *  deployment base path (e.g. "/admin"). */
function parseSettingsPath(routerLocation: string): { section: string | null; subsection: string | null } {
  const path = routerLocation.replace(/\/+$/, "");
  const m = path.match(/^\/settings(?:\/([^/]+))?(?:\/([^/]+))?$/);
  return {
    section: m?.[1] ? decodeURIComponent(m[1]) : null,
    subsection: m?.[2] ? decodeURIComponent(m[2]) : null,
  };
}

export default function SettingsPage() {
  const { toast } = useToast();
  // Wouter's `useLocation` returns the path with the configured router base
  // already stripped (see `WouterRouter base={…}` in App.tsx) and provides a
  // setter that respects the same base. Using it here keeps deep-link
  // parsing and URL normalisation correct under non-root deployments
  // such as `/admin`.
  const [routerLocation, navigate] = useLocation();
  const [settings, setSettings] = useState<Setting[]>([]);
  const [localValues, setLocalValues] = useState<Record<string,string>>({});
  const [savedValues, setSavedValues] = useState<Record<string,string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [activeTop10, setActiveTop10] = useState<Top10Key>(() => {
    // Priority: route :section > ?tab= > ?cat= > default ("services").
    // routerLocation is base-stripped so the regex always matches.
    const params = parseSettingsPath(routerLocation);
    const fromRoute = resolveTop10(params.section);
    if (fromRoute) return fromRoute;
    const p = new URLSearchParams(window.location.search);
    return resolveTop10(p.get("tab")) ?? resolveTop10(p.get("cat")) ?? "services";
  });
  // Sub-section deep link — when the path includes /:subsection we scroll to
  // it on mount. The legacy ?cat= query is also honoured so pre-existing
  // bookmarks continue to land on the correct child block.
  const [pendingSubsection, setPendingSubsection] = useState<string | null>(() => {
    const params = parseSettingsPath(routerLocation);
    if (params.subsection) return params.subsection;
    const p = new URLSearchParams(window.location.search);
    return p.get("cat");
  });

  /* ── Global settings search (cross-section) ──────────────────────────── */
  const [searchQ, setSearchQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const jumpTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { jumpTimersRef.current.forEach(clearTimeout); }; }, []);
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && document.querySelector('[data-settings-search]')) {
        const el = document.querySelector<HTMLInputElement>('[data-settings-search]');
        if (el) { e.preventDefault(); el.focus(); el.select(); }
      }
      if (e.key === "Escape" && searchOpen) setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  /* Keep deep links in sync — canonical form is `/settings/:section`. We
   * normalise away the legacy `?tab=` and `?cat=` query strings on every
   * section change so newly-shared URLs use the modern shape. Existing
   * bookmarks with the legacy params are still resolved on load by
   * `resolveTop10` above. We use wouter's `navigate` (the setter from
   * useLocation) with `{ replace: true }` so the router base path is
   * honoured — direct `window.history.replaceState` would bypass the
   * `<WouterRouter base={…}>` config and break under non-root deploys. */
  useEffect(() => {
    const params = parseSettingsPath(routerLocation);
    // Subsection is only meaningful when it belongs to the active section.
    // When the admin switches the top-level section, drop a stale subsection
    // so we never produce mismatched URLs like /settings/general/cache after
    // starting from /settings/system_perf/cache. A subsection is "valid" if
    // (a) the URL's :section segment resolved to the same activeTop10, and
    // (b) it maps to a CatKey that lives under that activeTop10's children.
    const urlSection = resolveTop10(params.section);
    // TOP10_CONFIG is a module-level constant; safe to read here even though
    // the convenience `activeCfg` alias is declared further down the file.
    const childCats = TOP10_CONFIG[activeTop10].children as readonly string[];
    const subsectionIsValid =
      !!params.subsection &&
      urlSection === activeTop10 &&
      childCats.includes(params.subsection);
    const targetPath = subsectionIsValid
      ? `/settings/${activeTop10}/${encodeURIComponent(params.subsection!)}`
      : `/settings/${activeTop10}`;
    // Preserve any other query params (e.g. ?notice=…) the page may use,
    // but always drop the legacy `tab` / `cat` keys.
    const search = new URLSearchParams(window.location.search);
    search.delete("tab");
    search.delete("cat");
    const qs = search.toString();
    const targetWithQs = qs ? `${targetPath}?${qs}` : targetPath;
    // Skip the navigate when we'd land on the same place (avoids infinite
    // re-render loops if other effects also touch the URL).
    const currentWithQs = qs
      ? `${routerLocation.replace(/\/+$/, "")}?${qs}`
      : routerLocation.replace(/\/+$/, "");
    if (currentWithQs !== targetWithQs) {
      navigate(targetWithQs, { replace: true });
    }
    // Intentionally only re-run when activeTop10 changes — navigate/
    // routerLocation update inside the effect would loop otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTop10]);

  /* Once settings have loaded and the active section is rendered, scroll to
   * the requested sub-section (e.g. `/settings/system_perf/cache`) and clear
   * the pending state so we only do this once per navigation. */
  useEffect(() => {
    if (!pendingSubsection || loading) return;
    const id = `sub-${pendingSubsection}`;
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    setPendingSubsection(null);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ajkm-section-flash");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      el.classList.remove("ajkm-section-flash");
      flashTimerRef.current = null;
    }, 1800);
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
        el.classList.remove("ajkm-section-flash");
      }
    };
  }, [pendingSubsection, loading, activeTop10]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetcher("/platform-settings");
      setSettings(data.settings || []);
      const vals: Record<string,string> = {};
      for (const s of data.settings || []) vals[s.key] = s.value;
      setLocalValues(vals);
      setSavedValues(vals);
      setDirtyKeys(new Set());
    } catch (e: any) {
      toast({ title: "Failed to load settings", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const handleChange = (key: string, value: string) => {
    setLocalValues(prev => ({ ...prev, [key]: value }));
    setDirtyKeys(prev => {
      const n = new Set(prev);
      if (value === savedValues[key]) { n.delete(key); } else { n.add(key); }
      return n;
    });
  };
  const handleToggle = (key: string, val: boolean) => handleChange(key, val ? "on" : "off");

  const [showDiffPreview, setShowDiffPreview] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<Array<{ key: string; oldValue: string; newValue: string }>>([]);

  const handleSave = () => {
    const diff = Array.from(dirtyKeys).map(key => ({
      key,
      oldValue: savedValues[key] ?? "",
      newValue: localValues[key] ?? "",
    }));
    if (diff.length === 0) return;
    setPendingDiff(diff);
    setShowDiffPreview(true);
  };

  const performSave = async () => {
    setShowDiffPreview(false);
    setSaving(true);
    try {
      const changed = pendingDiff.map(d => ({ key: d.key, value: d.newValue }));
      await fetcher("/platform-settings", { method: "PUT", body: JSON.stringify({ settings: changed }) });
      setSavedValues(prev => {
        const updated = { ...prev };
        for (const c of changed) updated[c.key] = c.value;
        return updated;
      });
      setDirtyKeys(new Set());
      toast({ title: "Settings saved ✅", description: `${changed.length} change(s) applied instantly.` });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    }
    setSaving(false);
    setPendingDiff([]);
  };

  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<File | null>(null);
  const { language } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const data = await fetcher("/platform-settings/backup");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `ajkmart-settings-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Backup download started", description: `${data.count ?? data.settings?.length ?? 0} settings exported — check your Downloads folder.` });
    } catch (e: any) {
      toast({ title: "Backup failed", description: e.message, variant: "destructive" });
    }
    setBackingUp(false);
  };

  const handleRestoreFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    if (!file) return;
    setPendingRestore(file);
  };

  const performRestore = async (file: File) => {
    setPendingRestore(null);
    setRestoring(true);
    try {
      const text = await file.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new Error("Invalid JSON file."); }
      const settingsArr = parsed?.settings ?? parsed;
      if (!Array.isArray(settingsArr)) throw new Error("Backup file must contain a settings array.");
      const payload = settingsArr.map((s: any) => ({ key: String(s.key ?? ""), value: String(s.value ?? "") }));
      const result = await fetcher("/platform-settings/restore", { method: "POST", body: JSON.stringify({ settings: payload }) });
      await loadSettings();
      toast({ title: "Settings restored ✅", description: `${result.restored ?? payload.length} settings applied${result.skipped ? `, ${result.skipped} skipped` : ""}.` });
    } catch (e: any) {
      toast({ title: "Restore failed", description: e.message, variant: "destructive" });
    }
    setRestoring(false);
  };

  const grouped = useMemo(() => {
    const byCategory: Record<string, Setting[]> = {};
    for (const s of settings) {
      if (!byCategory[s.category]) byCategory[s.category] = [];
      byCategory[s.category].push(s);
    }
    return byCategory;
  }, [settings]);

  const getInputType = (key: string) => TEXT_KEYS.has(key) ? "text" : "number";
  const getInputSuffix = (key: string) => {
    if (key.includes("_pct") || key.includes("pct")) return "%";
    if (TEXT_KEYS.has(key)) return "";
    if (key.includes("_km") || key === "rider_acceptance_km") return "KM";
    if (key.includes("_day") || key.includes("_days") || key === "security_session_days") return "days";
    if (key.includes("_pts") || key.includes("_items") || key.includes("_deliveries")) return "#";
    if (key === "security_rate_limit") return "req/min";
    if (key === "payment_timeout_mins") return "min";
    if (key.includes("_sec")) return "sec";
    if (key.includes("_multiplier")) return "×";
    return "Rs.";
  };
  const getPlaceholder = (key: string) => {
    if (key.includes("_url")) return "https://...";
    if (key === "content_announcement") return "Leave empty to hide the bar in all apps";
    if (key === "content_banner") return "Free delivery on your first order! 🎉";
    if (key === "content_maintenance_msg") return "We're performing scheduled maintenance. Back soon!";
    if (key === "content_support_msg") return "Need help? Chat with us on WhatsApp!";
    if (key === "content_vendor_notice") return "Leave empty to hide. E.g. New settlement policy starting May 1.";
    if (key === "content_rider_notice") return "Leave empty to hide. E.g. Bonus Rs.200 for 10+ deliveries today!";
    if (key === "content_refund_policy_url") return "https://ajkmart.pk/refund-policy";
    if (key === "content_faq_url") return "https://ajkmart.pk/help";
    if (key === "content_about_url") return "https://ajkmart.pk/about";
    return "";
  };

  const activeCfg = TOP10_CONFIG[activeTop10];
  const ActiveIcon = activeCfg.icon;

  const DISPLAY_CAT_OVERRIDE = useMemo<Record<string,string>>(() => ({
    vendor_min_payout:        "finance",
    customer_referral_bonus:  "payment",
    customer_signup_bonus:    "payment",
  }), []);

  /* The 5 sections that always render even with zero DB settings. */
  const ALWAYS_VISIBLE = useMemo(() => new Set<CatKey>(["payment", "integrations", "security", "system", "weather"]), []);

  const childHasContent = useCallback((cat: CatKey) => {
    return ALWAYS_VISIBLE.has(cat) || (grouped[cat]?.length ?? 0) > 0;
  }, [ALWAYS_VISIBLE, grouped]);

  const activeChildrenWithContent = useMemo(
    () => activeCfg.children.filter(childHasContent),
    [activeCfg.children, childHasContent],
  );

  const activeChildSettingsCount = useMemo(
    () => activeChildrenWithContent.reduce(
      (count, child) => count + ((grouped[child]?.length ?? 0) || (ALWAYS_VISIBLE.has(child) ? 1 : 0)),
      0,
    ),
    [activeChildrenWithContent, grouped, ALWAYS_VISIBLE],
  );

  /* Cross-section search results: match settings by key/label/description, group by Top10. */
  const searchResults = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (q.length < 2) return [] as Array<{ key: string; label: string; cat: string; top10: Top10Key }>;
    const results: Array<{ key: string; label: string; cat: string; top10: Top10Key; score: number }> = [];
    for (const s of settings) {
      const label = (s.label || s.key).toLowerCase();
      const key = s.key.toLowerCase();
      let score = 0;
      if (key === q) score = 100;
      else if (label === q) score = 95;
      else if (key.startsWith(q)) score = 80;
      else if (label.startsWith(q)) score = 75;
      else if (label.includes(q)) score = 60;
      else if (key.includes(q)) score = 50;
      if (score > 0) {
        const dispCat = DISPLAY_CAT_OVERRIDE[s.key] ?? s.category;
        const top10 = LEGACY_TO_TOP10[dispCat] ?? LEGACY_TO_TOP10[s.category];
        if (top10) {
          results.push({ key: s.key, label: s.label || s.key, cat: dispCat, top10, score });
        }
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score: _s, ...r }) => r);
  }, [searchQ, settings, DISPLAY_CAT_OVERRIDE]);

  const jumpToSetting = useCallback((target: { key: string; cat: string; top10: Top10Key }) => {
    jumpTimersRef.current.forEach(clearTimeout);
    jumpTimersRef.current = [];
    setActiveTop10(target.top10);
    setSearchOpen(false);
    setMobileDrawerOpen(false);
    setHighlightKey(target.key);
    const t1 = setTimeout(() => {
      const subEl = document.getElementById(`sub-${target.cat}`);
      if (subEl) {
        subEl.scrollIntoView({ behavior: "smooth", block: "start" });
        subEl.classList.add("ajkm-section-flash");
        const t2 = setTimeout(() => subEl.classList.remove("ajkm-section-flash"), 1800);
        const t3 = setTimeout(() => setHighlightKey(null), 2400);
        jumpTimersRef.current.push(t2, t3);
      } else {
        const t4 = setTimeout(() => setHighlightKey(null), 2400);
        jumpTimersRef.current.push(t4);
      }
    }, 100);
    jumpTimersRef.current.push(t1);
  }, []);

  const dirtyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of dirtyKeys) {
      const s = settings.find(x => x.key === k);
      if (!s) continue;
      const displayCat = DISPLAY_CAT_OVERRIDE[k] ?? s.category;
      const top10 = LEGACY_TO_TOP10[displayCat] ?? LEGACY_TO_TOP10[s.category];
      if (top10) counts[top10] = (counts[top10] || 0) + 1;
    }
    return counts;
  }, [dirtyKeys, settings, DISPLAY_CAT_OVERRIDE]);

  if (loading) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Settings2 className="w-6 h-6 text-primary animate-spin" style={{ animationDuration: "3s" }} />
          </div>
          <p className="text-muted-foreground text-sm font-medium">Loading settings...</p>
        </div>
      </div>
    );
  }

  const appNameValue = (localValues["app_name"] ?? settings.find(s => s.key === "app_name")?.value ?? "").trim();
  const appNameBlank = appNameValue === "";

  /* Children of the active top-10 group + total settings rendered in this view. */
  const activeChildren = activeCfg.children;
  const totalChildSettingsCount = activeChildren.reduce(
    (n, c) => n + (grouped[c]?.length ?? 0),
    0,
  );

  /* Renders one legacy sub-section inside the active top-10 group. */
  const renderLegacyChild = (cat: CatKey) => {
    if (cat === "payment") {
      return (
        <PaymentSection
          localValues={localValues} dirtyKeys={dirtyKeys}
          handleChange={handleChange} handleToggle={handleToggle}
          onNavigateFeatures={() => setActiveTop10("services")}
        />
      );
    }
    if (cat === "integrations") {
      return (
        <IntegrationsSection
          localValues={localValues} dirtyKeys={dirtyKeys}
          handleChange={handleChange} handleToggle={handleToggle}
        />
      );
    }
    if (cat === "security") {
      return (
        <SecuritySection
          localValues={localValues} dirtyKeys={dirtyKeys}
          handleChange={handleChange} handleToggle={handleToggle}
        />
      );
    }
    if (cat === "system") return <SystemSection />;
    if (cat === "weather") return <WeatherSection />;
    const childSettings = grouped[cat] ?? [];
    if (childSettings.length === 0) {
      return (
        <p className="text-xs text-muted-foreground italic px-1 py-2">
          No settings configured for this sub-section yet.
        </p>
      );
    }
    return renderSection(
      cat, childSettings, settings, localValues, dirtyKeys,
      handleChange, handleToggle, getInputType, getInputSuffix, getPlaceholder,
    );
  };

  return (
    <div className="space-y-4 max-w-5xl">
      <NavigationGuard isDirty={dirtyKeys.size > 0} message={`You have ${dirtyKeys.size} unsaved setting${dirtyKeys.size !== 1 ? "s" : ""}. Save before leaving?`} />
      {/* Hidden file input for restore */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleRestoreFile}
      />

      {/* Header */}
      <PageHeader
        icon={Settings2}
        title="App Settings"
        subtitle={dirtyKeys.size > 0 ? `${dirtyKeys.size} unsaved change${dirtyKeys.size > 1 ? "s" : ""}` : "All settings saved"}
        iconBgClass="bg-slate-100"
        iconColorClass="text-slate-600"
        actions={
          <div className="flex flex-wrap gap-2 justify-end">
            <Button
              variant="outline"
              onClick={handleBackup}
              disabled={backingUp || loading}
              title="Download all settings as a JSON backup file"
              className="h-9 rounded-xl gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            >
              {backingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span className="hidden sm:inline">Backup</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={restoring || loading}
              title="Restore settings from a JSON backup file"
              className="h-9 rounded-xl gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
            >
              {restoring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              <span className="hidden sm:inline">Restore</span>
            </Button>
            <Button variant="outline" onClick={() => { loadSettings(); toast({ title: "Reloaded" }); }} disabled={loading} className="h-9 rounded-xl gap-2">
              <RefreshCw className="w-4 h-4" /> <span className="hidden xs:inline">Reset</span>
            </Button>
            <Button onClick={handleSave} disabled={saving || dirtyKeys.size === 0 || appNameBlank} title={appNameBlank ? "App Name cannot be blank" : undefined} className="h-9 rounded-xl gap-2 shadow-sm">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving..." : `Save${dirtyKeys.size > 0 ? ` (${dirtyKeys.size})` : ""}`}
            </Button>
          </div>
        }
      />

      {/* ── Mobile: sticky section bar with drawer trigger ── */}
      <div className="md:hidden sticky top-0 z-20 -mx-3 sm:-mx-5 px-3 sm:px-5 py-2 bg-slate-50/95 backdrop-blur-sm border-b border-border/40">
        <div className="flex items-center gap-3">
          {/* Active section indicator */}
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${activeCfg.bg}`}>
            <ActiveIcon className={`w-4 h-4 ${activeCfg.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{activeCfg.label}</p>
            {dirtyCounts[activeTop10] > 0 && (
              <p className="text-[11px] text-amber-600 font-medium leading-tight">{dirtyCounts[activeTop10]} unsaved</p>
            )}
          </div>
          {/* Reset shortcut on mobile */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => { loadSettings(); toast({ title: "Reloaded" }); }}
            disabled={loading}
            className="h-8 rounded-xl px-2.5 shrink-0"
            title="Reset all changes"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          {/* Save shortcut on mobile */}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || dirtyKeys.size === 0 || appNameBlank}
            className="h-8 rounded-xl gap-1.5 px-3 text-xs shrink-0"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {dirtyKeys.size > 0 ? `Save (${dirtyKeys.size})` : "Save"}
          </Button>
          {/* All settings trigger */}
          <button
            onClick={() => setMobileDrawerOpen(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-xl border border-border/60 bg-white text-xs font-semibold text-foreground hover:bg-muted/40 transition-colors shrink-0"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
            All Settings
          </button>
        </div>
      </div>

      {/* ── Mobile bottom sheet drawer ── */}
      <Sheet open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="bottom" className="md:hidden p-0 rounded-t-2xl max-h-[85vh] flex flex-col">
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-border/60" />
          </div>
          {/* Sheet title (accessible, visually styled) */}
          <div className="px-5 pb-3 pt-1 border-b border-border/30 shrink-0">
            <SheetTitle className="flex items-center gap-2 text-base font-bold text-foreground">
              <Settings2 className="w-4 h-4 text-muted-foreground" />
              All Settings
              {dirtyKeys.size > 0 && (
                <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 font-bold ml-auto">
                  {dirtyKeys.size} unsaved
                </Badge>
              )}
            </SheetTitle>
            {/* Mobile global search */}
            <div className="relative mt-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQ}
                placeholder="Search across all settings…"
                onChange={e => setSearchQ(e.target.value)}
                className="w-full h-9 pl-8 pr-7 rounded-xl border border-slate-200 bg-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
              />
              {searchQ && (
                <button
                  onClick={() => setSearchQ("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400"
                  title="Clear"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {/* Flat Top-10 list OR search results */}
          <div className="overflow-y-auto flex-1 px-3 py-3 space-y-1 pb-8">
            {searchQ.trim().length >= 2 ? (
              searchResults.length === 0 ? (
                <div className="text-center py-12 text-sm text-slate-400">
                  No matching settings
                </div>
              ) : (
                <>
                  <p className="px-2 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
                  </p>
                  {searchResults.map(r => {
                    const top10cfg = TOP10_CONFIG[r.top10];
                    return (
                      <button
                        key={r.key}
                        onClick={() => jumpToSetting(r)}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-indigo-50 transition-colors border border-slate-100 bg-white"
                      >
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${top10cfg.bg}`}>
                          <top10cfg.icon className={`w-4 h-4 ${top10cfg.color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{r.label}</p>
                          <p className="text-[10px] text-slate-400 truncate font-mono mt-0.5">{r.key}</p>
                        </div>
                        <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400 shrink-0">
                          {top10cfg.label.split(" ")[0]}
                        </span>
                      </button>
                    );
                  })}
                </>
              )
            ) : TOP10_ORDER.map((key, idx) => {
              const cfg = TOP10_CONFIG[key];
              const Icon = cfg.icon;
              const isActive = activeTop10 === key;
              const dirty = dirtyCounts[key] || 0;
              return (
                <button
                  key={key}
                  onClick={() => { setActiveTop10(key); setMobileDrawerOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all relative ${
                    isActive ? "bg-slate-900 text-white shadow-sm" : "hover:bg-muted/50 text-foreground bg-transparent"
                  }`}
                  data-tab={key}
                >
                  {isActive && (
                    <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: "var(--color-accent, #6366F1)" }} />
                  )}
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 text-base ${isActive ? "bg-white/15" : cfg.bg}`}>
                    <Icon className={`w-4 h-4 ${isActive ? "text-white" : cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold truncate ${isActive ? "text-white" : "text-foreground"}`}>
                      <span className="text-muted-foreground/70 font-normal mr-1">{idx + 1}.</span> {cfg.label}
                    </p>
                    <p className={`text-[11px] truncate mt-0.5 ${isActive ? "text-white/60" : "text-muted-foreground"}`}>{cfg.description}</p>
                  </div>
                  {dirty > 0 ? (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isActive ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700"}`}>{dirty}</span>
                  ) : (
                    <ChevronRight className={`w-4 h-4 flex-shrink-0 ${isActive ? "text-white/40" : "text-muted-foreground/30"}`} />
                  )}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      {/* Two-panel layout */}
      <div className="flex gap-4 items-start">
        {/* LEFT sidebar — desktop only */}
        <div className="hidden md:flex w-60 flex-shrink-0 flex-col bg-white rounded-2xl border border-border/60 shadow-sm overflow-hidden sticky top-4">
          {/* Sidebar header */}
          <div className="px-4 pt-4 pb-3 border-b border-border/40 bg-slate-50/80">
            <div className="flex items-center gap-2 mb-2.5">
              <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center">
                <Settings2 className="w-3.5 h-3.5 text-slate-600" />
              </div>
              <p className="text-[12px] font-bold text-slate-600 tracking-wide">Settings</p>
            </div>
            {/* Global search */}
            <div ref={searchRef} className="relative">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                <input
                  data-settings-search
                  type="text"
                  value={searchQ}
                  placeholder="Search settings…"
                  onChange={e => { setSearchQ(e.target.value); setSearchOpen(true); }}
                  onFocus={() => searchQ.trim().length >= 2 && setSearchOpen(true)}
                  className="w-full h-8 pl-8 pr-7 rounded-lg border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
                />
                {searchQ && (
                  <button
                    onClick={() => { setSearchQ(""); setSearchOpen(false); }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center hover:bg-slate-100 text-slate-400"
                    title="Clear"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {searchOpen && searchQ.trim().length >= 2 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden max-h-80 overflow-y-auto">
                  {searchResults.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-slate-400">
                      No matching settings
                    </div>
                  ) : (
                    <>
                      <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{searchResults.length} match{searchResults.length === 1 ? "" : "es"}</span>
                        <span className="text-[10px] text-slate-400">⌘F</span>
                      </div>
                      {searchResults.map(r => {
                        const top10cfg = TOP10_CONFIG[r.top10];
                        return (
                          <button
                            key={r.key}
                            onClick={() => jumpToSetting(r)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-indigo-50 transition-colors border-b border-slate-50 last:border-b-0"
                          >
                            <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${top10cfg.bg}`}>
                              <top10cfg.icon className={`w-3 h-3 ${top10cfg.color}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-slate-700 truncate">{r.label}</p>
                              <p className="text-[10px] text-slate-400 truncate font-mono">{r.key}</p>
                            </div>
                            <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400 shrink-0">
                              {top10cfg.label.split(" ")[0]}
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <nav className="p-2.5 pb-3 max-h-[calc(100vh-200px)] overflow-y-auto" style={{ scrollbarWidth: "none" }}>
            {TOP10_ORDER.map((key, idx) => {
              const cfg = TOP10_CONFIG[key];
              const Icon = cfg.icon;
              const isActive = activeTop10 === key;
              const dirty = dirtyCounts[key] || 0;
              return (
                <button
                  key={key}
                  onClick={() => setActiveTop10(key)}
                  data-tab={key}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-left transition-all group relative overflow-hidden mb-0.5 ${
                    isActive ? "bg-slate-900 text-white shadow-md" : "hover:bg-slate-50 text-foreground"
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-indigo-400" />
                  )}
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${isActive ? "bg-white/15" : cfg.bg}`}>
                    <Icon className={`w-3.5 h-3.5 ${isActive ? "text-white" : cfg.color}`} />
                  </div>
                  <span className={`text-xs font-semibold flex-1 truncate ${isActive ? "text-white" : "text-slate-700"}`}>
                    <span className={`mr-1 font-normal ${isActive ? "text-white/60" : "text-slate-400"}`}>{idx + 1}.</span>{cfg.label}
                  </span>
                  {dirty > 0
                    ? <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isActive ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700"}`}>{dirty}</span>
                    : <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-colors ${isActive ? "text-white/40" : "text-slate-300 group-hover:text-slate-400"}`} />
                  }
                </button>
              );
            })}
          </nav>

          <div className="px-4 py-2.5 border-t border-border/40 bg-slate-50/60">
            <p className="text-[10px] text-muted-foreground">{settings.length} settings</p>
          </div>
        </div>

        {/* RIGHT content */}
        <div className="flex-1 min-w-0 space-y-4">
          <div className="bg-white rounded-2xl border border-border/60 shadow-sm overflow-hidden">
            {/* Section header — breadcrumbs above the title surface the
                hub → section path so admins always know where they are. */}
            <div className="px-6 py-4 border-b border-border/40 flex items-start gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${activeCfg.bg}`}>
                <ActiveIcon className={`w-5 h-5 ${activeCfg.color}`} />
              </div>
              <div className="flex-1 min-w-0">
                <nav aria-label="breadcrumb" className="flex items-center gap-1 text-[11px] text-muted-foreground mb-1 leading-none">
                  <span className="font-semibold text-foreground/70">Settings</span>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                  <span className="font-semibold" style={{ color: "rgb(15 23 42 / 0.85)" }}>{activeCfg.label}</span>
                </nav>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-bold text-foreground">{activeCfg.label}</h2>
                  {activeChildSettingsCount > 0 && (
                    <Badge variant="outline" className="text-[10px] bg-muted/50 text-muted-foreground border-border">
                      {activeChildSettingsCount} settings
                    </Badge>
                  )}
                  {dirtyCounts[activeTop10] > 0 && (
                    <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 font-bold">
                      {dirtyCounts[activeTop10]} changed
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{activeCfg.description}</p>
              </div>
            </div>
            {/* Section body — renders every legacy child sub-section in order */}
            <div className="p-4 sm:p-6 space-y-8">
              {activeChildrenWithContent.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Settings2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No settings in this section</p>
                </div>
              ) : activeChildrenWithContent.map((child, idx) => {
                const subCfg = CATEGORY_CONFIG[child];
                const SubIcon = subCfg.icon;
                const childSettings = grouped[child] ?? [];
                const childDirty = Array.from(dirtyKeys).filter(k => {
                  const s = settings.find(x => x.key === k);
                  if (!s) return false;
                  const dispCat = DISPLAY_CAT_OVERRIDE[k] ?? s.category;
                  return dispCat === child;
                }).length;
                return (
                  <section key={child} id={`sub-${child}`} data-cat={child} className={idx > 0 ? "pt-6 border-t border-border/50" : ""}>
                    {/* Sub-section header */}
                    <div className="flex items-start gap-3 mb-4">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${subCfg.bg}`}>
                        <SubIcon className={`w-4 h-4 ${subCfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-bold text-foreground">{subCfg.label}</h3>
                          {childSettings.length > 0 && (
                            <Badge variant="outline" className="text-[10px] bg-muted/40 text-muted-foreground border-border/60">
                              {childSettings.length}
                            </Badge>
                          )}
                          {childDirty > 0 && (
                            <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 font-bold">
                              {childDirty} changed
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{subCfg.description}</p>
                      </div>
                    </div>
                    {/* Sub-section body */}
                    {renderLegacyChild(child)}
                  </section>
                );
              })}
            </div>
          </div>
          <div className="bg-blue-50/60 border border-blue-200/60 rounded-xl p-4 flex gap-3">
            <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700">
              <strong className="text-blue-800">Changes apply instantly</strong> after saving — no restart needed.
              Payment gateways: use Manual mode without API credentials, or API mode for automated payments.
              Sandbox mode works without real credentials for testing.
            </p>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingRestore}
        onClose={() => setPendingRestore(null)}
        onConfirm={() => pendingRestore && performRestore(pendingRestore)}
        title={tDual("restoreSettingsTitle", language)}
        description={pendingRestore ? `${pendingRestore.name}\n\n${tDual("restoreSettingsBody", language)}` : ""}
        confirmLabel="Restore"
        variant="destructive"
        busy={restoring}
      />

      {/* ── Settings Diff Preview Modal ── */}
      {showDiffPreview && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowDiffPreview(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center">
                <Save className="w-5 h-5 text-amber-700" />
              </div>
              <div>
                <h2 className="font-bold text-foreground">Review changes before saving</h2>
                <p className="text-xs text-muted-foreground">{pendingDiff.length} setting{pendingDiff.length !== 1 ? "s" : ""} will be updated and applied immediately.</p>
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {pendingDiff.map(d => (
                <div key={d.key} className="px-5 py-3">
                  <p className="text-xs font-semibold text-foreground font-mono">{d.key}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span className="px-2 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded font-mono line-through max-w-[160px] truncate">{d.oldValue || "(empty)"}</span>
                    <span className="text-muted-foreground shrink-0">→</span>
                    <span className="px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded font-mono max-w-[160px] truncate">{d.newValue || "(empty)"}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-border flex justify-end gap-3 bg-muted/30">
              <Button variant="outline" className="h-9 rounded-xl" onClick={() => setShowDiffPreview(false)}>
                Cancel
              </Button>
              <Button className="h-9 rounded-xl" onClick={() => { void performSave(); }} disabled={saving}>
                {saving ? "Saving…" : `Apply ${pendingDiff.length} change${pendingDiff.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
