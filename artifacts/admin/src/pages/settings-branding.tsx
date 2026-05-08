import { Palette, MapPin, CheckCircle2, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Setting { key: string; value: string; label: string; category: string; }

const BRAND_COLORS = [
  { key: "brand_color_mart",     label: "Mart / Grocery",  emoji: "🛒", default: "#7C3AED" },
  { key: "brand_color_food",     label: "Food Delivery",   emoji: "🍔", default: "#EF4444" },
  { key: "brand_color_rides",    label: "Rides",           emoji: "🚗", default: "#0EA5E9" },
  { key: "brand_color_pharmacy", label: "Pharmacy",        emoji: "💊", default: "#10B981" },
  { key: "brand_color_parcel",   label: "Parcel Delivery", emoji: "📦", default: "#F59E0B" },
  { key: "brand_color_van",      label: "Van / Inter-city",emoji: "🚌", default: "#6366F1" },
];

const MAP_KEYS = [
  { key: "brand_map_center_lat",   label: "Map Center Latitude",  placeholder: "34.370" },
  { key: "brand_map_center_lng",   label: "Map Center Longitude", placeholder: "73.471" },
  { key: "brand_map_center_label", label: "Map Label",            placeholder: "Muzaffarabad" },
];

function ColorSwatch({ color }: { color: string }) {
  const isValid = /^#[0-9A-Fa-f]{3,6}$/.test(color);
  return (
    <span
      className="inline-block w-5 h-5 rounded-md border border-white/50 shadow-sm flex-shrink-0"
      style={{ backgroundColor: isValid ? color : "#e2e8f0" }}
      title={color}
    />
  );
}

export function BrandingSection({
  localValues = {},
  dirtyKeys = new Set<string>(),
  handleChange = () => {},
  settings = [],
}: {
  localValues?: Record<string, string>;
  dirtyKeys?: Set<string>;
  handleChange?: (k: string, v: string) => void;
  handleToggle?: (k: string, v: boolean) => void;
  settings?: Setting[];
}) {
  const v = (key: string, def = "") =>
    localValues[key] ?? settings.find(s => s.key === key)?.value ?? def;

  return (
    <div className="space-y-6">
      {/* Service Colors */}
      <div className="rounded-2xl border-2 border-fuchsia-200 bg-white overflow-hidden">
        <div className="bg-fuchsia-50 px-5 py-4 flex items-center gap-3 border-b border-fuchsia-200">
          <div className="w-10 h-10 rounded-xl bg-fuchsia-100 flex items-center justify-center">
            <Palette className="w-5 h-5 text-fuchsia-600" />
          </div>
          <div>
            <h3 className="font-bold text-base text-fuchsia-900">Service Brand Colors</h3>
            <p className="text-xs text-fuchsia-600 mt-0.5">
              Accent colors for each service in the customer app
            </p>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Color preview bar */}
          <div className="flex gap-1.5 mb-2">
            {BRAND_COLORS.map(bc => {
              const color = v(bc.key, bc.default);
              const isValid = /^#[0-9A-Fa-f]{3,6}$/.test(color);
              return (
                <div
                  key={bc.key}
                  className="flex-1 h-3 rounded-full"
                  style={{ backgroundColor: isValid ? color : bc.default }}
                  title={`${bc.label}: ${color}`}
                />
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {BRAND_COLORS.map(bc => {
              const color = v(bc.key, bc.default);
              const isDirty = dirtyKeys.has(bc.key);
              const isValid = /^#[0-9A-Fa-f]{3,6}$/.test(color);
              return (
                <div key={bc.key} className={`rounded-xl border p-3 ${isDirty ? "border-amber-300 bg-amber-50/30" : "border-slate-200"}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">{bc.emoji}</span>
                    <label className="text-xs font-semibold text-slate-700 flex-1">{bc.label}</label>
                    {isDirty && (
                      <Badge variant="outline" className="text-[9px] bg-amber-50 text-amber-700 border-amber-200 font-bold">
                        CHANGED
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <ColorSwatch color={color} />
                    <input
                      type="text"
                      value={color}
                      onChange={e => handleChange(bc.key, e.target.value)}
                      placeholder={bc.default}
                      className={`flex-1 h-8 rounded-lg border text-xs px-2 font-mono focus:outline-none focus:ring-2 focus:ring-fuchsia-200 ${
                        isDirty ? "border-amber-300 bg-amber-50/50" : "border-slate-200"
                      } ${!isValid && color ? "border-red-300 bg-red-50/30" : ""}`}
                    />
                    <input
                      type="color"
                      value={isValid ? color : bc.default}
                      onChange={e => handleChange(bc.key, e.target.value)}
                      className="w-8 h-8 rounded-lg border border-slate-200 cursor-pointer p-0.5 bg-white"
                      title="Pick color"
                    />
                  </div>
                  {color && !isValid && (
                    <p className="text-[10px] text-red-500 mt-1">Must be a valid hex color (e.g. #7C3AED)</p>
                  )}
                  <p className="text-[10px] text-muted-foreground font-mono mt-1">{bc.key}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Map Center */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50">
          <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center">
            <MapPin className="w-4 h-4 text-slate-600" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-slate-800">Map Default Center</h3>
            <p className="text-xs text-slate-500">Where the map is centered when the app opens (before GPS lock)</p>
          </div>
        </div>

        <div className="p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {MAP_KEYS.map(mk => {
              const val = v(mk.key);
              const isDirty = dirtyKeys.has(mk.key);
              return (
                <div key={mk.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-slate-700">{mk.label}</label>
                    {isDirty && (
                      <Badge variant="outline" className="text-[9px] bg-amber-50 text-amber-700 border-amber-200 font-bold">
                        CHANGED
                      </Badge>
                    )}
                  </div>
                  <input
                    type="text"
                    value={val}
                    onChange={e => handleChange(mk.key, e.target.value)}
                    placeholder={mk.placeholder}
                    className={`w-full h-9 rounded-xl border text-sm px-3 focus:outline-none focus:ring-2 focus:ring-slate-300 font-mono ${
                      isDirty ? "border-amber-300 bg-amber-50/50" : "border-slate-200"
                    }`}
                  />
                  <p className="text-[10px] text-muted-foreground font-mono">{mk.key}</p>
                </div>
              );
            })}
          </div>

          {/* Preview */}
          {(v("brand_map_center_lat") || v("brand_map_center_lng")) && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <div className="flex items-center gap-1.5 mb-2">
                <Eye className="w-3.5 h-3.5 text-slate-400" />
                <p className="text-[11px] font-bold text-slate-500">Map center preview</p>
              </div>
              <div className="bg-slate-50 rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-3">
                <MapPin className="w-4 h-4 text-slate-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-700">{v("brand_map_center_label") || "Unnamed location"}</p>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    {v("brand_map_center_lat")}, {v("brand_map_center_lng")}
                  </p>
                </div>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${v("brand_map_center_lat")}&mlon=${v("brand_map_center_lng")}&zoom=13`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-xs text-blue-600 hover:underline font-medium flex items-center gap-1"
                >
                  <CheckCircle2 className="w-3 h-3" /> Verify on OSM
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
