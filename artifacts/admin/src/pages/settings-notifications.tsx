import { Badge } from "@/components/ui/badge";
import { renderSection, CatKey, SettingsSectionProps } from "./settings-render";
import { Bell, MessageSquare } from "lucide-react";

const NOTIF_CAT_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; description: string }> = {
  notifications: { label: "Notifications",     icon: Bell,          color: "text-yellow-600", bg: "bg-yellow-50", description: "Email templates, push notification text, fraud alert thresholds" },
  content:       { label: "Content & Banners",  icon: MessageSquare, color: "text-pink-600",   bg: "bg-pink-50",   description: "Banners, announcements, notices for riders & vendors, policy links" },
};

const NOTIF_CATS: CatKey[] = ["notifications", "content"];

function getInputType(_key: string) { return "text"; }
function getInputSuffix(key: string) {
  if (key.includes("_pct") || key.includes("pct")) return "%";
  if (key.includes("_sec")) return "sec";
  if (key.includes("_multiplier")) return "×";
  return "";
}
function getPlaceholder(key: string) {
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
}

export function NotificationsSection({ settings, grouped, localValues, dirtyKeys, handleChange, handleToggle }: SettingsSectionProps) {
  const cats = NOTIF_CATS.filter(cat => (grouped[cat]?.length ?? 0) > 0);

  if (cats.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-1 py-2">
        No notification settings configured yet.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {cats.map((cat, idx) => {
        const cfg = NOTIF_CAT_CONFIG[cat];
        const Icon = cfg?.icon ?? Bell;
        const childSettings = grouped[cat] ?? [];
        const childDirty = Array.from(dirtyKeys).filter(k => {
          const s = settings.find(x => x.key === k);
          return s?.category === cat;
        }).length;

        return (
          <section key={cat} id={`sub-${cat}`} data-cat={cat} className={idx > 0 ? "pt-6 border-t border-border/50" : ""}>
            <div className="flex items-start gap-3 mb-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg?.bg ?? "bg-yellow-50"}`}>
                <Icon className={`w-4 h-4 ${cfg?.color ?? "text-yellow-600"}`} />
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
