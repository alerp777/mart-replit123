import { Badge } from "@/components/ui/badge";
import { renderSection, CatKey, SettingsSectionProps } from "./settings-render";
import {
  Globe, Zap, Languages,
} from "lucide-react";

const GENERAL_CAT_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; description: string }> = {
  general:     { label: "General",              icon: Globe,      color: "text-gray-600",   bg: "bg-gray-50",   description: "App name, support contact, version and maintenance mode" },
  features:    { label: "Feature Toggles",      icon: Zap,        color: "text-violet-600", bg: "bg-violet-50", description: "Enable or disable each service across the entire platform instantly" },
  regional:    { label: "Regional & Validation",icon: Languages,  color: "text-lime-600",   bg: "bg-lime-50",   description: "Phone format, timezone, currency symbol and country code" },
  localization:{ label: "Localization",         icon: Languages,  color: "text-lime-600",   bg: "bg-lime-50",   description: "Currency code and symbol used across the platform" },
};

const GENERAL_CATS: CatKey[] = ["general", "regional", "localization", "features"];

function getInputType(key: string) { return key.includes("_url") || isNaN(Number("0")) ? "text" : "number"; }
function getInputSuffix(key: string) {
  if (key.includes("_pct") || key.includes("pct")) return "%";
  if (key.includes("_km") || key === "rider_acceptance_km") return "KM";
  if (key.includes("_day") || key.includes("_days") || key === "security_session_days") return "days";
  if (key.includes("_pts") || key.includes("_items") || key.includes("_deliveries")) return "#";
  if (key.includes("_sec")) return "sec";
  if (key.includes("_multiplier")) return "×";
  return "";
}
function getPlaceholder(key: string) {
  if (key.includes("_url")) return "https://...";
  return "";
}

export function GeneralSection({ settings, grouped, localValues, dirtyKeys, handleChange, handleToggle }: SettingsSectionProps) {
  const cats = GENERAL_CATS.filter(cat => (grouped[cat]?.length ?? 0) > 0);

  if (cats.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-1 py-2">
        No general settings configured yet.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {cats.map((cat, idx) => {
        const cfg = GENERAL_CAT_CONFIG[cat];
        const Icon = cfg?.icon ?? Globe;
        const childSettings = grouped[cat] ?? [];
        const childDirty = Array.from(dirtyKeys).filter(k => {
          const s = settings.find(x => x.key === k);
          return s?.category === cat;
        }).length;

        return (
          <section key={cat} id={`sub-${cat}`} data-cat={cat} className={idx > 0 ? "pt-6 border-t border-border/50" : ""}>
            <div className="flex items-start gap-3 mb-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg?.bg ?? "bg-gray-50"}`}>
                <Icon className={`w-4 h-4 ${cfg?.color ?? "text-gray-600"}`} />
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
