import { Badge } from "@/components/ui/badge";
import { renderSection, CatKey, SettingsSectionProps } from "./settings-render";
import { Server, Clock, Wifi, MapPin, ImageUp, List, SlidersHorizontal } from "lucide-react";

const MONITORING_CAT_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; description: string }> = {
  system_limits: { label: "System Limits",       icon: Server,          color: "text-slate-600",   bg: "bg-slate-50",   description: "Log retention, cache TTL, body limit and upload size" },
  cache:         { label: "Cache TTLs",           icon: Clock,           color: "text-amber-600",   bg: "bg-amber-50",   description: "Platform settings, VPN detection, TOR node and zone cache lifetimes" },
  network:       { label: "Network & Retry",      icon: Wifi,            color: "text-cyan-600",    bg: "bg-cyan-50",    description: "API timeout, retry attempts, backoff delay, GPS queue size and dismissed-request TTL" },
  geo:           { label: "Geo & Zones",          icon: MapPin,          color: "text-emerald-600", bg: "bg-emerald-50", description: "Default zone radius and open-world fallback behavior" },
  uploads:       { label: "Upload Limits",        icon: ImageUp,         color: "text-cyan-600",    bg: "bg-cyan-50",    description: "Image/video file size limits and allowed formats" },
  pagination:    { label: "Pagination",           icon: List,            color: "text-lime-600",    bg: "bg-lime-50",    description: "Products per page, trending searches limit, flash deals display" },
  ratelimit:     { label: "Endpoint Rate Limits", icon: SlidersHorizontal, color: "text-rose-600", bg: "bg-rose-50",    description: "Per-endpoint rate limits for bargaining, booking, cancellation and estimates" },
};

const MONITORING_CATS: CatKey[] = ["system_limits", "cache", "network", "geo", "uploads", "pagination", "ratelimit"];

function getInputType(key: string) {
  if (key.includes("_url")) return "text";
  return "number";
}
function getInputSuffix(key: string) {
  if (key.includes("_pct") || key.includes("pct")) return "%";
  if (key.includes("_km")) return "KM";
  if (key.includes("_day") || key.includes("_days")) return "days";
  if (key.includes("_sec")) return "sec";
  if (key.includes("_ms")) return "ms";
  if (key.includes("_multiplier")) return "×";
  if (key === "security_rate_limit") return "req/min";
  return "#";
}
function getPlaceholder(key: string) {
  if (key.includes("_url")) return "https://...";
  return "";
}

export function MonitoringSection({ settings, grouped, localValues, dirtyKeys, handleChange, handleToggle }: SettingsSectionProps) {
  const cats = MONITORING_CATS.filter(cat => (grouped[cat]?.length ?? 0) > 0);

  if (cats.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-1 py-2">
        No monitoring settings configured yet.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {cats.map((cat, idx) => {
        const cfg = MONITORING_CAT_CONFIG[cat];
        const Icon = cfg?.icon ?? Server;
        const childSettings = grouped[cat] ?? [];
        const childDirty = Array.from(dirtyKeys).filter(k => {
          const s = settings.find(x => x.key === k);
          return s?.category === cat;
        }).length;

        return (
          <section key={cat} id={`sub-${cat}`} data-cat={cat} className={idx > 0 ? "pt-6 border-t border-border/50" : ""}>
            <div className="flex items-start gap-3 mb-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg?.bg ?? "bg-slate-50"}`}>
                <Icon className={`w-4 h-4 ${cfg?.color ?? "text-slate-600"}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-bold text-foreground">{cfg?.label ?? cat}</h3>
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
                <p className="text-[11px] text-muted-foreground mt-0.5">{cfg?.description ?? ""}</p>
              </div>
            </div>
            {childSettings.length === 0 ? (
              <p className="text-xs text-muted-foreground italic px-1 py-2">
                No settings configured for this sub-section yet.
              </p>
            ) : renderSection(
              cat, childSettings, settings, localValues, dirtyKeys,
              handleChange, handleToggle, getInputType, getInputSuffix, getPlaceholder,
            )}
          </section>
        );
      })}
    </div>
  );
}
