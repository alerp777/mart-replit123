import { useState, useEffect } from "react";
import { AlertTriangle, MapPin } from "lucide-react";
import { GpsMiniMap } from "./GpsMiniMap";

export function GpsStampCard({ order }: { order: any }) {
  const cLat = Number(order.customerLat);
  const cLng = Number(order.customerLng);
  const dLat = order.deliveryLat != null ? Number(order.deliveryLat) : null;
  const dLng = order.deliveryLng != null ? Number(order.deliveryLng) : null;
  const hasDual = dLat != null && dLng != null && Number.isFinite(dLat) && Number.isFinite(dLng);
  const isMismatch = !!order.gpsMismatch;
  const [placeName, setPlaceName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${cLat}&lon=${cLng}&format=json&zoom=16&addressdetails=1`, {
      headers: { "Accept-Language": "en" },
    })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data?.display_name) {
          const parts = data.display_name.split(",").slice(0, 3).map((s: string) => s.trim());
          setPlaceName(parts.join(", "));
        }
      })
      .catch((err) => {
      });
    return () => { cancelled = true; };
  }, [cLat, cLng]);

  return (
    <section className={`rounded-xl overflow-hidden border ${isMismatch ? "border-amber-300" : "border-emerald-200"}`} aria-label="GPS location details">
      {isMismatch && (
        <div className="bg-amber-50 px-3 py-2 flex items-center gap-2 border-b border-amber-200" role="alert">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-[11px] font-bold text-amber-800">GPS Mismatch Warning</p>
            <p className="text-[10px] text-amber-700">Customer device GPS is far from the selected delivery address</p>
          </div>
        </div>
      )}
      <div className={`p-3 space-y-2 ${isMismatch ? "bg-amber-50/50" : "bg-emerald-50"}`}>
        <p className={`text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${isMismatch ? "text-amber-700" : "text-emerald-700"}`}>
          <MapPin className="w-3 h-3" aria-hidden="true" /> Customer GPS Location
          {!isMismatch && <span className="ml-1 text-[9px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded-full">Match OK</span>}
        </p>
        {placeName && (
          <p className="text-xs font-medium text-gray-800">{placeName}</p>
        )}
        <p className="text-[10px] font-mono text-gray-500">
          Placed from: {cLat.toFixed(5)}, {cLng.toFixed(5)}
        </p>
        {hasDual && (
          <p className="text-[10px] font-mono text-gray-500">
            Delivery to: {dLat!.toFixed(5)}, {dLng!.toFixed(5)}
          </p>
        )}
        {order.gpsAccuracy != null && (
          <p className="text-[10px] text-muted-foreground">GPS Accuracy: +/-{Math.round(Number(order.gpsAccuracy))}m</p>
        )}
        <GpsMiniMap cLat={cLat} cLng={cLng} dLat={dLat} dLng={dLng} />
        {hasDual && (
          <div className="flex gap-3 text-[9px]">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" aria-hidden="true" /> Placed from</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" aria-hidden="true" /> Delivery address</span>
          </div>
        )}
        <div className="flex items-start gap-1.5 pt-1">
          <MapPin className="w-3 h-3 text-gray-500 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-[10px] text-gray-600">
            <span className="font-semibold">Delivery Address:</span> {order.deliveryAddress || "—"}
          </p>
        </div>
      </div>
    </section>
  );
}
