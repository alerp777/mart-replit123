import { useState, useEffect } from "react";
import { PageHeader } from "@/components/shared";
import { usePharmacyOrders, useUpdatePharmacyOrder } from "@/hooks/use-admin";
import { formatCurrency, formatDate, getStatusColor } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useErrorHandler } from "@/hooks/useErrorHandler";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill, Search, FileText, User, ShoppingCart, Phone, TrendingUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/lib/useLanguage";
import { tDual, type TranslationKey } from "@workspace/i18n";

const STATUSES = ["pending", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];

const STATUS_LABELS: Record<string, string> = {
  pending:          "Pending",
  confirmed:        "Confirmed",
  preparing:        "Preparing",
  out_for_delivery: "Out for Delivery",
  delivered:        "Delivered",
  cancelled:        "Cancelled",
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending:          ["confirmed", "cancelled"],
  confirmed:        ["preparing", "cancelled"],
  preparing:        ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered:        ["delivered"],
  cancelled:        ["cancelled"],
};

const isTerminal = (s: string) => s === "delivered" || s === "cancelled";

export default function Pharmacy() {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { data, isLoading } = usePharmacyOrders();
  const updateMutation = useUpdatePharmacyOrder();
  const { toast } = useToast();

  const [search, setSearch]               = useState("");
  const [statusFilter, setStatusFilter]   = useState("all");
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling]               = useState(false);

  const { onError: onUpdateStatusError } = useErrorHandler({ title: "Update failed" });
  const { onError: onCancelOrderError } = useErrorHandler({ title: "Cancel failed", onError: () => setCancelling(false) });

  const handleUpdateStatus = (id: string, status: string, currentStatus?: string) => {
    if (currentStatus && !ALLOWED_TRANSITIONS[currentStatus]?.includes(status)) {
      toast({ title: "Invalid transition", description: `Can't move ${STATUS_LABELS[currentStatus]} → ${STATUS_LABELS[status]}`, variant: "destructive" }); return;
    }
    updateMutation.mutate({ id, status }, {
      onSuccess: () => toast({ title: `Status → ${STATUS_LABELS[status]} ✅` }),
      onError: onUpdateStatusError,
    });
  };

  const handleAdminCancel = () => {
    if (!selectedOrder) return;
    setCancelling(true);
    updateMutation.mutate({ id: selectedOrder.id, status: "cancelled" }, {
      onSuccess: () => {
        setSelectedOrder({ ...selectedOrder, status: "cancelled" });
        setShowCancelConfirm(false);
        setCancelling(false);
        toast({ title: "Order cancelled ✅" + (selectedOrder.paymentMethod === "wallet" ? " — Wallet refund issued" : "") });
      },
      onError: onCancelOrderError,
    });
  };

  const orders  = data?.orders || [];
  const q       = search.toLowerCase();

  const filtered = orders.filter((o: any) => {
    const matchSearch =
      o.id.toLowerCase().includes(q) ||
      (o.userName  || "").toLowerCase().includes(q) ||
      (o.userPhone || "").includes(q);
    const matchStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && ["confirmed", "preparing", "out_for_delivery"].includes(o.status)) ||
      o.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const pendingOrders  = orders.filter((o: any) => o.status === "pending");
  const pendingCount   = pendingOrders.length;
  const activeCount    = orders.filter((o: any) => ["confirmed","preparing","out_for_delivery"].includes(o.status)).length;
  const deliveredCount = orders.filter((o: any) => o.status === "delivered").length;
  const cancelledCount = orders.filter((o: any) => o.status === "cancelled").length;
  const totalRevenue   = orders.filter((o: any) => o.status === "delivered").reduce((s: number, o: any) => s + parseFloat(o.total || 0), 0);

  /* Last-refreshed ticker */
  const [secAgo, setSecAgo] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(new Date());
  useEffect(() => { if (!isLoading) { setLastRefreshed(new Date()); setSecAgo(0); } }, [isLoading]);
  useEffect(() => {
    const t = setInterval(() => setSecAgo(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [lastRefreshed]);

  return (
    <div className="space-y-5 sm:space-y-6">

      <PageHeader
        icon={Pill}
        title={T("pharmacyOrders")}
        subtitle={`${T("medicineDeliveries")} — ${orders.length} ${T("total")}`}
        iconBgClass="bg-pink-100"
        iconColorClass="text-pink-600"
        actions={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`w-2 h-2 rounded-full ${secAgo < 35 ? "bg-green-500" : "bg-amber-400"} animate-pulse`} />
            {isLoading ? "Refreshing..." : `Refreshed ${secAgo}s ago`}
          </div>
        }
      />

      {/* Pending pharmacy orders alert */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 bg-pink-50 border-2 border-pink-300 rounded-2xl px-4 py-3">
          <span className="text-2xl">💊</span>
          <div className="flex-1">
            <p className="text-sm font-bold text-pink-800">
              {pendingCount} pharmacy order{pendingCount > 1 ? "s" : ""} waiting for confirmation!
            </p>
            <p className="text-xs text-pink-600">
              {pendingOrders.slice(0,3).map((o: any) => `#${o.id.slice(-6).toUpperCase()}`).join(" · ")}
              {pendingOrders.length > 3 ? ` +${pendingOrders.length - 3} more` : ""}
            </p>
          </div>
          <button
            onClick={() => setStatusFilter("pending")}
            className="px-3 py-1.5 bg-pink-500 text-white text-xs font-bold rounded-xl whitespace-nowrap hover:bg-pink-600 transition-colors"
          >
            View All
          </button>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="p-4 rounded-2xl border-border/50 shadow-sm text-center">
          <p className="text-3xl font-bold text-foreground">{orders.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{T("totalOrders")}</p>
        </Card>
        <Card className="p-4 rounded-2xl border-border/50 shadow-sm text-center bg-yellow-50/60 border-yellow-200/60">
          <p className="text-3xl font-bold text-yellow-700">{pendingCount}</p>
          <p className="text-xs text-yellow-500 mt-1">{T("pending")}</p>
        </Card>
        <Card className="p-4 rounded-2xl border-border/50 shadow-sm text-center bg-blue-50/60 border-blue-200/60">
          <p className="text-3xl font-bold text-blue-700">{activeCount}</p>
          <p className="text-xs text-blue-500 mt-1">{T("activeNow")}</p>
        </Card>
        <Card className="p-4 rounded-2xl border-border/50 shadow-sm text-center bg-green-50/60 border-green-200/60">
          <p className="text-3xl font-bold text-green-700">{deliveredCount}</p>
          <p className="text-xs text-green-500 mt-1">{T("delivered")}</p>
        </Card>
        <Card className="p-4 rounded-2xl border-border/50 shadow-sm text-center bg-amber-50/60 border-amber-200/60 sm:col-span-1 col-span-2">
          <div className="flex items-center justify-center gap-1 mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <p className="text-2xl font-bold text-amber-700">{formatCurrency(totalRevenue)}</p>
          <p className="text-xs text-amber-500 mt-1">{T("revenue")}</p>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-3 sm:p-4 rounded-2xl border-border/50 shadow-sm flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by ID, customer name or phone..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-10 sm:h-11 rounded-xl bg-muted/30 border-border/50 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { key: "all",              label: "All",              cls: "border-border/50 text-muted-foreground hover:border-primary" },
            { key: "pending",          label: "🟡 Pending",       cls: "border-yellow-300 text-yellow-700 bg-yellow-50" },
            { key: "active",           label: "🔵 Active",        cls: "border-blue-300 text-blue-700 bg-blue-50" },
            { key: "out_for_delivery", label: "🛵 Out for Delivery", cls: "border-indigo-300 text-indigo-700 bg-indigo-50" },
            { key: "delivered",        label: "✅ Delivered",     cls: "border-green-300 text-green-700 bg-green-50" },
            { key: "cancelled",        label: "❌ Cancelled",     cls: "border-red-300 text-red-600 bg-red-50" },
          ].map(({ key, label, cls }) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                statusFilter === key ? "bg-primary text-white border-primary" : `bg-muted/30 ${cls}`
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {/* Mobile card list — shown below md breakpoint */}
      <section className="md:hidden space-y-3" aria-label="Pharmacy orders">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="rounded-2xl border-border/50 shadow-sm p-4 animate-pulse">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <div className="h-4 w-28 bg-muted rounded" />
                  <div className="h-3 w-20 bg-muted rounded" />
                </div>
                <div className="h-5 w-16 bg-muted rounded-full" />
              </div>
            </Card>
          ))
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="font-semibold text-muted-foreground">No orders found.</p>
          </div>
        ) : (
          filtered.map((order: any) => (
            <Card
              key={order.id}
              role="button"
              tabIndex={0}
              aria-label={`View pharmacy order ${order.id.slice(-8).toUpperCase()}, ${STATUS_LABELS[order.status] ?? order.status}`}
              className="rounded-2xl border-border/50 shadow-sm overflow-hidden cursor-pointer"
              onClick={() => { setSelectedOrder(order); setShowCancelConfirm(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedOrder(order); setShowCancelConfirm(false); } }}
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono font-semibold text-sm">{order.id.slice(-8).toUpperCase()}</p>
                    <Badge variant="outline" className="mt-1 text-[10px] bg-pink-50 text-pink-600 border-pink-200">💊 Pharmacy</Badge>
                  </div>
                  <Badge className={`text-[10px] font-bold uppercase shrink-0 ${getStatusColor(order.status)}`}>
                    {STATUS_LABELS[order.status] ?? order.status}
                  </Badge>
                </div>
                {order.userName && (
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0" aria-hidden="true">
                      <User className="w-3.5 h-3.5 text-pink-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{order.userName}</p>
                      <p className="text-xs text-muted-foreground">{order.userPhone}</p>
                    </div>
                  </div>
                )}
                {order.prescriptionNote && (
                  <div className="flex items-start gap-2 bg-amber-50 text-amber-900 p-2 rounded-lg text-xs">
                    <FileText className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="truncate">{order.prescriptionNote}</p>
                  </div>
                )}
                <div className="flex items-center justify-between pt-2 border-t border-border/50">
                  <div>
                    <p className="font-bold">{formatCurrency(order.total)}</p>
                    <p className="text-xs text-muted-foreground capitalize">{order.paymentMethod === "wallet" ? "💳 Wallet" : "💵 Cash"}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* Desktop table — hidden below md breakpoint */}
      <Card className="hidden md:block rounded-2xl border-border/50 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="font-semibold">{T("orderId")}</TableHead>
                <TableHead className="font-semibold">{T("customer")}</TableHead>
                <TableHead className="font-semibold">{T("prescription")}</TableHead>
                <TableHead className="font-semibold">{T("total")}</TableHead>
                <TableHead className="font-semibold">{T("status")}</TableHead>
                <TableHead className="font-semibold text-right">{T("date")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Loading pharmacy orders...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No orders found.</TableCell></TableRow>
              ) : (
                filtered.map((order: any) => (
                  <TableRow key={order.id} className="hover:bg-muted/30 cursor-pointer" onClick={() => { setSelectedOrder(order); setShowCancelConfirm(false); }}>
                    <TableCell>
                      <p className="font-mono font-medium text-sm">{order.id.slice(-8).toUpperCase()}</p>
                      <Badge variant="outline" className="mt-1 text-[10px] bg-pink-50 text-pink-600 border-pink-200">💊 Pharmacy</Badge>
                    </TableCell>
                    <TableCell>
                      {order.userName ? (
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center shrink-0">
                            <User className="w-3.5 h-3.5 text-pink-600" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold">{order.userName}</p>
                            <p className="text-xs text-muted-foreground">{order.userPhone}</p>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Unknown</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      {order.prescriptionNote ? (
                        <div className="flex items-start gap-2 bg-amber-50 text-amber-900 p-2 rounded-lg text-xs">
                          <FileText className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <p className="truncate">{order.prescriptionNote}</p>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">No note</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="font-bold">{formatCurrency(order.total)}</p>
                      <p className="text-xs text-muted-foreground capitalize">{order.paymentMethod === "wallet" ? "💳 Wallet" : "💵 Cash"}</p>
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <Select
                        value={order.status}
                        onValueChange={(val) => {
                          if (!ALLOWED_TRANSITIONS[order.status]?.includes(val)) {
                            toast({ title: "Invalid transition", description: `Can't move ${STATUS_LABELS[order.status]} → ${STATUS_LABELS[val]}`, variant: "destructive" }); return;
                          }
                          handleUpdateStatus(order.id, val);
                        }}
                      >
                        <SelectTrigger className={`w-36 h-8 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider border-2 ${getStatusColor(order.status)}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALLOWED_TRANSITIONS[order.status]?.map(s => (
                            <SelectItem key={s} value={s} className="text-xs uppercase font-bold">{STATUS_LABELS[s] ?? s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                      {formatDate(order.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Order Detail Modal */}
      <Dialog open={!!selectedOrder} onOpenChange={open => { if (!open) { setSelectedOrder(null); setShowCancelConfirm(false); } }}>
        <DialogContent className="w-[95vw] max-w-lg rounded-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pill className="w-5 h-5 text-pink-600" />
              Pharmacy Order Detail
              {selectedOrder && (
                <Badge variant="outline" className={`ml-2 text-[10px] font-bold uppercase ${getStatusColor(selectedOrder.status)}`}>
                  {STATUS_LABELS[selectedOrder.status]}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {selectedOrder && (
            <div className="space-y-4 mt-2">

              {/* Cancel Confirmation Inline */}
              {showCancelConfirm && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                    <p className="text-sm font-bold text-red-700">Cancel Order #{selectedOrder.id.slice(-6).toUpperCase()}?</p>
                  </div>
                  <p className="text-xs text-red-600">
                    {selectedOrder.paymentMethod === "wallet"
                      ? `${formatCurrency(Math.round(parseFloat(selectedOrder.total)))} customer ki wallet mein refund ho jayega.`
                      : "Cash order — no refund needed."}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => setShowCancelConfirm(false)}
                      className="flex-1 h-9 bg-white border border-red-200 text-red-600 text-sm font-bold rounded-xl">
                      Back
                    </button>
                    <button onClick={handleAdminCancel} disabled={cancelling}
                      className="flex-1 h-9 bg-red-600 text-white text-sm font-bold rounded-xl disabled:opacity-60">
                      {cancelling ? "Cancelling..." : "Confirm Cancel"}
                    </button>
                  </div>
                </div>
              )}

              {/* Info grid */}
              <div className="bg-muted/40 rounded-xl p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order ID</span>
                  <span className="font-mono font-bold">{selectedOrder.id.slice(-8).toUpperCase()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-bold text-foreground">{formatCurrency(selectedOrder.total)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Payment</span>
                  <span className={`font-medium ${selectedOrder.paymentMethod === "wallet" ? "text-blue-600" : "text-green-600"}`}>
                    {selectedOrder.paymentMethod === "wallet" ? "💳 Wallet" : "💵 Cash"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase border ${getStatusColor(selectedOrder.status)}`}>
                    {STATUS_LABELS[selectedOrder.status]}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ordered</span>
                  <span className="text-xs">{formatDate(selectedOrder.createdAt)}</span>
                </div>
              </div>

              {/* Customer Contact */}
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 space-y-1.5">
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wide flex items-center gap-1">
                  <User className="w-3 h-3" /> Customer
                </p>
                <p className="text-sm font-semibold text-gray-800">{selectedOrder.userName || "Unknown"}</p>
                {selectedOrder.userPhone && (
                  <div className="flex gap-2 pt-1">
                    <a href={`tel:${selectedOrder.userPhone}`}
                      className="flex items-center gap-1.5 bg-white border border-blue-200 text-blue-700 text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors">
                      <Phone className="w-3 h-3" /> {selectedOrder.userPhone}
                    </a>
                    <a href={`https://wa.me/92${selectedOrder.userPhone.replace(/^(\+92|0)/, "")}`}
                      target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-green-100 transition-colors">
                      💬 WhatsApp
                    </a>
                  </div>
                )}
              </div>

              {/* Prescription Note + Photo */}
              {(selectedOrder.prescriptionNote || selectedOrder.prescriptionPhotoUri) && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-bold text-amber-700 flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5" /> Prescription
                  </p>
                  {selectedOrder.prescriptionNote && (
                    <p className="text-sm text-amber-900">{selectedOrder.prescriptionNote}</p>
                  )}
                  {selectedOrder.prescriptionPhotoUri && (
                    <div className="mt-2">
                      <a href={selectedOrder.prescriptionPhotoUri} target="_blank" rel="noopener noreferrer">
                        <img
                          src={selectedOrder.prescriptionPhotoUri}
                          alt="Prescription"
                          className="w-full max-h-56 object-contain rounded-lg border border-amber-200 cursor-pointer hover:opacity-90 transition-opacity bg-white"
                        />
                      </a>
                      <p className="text-[10px] text-amber-600 mt-1">Click to open full image</p>
                    </div>
                  )}
                </div>
              )}

              {/* Items */}
              {Array.isArray(selectedOrder.items) && selectedOrder.items.length > 0 && (
                <div>
                  <p className="text-sm font-bold mb-2 flex items-center gap-2">
                    <ShoppingCart className="w-4 h-4" /> Items ({selectedOrder.items.length})
                  </p>
                  <div className="space-y-2">
                    {selectedOrder.items.map((item: any, i: number) => (
                      <div key={i} className="flex justify-between items-center text-sm bg-muted/30 rounded-lg px-3 py-2">
                        <span className="font-medium">{item.name}</span>
                        <span className="text-muted-foreground">×{item.quantity} — {formatCurrency(item.price)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                {!isTerminal(selectedOrder.status) && (
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground font-medium mb-1.5">Move to Next Status</p>
                    <Select
                      value={selectedOrder.status}
                      onValueChange={(val) => {
                        if (val === selectedOrder.status) return;
                        handleUpdateStatus(selectedOrder.id, val, selectedOrder.status);
                        setSelectedOrder({ ...selectedOrder, status: val });
                      }}
                    >
                      <SelectTrigger className={`h-9 text-[11px] font-bold uppercase tracking-wider border-2 ${getStatusColor(selectedOrder.status)}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ALLOWED_TRANSITIONS[selectedOrder.status]?.filter(s => s !== "cancelled").map(s => (
                          <SelectItem key={s} value={s} className="text-xs uppercase font-bold">
                            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-green-500" />{STATUS_LABELS[s]}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {!isTerminal(selectedOrder.status) && !showCancelConfirm && (
                  <div>
                    <p className="text-xs text-muted-foreground font-medium mb-1.5">Admin Actions</p>
                    <button
                      onClick={() => setShowCancelConfirm(true)}
                      className="h-9 px-4 bg-red-50 hover:bg-red-100 border-2 border-red-300 text-red-600 text-xs font-bold rounded-xl whitespace-nowrap transition-colors flex items-center gap-1.5"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Cancel & Refund
                    </button>
                  </div>
                )}
              </div>

            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
