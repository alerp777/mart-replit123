import { useState } from "react";
import { ShoppingBag, User, Package, Phone, CheckCircle2, AlertTriangle, Receipt, RotateCcw, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileDrawer } from "@/components/MobileDrawer";
import { StatusBadge } from "@/components/AdminShared";
import { formatCurrency, formatDate, getStatusColor } from "@/lib/format";
import { GpsStampCard } from "./GpsStampCard";
import { CancelConfirmDialog } from "./CancelConfirmDialog";
import { RefundConfirmDialog } from "./RefundConfirmDialog";
import { RiderAssignPanel } from "./RiderAssignPanel";
import { STATUS_LABELS, allowedNext, isTerminal, canCancel } from "./constants";
import { fetcher } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

/* ── Return Request Panel ── */
function ReturnPanel({ order }: { order: any }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(String(order.total ?? ""));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!reason.trim()) { toast({ title: "Reason required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      await fetcher(`/orders/${order.id}/return`, { method: "POST", body: JSON.stringify({ reason: reason.trim(), amount: parseFloat(amount) || order.total }) });
      toast({ title: "Return request submitted", description: "Admin team will review and process the refund." });
      setSubmitted(true);
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    }
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl p-4">
        <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-green-800">Return submitted</p>
          <p className="text-xs text-green-600">Team will process the refund within 24–48 hrs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
        <p className="font-semibold text-amber-800">Order #{order.id?.slice(-8).toUpperCase()}</p>
        <p className="text-amber-700 mt-0.5">Total: <strong>{formatCurrency(order.total)}</strong> · {order.paymentMethod === "wallet" ? "Wallet" : "Cash"}</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Return Reason *</label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Describe why the return is needed (damaged item, wrong product, etc.)"
          rows={3}
          className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Refund Amount (Rs.)</label>
        <Input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          min="1"
          max={order.total}
          step="1"
          className="h-10 rounded-xl"
          placeholder="Partial or full refund"
        />
        <p className="text-xs text-muted-foreground">Max: {formatCurrency(order.total)}</p>
      </div>
      <Button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full h-10 rounded-xl bg-amber-600 hover:bg-amber-700 text-white gap-2"
      >
        <RotateCcw className="w-4 h-4" />
        {submitting ? "Submitting…" : "Submit Return Request"}
      </Button>
    </div>
  );
}

/* ── Dispute Panel ── */
function DisputePanel({ order }: { order: any }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [type, setType] = useState("wrong_item");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!note.trim()) { toast({ title: "Details required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      await fetcher(`/orders/${order.id}/dispute`, { method: "POST", body: JSON.stringify({ type, note: note.trim() }) });
      toast({ title: "Dispute filed", description: "Order flagged for admin review." });
      setSubmitted(true);
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    }
    setSubmitting(false);
  };

  const DISPUTE_TYPES = [
    { value: "wrong_item", label: "Wrong item delivered" },
    { value: "not_delivered", label: "Not delivered" },
    { value: "damaged", label: "Item damaged" },
    { value: "overcharged", label: "Overcharged" },
    { value: "fraud", label: "Suspected fraud" },
    { value: "other", label: "Other" },
  ];

  if (submitted) {
    return (
      <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
        <Flag className="w-5 h-5 text-red-600 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-red-800">Dispute filed</p>
          <p className="text-xs text-red-600">Order flagged for investigation. You'll be notified of the outcome.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm">
        <p className="font-semibold text-red-800">File a dispute for Order #{order.id?.slice(-8).toUpperCase()}</p>
        <p className="text-red-700 mt-0.5">Disputes are reviewed by the admin team within 24 hrs.</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Dispute Type</label>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="w-full h-10 rounded-xl border border-input bg-background px-3 text-sm"
        >
          {DISPUTE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Details *</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Provide full context — what happened, what was expected, any evidence..."
          rows={4}
          className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <Button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full h-10 rounded-xl bg-red-600 hover:bg-red-700 text-white gap-2"
      >
        <Flag className="w-4 h-4" />
        {submitting ? "Filing…" : "File Dispute"}
      </Button>
    </div>
  );
}

interface OrderDetailDrawerProps {
  selectedOrder: any;
  onClose: () => void;
  showCancelConfirm: boolean;
  setShowCancelConfirm: (v: boolean) => void;
  showRefundConfirm: boolean;
  setShowRefundConfirm: (v: boolean) => void;
  refundAmount: string;
  setRefundAmount: (v: string) => void;
  refundReason: string;
  setRefundReason: (v: string) => void;
  cancelling: boolean;
  onCancelOrder: () => void;
  onRefundOrder: () => void;
  refundPending: boolean;
  showAssignRider: boolean;
  setShowAssignRider: (v: boolean) => void;
  riderSearch: string;
  setRiderSearch: (v: string) => void;
  ridersData: any;
  onAssignRider: (rider: any) => void;
  assignPending: boolean;
  onUpdateStatus: (id: string, status: string, extra?: { localUpdate?: any }) => void;
  onDeliverConfirm: (id: string) => void;
}

export function OrderDetailDrawer({
  selectedOrder, onClose, showCancelConfirm, setShowCancelConfirm, showRefundConfirm, setShowRefundConfirm,
  refundAmount, setRefundAmount, refundReason, setRefundReason, cancelling, onCancelOrder, onRefundOrder,
  refundPending, showAssignRider, setShowAssignRider, riderSearch, setRiderSearch, ridersData,
  onAssignRider, assignPending, onUpdateStatus, onDeliverConfirm,
}: OrderDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<"details" | "return" | "dispute">("details");

  return (
    <MobileDrawer
      open={!!selectedOrder}
      onClose={() => { setActiveTab("details"); onClose(); }}
      title={<><ShoppingBag className="w-5 h-5 text-indigo-600" aria-hidden="true" /> Order Detail {selectedOrder && <StatusBadge status={selectedOrder.status} />}</>}
      dialogClassName="w-[95vw] max-w-lg rounded-3xl max-h-[90vh] overflow-y-auto"
    >
      {selectedOrder && (
        <div className="space-y-4 mt-2">
          {/* Tab navigation */}
          <div className="border-b flex gap-1 -mx-1">
            {([
              { key: "details" as const,  label: "Details",         icon: ShoppingBag },
              { key: "return"  as const,  label: "Return Request",  icon: RotateCcw },
              { key: "dispute" as const,  label: "Dispute",         icon: Flag },
            ] as const).map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${activeTab === t.key ? "border-indigo-600 text-indigo-700" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === "return" && <ReturnPanel order={selectedOrder} />}
          {activeTab === "dispute" && <DisputePanel order={selectedOrder} />}
          {activeTab === "details" && <>

          {showCancelConfirm && (
            <CancelConfirmDialog
              order={selectedOrder}
              cancelling={cancelling}
              onCancel={onCancelOrder}
              onBack={() => setShowCancelConfirm(false)}
            />
          )}

          {showRefundConfirm && (
            <RefundConfirmDialog
              order={selectedOrder}
              refundAmount={refundAmount}
              setRefundAmount={setRefundAmount}
              refundReason={refundReason}
              setRefundReason={setRefundReason}
              isPending={refundPending}
              onRefund={onRefundOrder}
              onBack={() => setShowRefundConfirm(false)}
            />
          )}

          <section className="bg-muted/40 rounded-xl p-4 space-y-2.5 text-sm" aria-label="Order information">
            <h2 className="sr-only">Order Information</h2>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order ID</span>
              <span className="font-mono font-bold">{selectedOrder.id.slice(-8).toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <Badge variant={selectedOrder.type === "food" ? "default" : "secondary"} className="capitalize">
                {selectedOrder.type === "food" ? "\uD83C\uDF54 " : selectedOrder.type === "pharmacy" ? "\uD83D\uDC8A " : "\uD83D\uDED2 "}{selectedOrder.type}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-bold text-lg text-foreground">{formatCurrency(selectedOrder.total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Payment</span>
              <span className={`font-medium capitalize ${selectedOrder.paymentMethod === "wallet" ? "text-blue-600" : "text-green-600"}`}>
                {selectedOrder.paymentMethod === "wallet" ? "Wallet" : "Cash"}
              </span>
            </div>
            <div className="flex justify-between items-start gap-4">
              <span className="text-muted-foreground shrink-0">Delivery Address</span>
              <span className="text-right text-xs break-words max-w-[220px]">{selectedOrder.deliveryAddress || "\u2014"}</span>
            </div>
          </section>

          {(selectedOrder.customerLat != null && selectedOrder.customerLng != null) && (
            <GpsStampCard order={selectedOrder} />
          )}

          {selectedOrder.proofPhotoUrl && (() => {
            const rawUrl: string = selectedOrder.proofPhotoUrl as string;
            const apiBase = window.location.origin;
            const resolvedUrl = /^\/api\/uploads\/[\w.\-]+$/.test(rawUrl) || /^\/uploads\/[\w.\-]+$/.test(rawUrl)
              ? `${apiBase}${rawUrl}`
              : (() => { try { const u = new URL(rawUrl); return (u.protocol === "https:" || u.protocol === "http:") && (u.pathname.startsWith("/api/uploads/") || u.pathname.startsWith("/uploads/")) ? rawUrl : null; } catch { return null; } })();
            if (!resolvedUrl) return null;
            return (
              <section className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2" aria-label="Payment proof">
                <h3 className="text-[10px] font-bold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                  <Receipt className="w-3 h-3" aria-hidden="true" /> Payment Receipt
                  {selectedOrder.txnRef && (
                    <span className="ml-auto text-amber-600 normal-case text-[10px] font-normal">Txn: {selectedOrder.txnRef}</span>
                  )}
                </h3>
                <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="block" aria-label="View full payment receipt image">
                  <img
                    src={resolvedUrl}
                    alt="Payment receipt"
                    className="w-full max-h-56 object-contain rounded-lg border border-amber-200 bg-white"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                  <p className="text-[10px] text-amber-600 mt-1 text-center">Click to view full image</p>
                </a>
              </section>
            );
          })()}

          <section className="bg-blue-50 border border-blue-100 rounded-xl p-3 space-y-1" aria-label="Customer contact">
            <h3 className="text-[10px] font-bold text-blue-600 uppercase tracking-wide flex items-center gap-1"><User className="w-3 h-3" aria-hidden="true" /> Customer</h3>
            <p className="text-sm font-semibold text-gray-800">{selectedOrder.userName || "Guest"}</p>
            {selectedOrder.userPhone && (
              <div className="flex gap-3 mt-1">
                <a href={`tel:${selectedOrder.userPhone}`} className="flex items-center gap-1 text-xs text-blue-600 font-medium hover:underline min-h-[36px]" aria-label={`Call customer ${selectedOrder.userPhone}`}>
                  <Phone className="w-3 h-3" aria-hidden="true" /> {selectedOrder.userPhone}
                </a>
                <a href={`https://wa.me/92${selectedOrder.userPhone.replace(/^(\+92|0)/, "")}`} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-green-600 font-medium hover:underline min-h-[36px]"
                  aria-label="WhatsApp customer">
                  WhatsApp
                </a>
              </div>
            )}
          </section>

          {Array.isArray(selectedOrder.items) && selectedOrder.items.length > 0 && (
            <section aria-label="Order items">
              <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
                <Package className="w-4 h-4 text-indigo-600" aria-hidden="true" /> Items ({selectedOrder.items.length})
              </h2>
              <div className="space-y-2">
                {selectedOrder.items.map((item: any, i: number) => (
                  <div key={i} className="flex justify-between items-center gap-3 bg-muted/30 rounded-xl px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground">x{item.quantity}</p>
                    </div>
                    <p className="font-bold text-foreground shrink-0">{formatCurrency(item.price * item.quantity)}</p>
                  </div>
                ))}
                <div className="flex justify-between items-center bg-primary/5 border border-primary/20 rounded-xl px-3 py-2.5">
                  <p className="font-bold text-foreground">Total</p>
                  <p className="font-bold text-primary text-lg">{formatCurrency(selectedOrder.total)}</p>
                </div>
              </div>
            </section>
          )}

          <RiderAssignPanel
            order={selectedOrder}
            ridersData={ridersData}
            riderSearch={riderSearch}
            setRiderSearch={setRiderSearch}
            showAssignRider={showAssignRider}
            setShowAssignRider={setShowAssignRider}
            onAssignRider={onAssignRider}
            assignPending={assignPending}
          />

          {isTerminal(selectedOrder.status) && selectedOrder.paymentMethod === "wallet" && (
            <section aria-label="Admin actions">
              <h3 className="text-xs text-muted-foreground font-medium mb-1.5">Admin Actions</h3>
              {selectedOrder.refundedAt ? (
                <div className="h-9 px-4 bg-green-50 border-2 border-green-300 text-green-700 text-xs font-bold rounded-xl flex items-center gap-1.5">
                  Refunded{selectedOrder.refundedAmount ? ` \u2014 ${formatCurrency(Math.round(parseFloat(selectedOrder.refundedAmount)))}` : ""}
                </div>
              ) : !showRefundConfirm ? (
                <button
                  onClick={() => { setShowRefundConfirm(true); setShowCancelConfirm(false); setRefundAmount(""); setRefundReason(""); }}
                  className="h-9 px-4 bg-blue-50 hover:bg-blue-100 border-2 border-blue-300 text-blue-700 text-xs font-bold rounded-xl whitespace-nowrap transition-colors flex items-center gap-1.5 min-h-[36px]"
                  aria-label="Issue wallet refund"
                >
                  Issue Wallet Refund
                </button>
              ) : null}
            </section>
          )}

          {!isTerminal(selectedOrder.status) && (
            <section className="flex gap-3" aria-label="Status controls">
              <div className="flex-1">
                <h3 className="text-xs text-muted-foreground font-medium mb-1.5">Move to Next Status</h3>
                <Select
                  value={selectedOrder.status}
                  onValueChange={(val) => {
                    if (val === selectedOrder.status) return;
                    if (val === "delivered") {
                      onDeliverConfirm(selectedOrder.id);
                      return;
                    }
                    onUpdateStatus(selectedOrder.id, val, { localUpdate: true });
                  }}
                >
                  <SelectTrigger className={`h-9 text-[11px] font-bold uppercase tracking-wider border-2 ${getStatusColor(selectedOrder.status)}`} aria-label="Change order status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowedNext(selectedOrder).filter(s => s !== "cancelled").map(s => (
                      <SelectItem key={s} value={s} className="text-xs uppercase font-bold">
                        <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-green-500" aria-hidden="true" />{STATUS_LABELS[s]}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {canCancel(selectedOrder) && !showCancelConfirm && (
                <div>
                  <h3 className="text-xs text-muted-foreground font-medium mb-1.5">Admin Actions</h3>
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="h-9 px-4 bg-red-50 hover:bg-red-100 border-2 border-red-300 text-red-600 text-xs font-bold rounded-xl whitespace-nowrap transition-colors flex items-center gap-1.5 min-h-[36px]"
                    aria-label="Cancel and refund this order"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                    Cancel & Refund
                  </button>
                </div>
              )}
            </section>
          )}

          <footer className="flex justify-between text-xs text-muted-foreground border-t border-border/40 pt-3">
            <span>Ordered: {formatDate(selectedOrder.createdAt)}</span>
            <span>Updated: {formatDate(selectedOrder.updatedAt)}</span>
          </footer>
          </>}
        </div>
      )}
    </MobileDrawer>
  );
}
