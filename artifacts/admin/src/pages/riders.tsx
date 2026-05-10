import { useState, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bike, Search, RefreshCw, Wallet, CircleDollarSign, Gift, Circle,
  CheckCircle2, Ban, AlertTriangle, Star, Phone, Download, CalendarDays,
  WifiOff, Wifi, ShieldAlert, ShieldCheck, Eye, XCircle, SkipForward, Gavel, Clock,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { PageHeader, StatCard, FilterBar } from "@/components/shared";
import { useLanguage } from "@/lib/useLanguage";
import { tDual, type TranslationKey } from "@workspace/i18n";
import { PullToRefresh } from "@/components/PullToRefresh";
import { PromptDialog } from "@/components/ConfirmDialog";
import { useRiders, useUpdateRiderStatus, useRiderPayout, useRiderBonus, useToggleRiderOnline, useRiderPenalties, useRiderRatings, useRestrictRider, useUnrestrictRider, useOverrideSuspension, useApproveUser, useRejectUser } from "@/hooks/use-admin";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminFormSheet } from "@/components/AdminFormSheet";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LastUpdated } from "@/components/ui/LastUpdated";

import { WalletAdjustModal } from "@/components/WalletAdjustModal";

/* ── Suspend Modal ── */
function RiderSuspendModal({ rider, onClose }: { rider: any; onClose: () => void }) {
  const { toast } = useToast();
  const statusMutation = useUpdateRiderStatus();
  const [action, setAction] = useState<"active"|"blocked"|"banned">(
    rider.isBanned ? "banned" : !rider.isActive ? "blocked" : "active"
  );
  const [reason, setReason] = useState(rider.banReason || "");

  const handleSave = () => {
    statusMutation.mutate({
      id: rider.id,
      isActive: action === "active",
      isBanned: action === "banned",
      banReason: action === "banned" ? reason : null,
    }, {
      onSuccess: () => { toast({ title: "Rider status updated" }); onClose(); },
      onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="w-[95vw] max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>Rider Status — {rider.name || rider.phone}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {([
            { key: "active",  label: "Active",                desc: "Rider can accept deliveries", color: "green" },
            { key: "blocked", label: "Temporarily Blocked",   desc: "Suspend without ban",          color: "amber" },
            { key: "banned",  label: "Permanently Banned",    desc: "Full ban with reason",          color: "red" },
          ] as Array<{ key: "active"|"blocked"|"banned"; label: string; desc: string; color: string }>).map(opt => (
            <div key={opt.key} onClick={() => setAction(opt.key)}
              className={`p-3 rounded-xl border cursor-pointer transition-all ${action === opt.key
                ? opt.color === "green" ? "bg-green-50 border-green-400"
                : opt.color === "amber" ? "bg-amber-50 border-amber-400"
                : "bg-red-50 border-red-400"
                : "bg-muted/30 border-border"}`}>
              <p className="text-sm font-bold">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.desc}</p>
            </div>
          ))}
          {action === "banned" && (
            <Input placeholder="Ban reason (required)" value={reason} onChange={e => setReason(e.target.value)} className="h-11 rounded-xl border-red-200" />
          )}
          <div className="flex gap-3 pt-1">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={statusMutation.isPending || (action === "banned" && !reason)} className="flex-1 rounded-xl">
              {statusMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RiderDetailDrawer({ rider, onClose }: { rider: any; onClose: () => void }) {
  const { toast } = useToast();
  const { data: penData } = useRiderPenalties(rider.id);
  const { data: ratData } = useRiderRatings(rider.id);
  const restrictMut = useRestrictRider();
  const unrestrictMut = useUnrestrictRider();

  const penalties: any[] = penData?.penalties || [];
  const ratings: any[] = ratData?.ratings || [];

  const handleRestrict = () => {
    restrictMut.mutate(rider.id, {
      onSuccess: () => { toast({ title: "Rider restricted" }); onClose(); },
      onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };
  const handleUnrestrict = () => {
    unrestrictMut.mutate(rider.id, {
      onSuccess: () => { toast({ title: "Rider unrestricted" }); onClose(); },
      onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };

  const isBusy = restrictMut.isPending || unrestrictMut.isPending;

  return (
    <AdminFormSheet
      open
      onClose={onClose}
      title={`Rider Details — ${rider.name || rider.phone}`}
      description="Performance summary, penalties, and ratings."
      busy={isBusy}
      width="sm:max-w-lg"
      footer={
        rider.isRestricted ? (
          <Button
            onClick={handleUnrestrict}
            disabled={isBusy}
            className="flex-1 rounded-xl bg-green-600 hover:bg-green-700 text-white gap-2"
          >
            <ShieldCheck className="w-4 h-4" /> Unrestrict Rider
          </Button>
        ) : (
          <Button
            onClick={handleRestrict}
            disabled={isBusy}
            variant="outline"
            className="flex-1 rounded-xl border-red-300 text-red-700 hover:bg-red-50 gap-2"
          >
            <ShieldAlert className="w-4 h-4" /> Restrict Rider
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
            <p className="text-[10px] text-red-500 font-bold uppercase">Cancels</p>
            <p className="text-xl font-extrabold text-red-700">{rider.cancelCount ?? 0}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
            <p className="text-[10px] text-amber-500 font-bold uppercase">Ignores</p>
            <p className="text-xl font-extrabold text-amber-700">{rider.ignoreCount ?? 0}</p>
          </div>
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 text-center">
            <p className="text-[10px] text-purple-500 font-bold uppercase">Penalties</p>
            <p className="text-xl font-extrabold text-purple-700">{formatCurrency(rider.penaltyTotal ?? 0)}</p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center">
            <p className="text-[10px] text-blue-500 font-bold uppercase">Rating</p>
            <p className="text-xl font-extrabold text-blue-700">{rider.avgRating ?? 0} <span className="text-xs font-normal">({rider.ratingCount ?? 0})</span></p>
          </div>
        </div>

        {penalties.length > 0 && (
          <div>
            <p className="text-sm font-bold text-foreground mb-2">Penalty History</p>
            <div className="space-y-1.5">
              {penalties.map((p: any) => (
                <div key={p.id} className="flex items-center justify-between bg-muted/30 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    {p.type === "cancel" ? <XCircle className="w-3.5 h-3.5 text-red-500"/> : <SkipForward className="w-3.5 h-3.5 text-amber-500"/>}
                    <span className="text-muted-foreground">{p.reason || p.type}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.amount > 0 && <span className="font-bold text-red-600">-{formatCurrency(p.amount)}</span>}
                    <span className="text-muted-foreground">{formatDate(p.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {ratings.length > 0 && (
          <div>
            <p className="text-sm font-bold text-foreground mb-2">Recent Ratings</p>
            <div className="space-y-1.5">
              {ratings.map((rt: any) => (
                <div key={rt.id} className="flex items-center justify-between bg-muted/30 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Star className="w-3.5 h-3.5 text-amber-500"/>
                    <span className="font-bold">{rt.stars}/5</span>
                    {rt.comment && <span className="text-muted-foreground truncate max-w-[180px]">"{rt.comment}"</span>}
                  </div>
                  <span className="text-muted-foreground">{formatDate(rt.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AdminFormSheet>
  );
}

function exportRidersCSV(riders: any[]) {
  const header = "ID,Name,Phone,Status,Wallet,Joined";
  const rows = riders.map((r: any) =>
    [r.id, r.name || "", r.phone || "",
     r.isBanned ? "banned" : !r.isActive ? "blocked" : r.isOnline ? "online" : "offline",
     r.walletBalance, r.createdAt?.slice(0,10) || ""].join(",")
  );
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `riders-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ══════════ Main Riders Page ══════════ */
export default function Riders() {
  const [, navigate] = useLocation();
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useRiders();
  const toggleOnlineMutation = useToggleRiderOnline();
  const overrideSuspM = useOverrideSuspension("riders");
  const { toast } = useToast();

  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom]         = useState("");
  const [dateTo, setDateTo]             = useState("");
  const [walletModal,  setWalletModal]  = useState<any>(null);
  const [rejectTarget, setRejectTarget] = useState<any>(null);
  const [suspendModal, setSuspendModal] = useState<any>(null);
  const [detailModal,  setDetailModal]  = useState<any>(null);

  const riders: any[] = data?.users || data?.riders || [];

  const handleToggleOnline = (r: any) => {
    toggleOnlineMutation.mutate({ id: r.id, isOnline: !r.isOnline }, {
      onSuccess: () => toast({ title: r.isOnline ? "Rider set offline" : "Rider set online" }),
      onError: e => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };

  type RiderSortKey = "name" | "status" | "walletBalance" | "avgRating";
  const [sortKey, setSortKey] = useState<RiderSortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (key: RiderSortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  function SortIcon({ col }: { col: RiderSortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 opacity-40 inline ml-0.5" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3 text-primary inline ml-0.5" /> : <ArrowDown className="w-3 h-3 text-primary inline ml-0.5" />;
  }

  const filtered = riders.filter((r: any) => {
    const q = search.toLowerCase();
    const matchSearch = (r.name || "").toLowerCase().includes(q) || (r.phone || "").includes(q);
    const matchStatus =
      statusFilter === "all" ||
      (statusFilter === "pending"  && r.approvalStatus === "pending") ||
      (statusFilter === "online"  && r.isOnline && r.isActive) ||
      (statusFilter === "offline" && !r.isOnline && r.isActive && r.approvalStatus !== "pending") ||
      (statusFilter === "blocked" && !r.isActive && !r.isBanned && r.approvalStatus !== "pending") ||
      (statusFilter === "banned"  && r.isBanned);
    const matchDate = (!dateFrom || new Date(r.createdAt) >= new Date(dateFrom))
                   && (!dateTo   || new Date(r.createdAt) <= new Date(dateTo + "T23:59:59"));
    return matchSearch && matchStatus && matchDate;
  });

  const statusRank = (r: any) => {
    if (r.isBanned) return 4;
    if (!r.isActive) return 3;
    if (r.approvalStatus === "pending") return 2;
    if (!r.isOnline) return 1;
    return 0;
  };

  const sortedFiltered = useMemo(() => {
    return [...filtered].sort((a: any, b: any) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return dir * ((a.name || "").localeCompare(b.name || ""));
      if (sortKey === "status") return dir * (statusRank(a) - statusRank(b));
      if (sortKey === "walletBalance") return dir * (Number(a.walletBalance) - Number(b.walletBalance));
      if (sortKey === "avgRating") return dir * (Number(a.avgRating || 0) - Number(b.avgRating || 0));
      return 0;
    });
  }, [filtered, sortKey, sortDir]);

  const onlineRiders   = riders.filter((r: any) => r.isOnline && r.isActive).length;
  const activeRiders   = riders.filter((r: any) => r.isActive && !r.isBanned).length;
  const pendingRiders  = riders.filter((r: any) => r.approvalStatus === "pending").length;
  const totalWallet    = riders.reduce((s: number, r: any) => s + r.walletBalance, 0);

  const getRiderStatus = (r: any): { status: string; label: string } => {
    if (r.approvalStatus === "pending") return { status: "pending_approval", label: "Pending Approval" };
    if (r.isBanned)     return { status: "banned",      label: "Banned" };
    if (r.isRestricted) return { status: "restricted",  label: "Restricted" };
    if (!r.isActive)    return { status: "blocked",     label: "Blocked" };
    if (r.isOnline)     return { status: "online",      label: "Online" };
    return                     { status: "offline",     label: "Offline" };
  };

  const approveM = useApproveUser();
  const rejectM  = useRejectUser();

  const handleApprove = (r: any) => {
    approveM.mutate({ id: r.id }, {
      onSuccess: () => { toast({ title: "Rider approved" }); refetch(); },
      onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };

  const handleReject = (r: any) => {
    setRejectTarget(r);
  };
  const submitReject = (note: string) => {
    if (!rejectTarget) return;
    const r = rejectTarget;
    setRejectTarget(null);
    rejectM.mutate({ id: r.id, note }, {
      onSuccess: () => { toast({ title: "Rider rejected" }); refetch(); },
      onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
    });
  };

  const qc = useQueryClient();
  const handlePullRefresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["admin-riders"] });
  }, [qc]);

  return (
    <PullToRefresh onRefresh={handlePullRefresh} className="space-y-6">
      <PageHeader
        icon={Bike}
        title="Riders"
        subtitle={`${riders.length} total · ${onlineRiders} online now${pendingRiders > 0 ? ` · ${pendingRiders} pending` : ""}`}
        iconBgClass="bg-green-100"
        iconColorClass="text-green-600"
        actions={
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => exportRidersCSV(filtered)} className="h-9 rounded-xl gap-2">
                <Download className="w-4 h-4" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="h-9 rounded-xl gap-2">
                <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} /> {T("refresh")}
              </Button>
            </div>
            <LastUpdated dataUpdatedAt={dataUpdatedAt} onRefresh={refetch} isRefreshing={isFetching} />
          </div>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Bike} label="Total Riders" value={riders.length} iconBgClass="bg-green-100" iconColorClass="text-green-600" />
        <StatCard icon={CheckCircle2} label="Online Now" value={onlineRiders} iconBgClass="bg-emerald-100" iconColorClass="text-emerald-600" />
        <StatCard icon={AlertTriangle} label="Pending Approval" value={pendingRiders} iconBgClass="bg-yellow-100" iconColorClass="text-yellow-600" />
        <StatCard icon={Wallet} label="Wallet Pending" value={formatCurrency(totalWallet)} iconBgClass="bg-amber-100" iconColorClass="text-amber-600" />
      </div>

      {/* Filters */}
      <Card className="p-4 rounded-2xl border-border/50 shadow-sm space-y-3">
        <FilterBar
          search={search}
          onSearch={setSearch}
          placeholder="Search by name or phone..."
          filters={
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-10 rounded-xl bg-muted/30 w-full sm:w-44">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Riders</SelectItem>
                <SelectItem value="pending">Pending Approval</SelectItem>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
                <SelectItem value="blocked">Blocked</SelectItem>
                <SelectItem value="banned">Banned</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-9 rounded-xl bg-muted/30 text-xs w-32" />
          <span className="text-xs text-muted-foreground">–</span>
          <Input type="date" value={dateTo}   onChange={e => setDateTo(e.target.value)}   className="h-9 rounded-xl bg-muted/30 text-xs w-32" />
          {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} className="text-xs text-primary hover:underline">Clear</button>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground font-medium mr-1">Sort:</span>
          {([
            { key: "name" as const,          label: "Name" },
            { key: "status" as const,        label: "Status" },
            { key: "walletBalance" as const, label: "Wallet" },
            { key: "avgRating" as const,     label: "Rating" },
          ] as const).map(opt => (
            <button
              key={opt.key}
              onClick={() => handleSort(opt.key)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${sortKey === opt.key ? "bg-primary text-primary-foreground border-primary" : "bg-muted/30 border-border/50 text-muted-foreground hover:border-primary/40"}`}
            >
              {opt.label}<SortIcon col={opt.key} />
            </button>
          ))}
        </div>
      </Card>

      {/* Riders List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-20 bg-muted animate-pulse rounded-2xl" />)}
        </div>
      ) : sortedFiltered.length === 0 ? (
        <Card className="rounded-2xl border-border/50">
          <CardContent className="p-12 text-center">
            <Bike className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">No riders match the current filters</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sortedFiltered.map((r: any) => (
            <Card key={r.id} className="rounded-2xl border-border/50 shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  {/* Rider Info */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 font-bold text-lg ${r.isOnline && r.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                      {r.name ? r.name[0].toUpperCase() : "R"}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-sm text-foreground">{r.name || "Unknown Rider"}</p>
                        <StatusBadge {...getRiderStatus(r)} size="xs" />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <a href={`tel:${r.phone}`} className="flex items-center gap-1 text-xs text-blue-600 font-medium hover:underline">
                          <Phone className="w-3 h-3" /> {r.phone}
                        </a>
                        <a href={`https://wa.me/92${r.phone.replace(/^(\+92|92|0)/, "")}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-green-600 font-medium hover:underline">
                          💬 WhatsApp
                        </a>
                      </div>
                      <p className="text-xs text-muted-foreground">Joined {formatDate(r.createdAt)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-center">
                    <div>
                      <p className="text-xs text-muted-foreground">Wallet</p>
                      <p className="font-bold text-sm text-green-700">{formatCurrency(r.walletBalance)}</p>
                    </div>
                    {(r.cancelCount > 0 || r.ignoreCount > 0) && (
                      <div className="flex gap-2">
                        {r.cancelCount > 0 && (
                          <div title="Total cancels">
                            <p className="text-[10px] text-red-500 font-bold">Cancels</p>
                            <p className="text-sm font-bold text-red-600">{r.cancelCount}</p>
                          </div>
                        )}
                        {r.ignoreCount > 0 && (
                          <div title="Total ignores">
                            <p className="text-[10px] text-amber-500 font-bold">Ignores</p>
                            <p className="text-sm font-bold text-amber-600">{r.ignoreCount}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {r.avgRating > 0 && (
                      <div title="Average rating">
                        <p className="text-[10px] text-blue-500 font-bold">Rating</p>
                        <p className="text-sm font-bold text-blue-600">{r.avgRating} <Star className="w-3 h-3 inline text-amber-400"/></p>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 shrink-0 flex-wrap">
                    {r.approvalStatus === "pending" && (
                      <>
                        <Button size="sm" onClick={() => handleApprove(r)} disabled={approveM.isPending}
                          className="h-9 rounded-xl gap-1.5 text-xs bg-green-600 hover:bg-green-700 text-white">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleReject(r)} disabled={rejectM.isPending}
                          className="h-9 rounded-xl gap-1.5 text-xs border-red-200 text-red-700 hover:bg-red-50">
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </Button>
                      </>
                    )}
                    {r.isActive && !r.isBanned && r.approvalStatus !== "pending" && (
                      <Button size="sm" variant="outline" onClick={() => handleToggleOnline(r)}
                        disabled={toggleOnlineMutation.isPending}
                        className={`h-9 rounded-xl gap-1.5 text-xs ${r.isOnline ? "border-amber-200 text-amber-700 hover:bg-amber-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>
                        {r.isOnline ? <><WifiOff className="w-3.5 h-3.5" /> Set Offline</> : <><Wifi className="w-3.5 h-3.5" /> Set Online</>}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setWalletModal(r)}
                      className="h-9 rounded-xl gap-1.5 text-xs border-green-200 text-green-700 hover:bg-green-50">
                      <Wallet className="w-3.5 h-3.5" /> Wallet
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSuspendModal(r)}
                      className={`h-9 rounded-xl gap-1.5 text-xs ${r.isActive && !r.isBanned ? "border-red-200 text-red-700 hover:bg-red-50" : "border-green-200 text-green-700 hover:bg-green-50"}`}>
                      {r.isActive && !r.isBanned
                        ? <><Ban className="w-3.5 h-3.5" /> Suspend</>
                        : <><CheckCircle2 className="w-3.5 h-3.5" /> Activate</>
                      }
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDetailModal(r)}
                      className="h-9 rounded-xl gap-1.5 text-xs border-blue-200 text-blue-700 hover:bg-blue-50">
                      <Eye className="w-3.5 h-3.5" /> Details
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => navigate(`/account-conditions?userId=${r.id}`)}
                      className="h-9 rounded-xl gap-1.5 text-xs border-violet-200 text-violet-700 hover:bg-violet-50" title="Conditions">
                      <Gavel className="w-3.5 h-3.5" /> Conditions
                    </Button>
                    {r.autoSuspendedAt && !r.adminOverrideSuspension && (
                      <Button size="sm" variant="outline" onClick={() => {
                        overrideSuspM.mutate(r.id, {
                          onSuccess: () => toast({ title: "Suspension overridden", description: "Rider is now active again." }),
                          onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
                        });
                      }} disabled={overrideSuspM.isPending}
                        className="h-9 rounded-xl gap-1.5 text-xs border-purple-200 text-purple-700 hover:bg-purple-50">
                        <ShieldCheck className="w-3.5 h-3.5" /> Override Suspend
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Modals */}
      {walletModal  && <WalletAdjustModal mode="rider" subject={walletModal} onClose={() => setWalletModal(null)} />}
      {suspendModal && <RiderSuspendModal rider={suspendModal} onClose={() => setSuspendModal(null)} />}
      {detailModal  && <RiderDetailDrawer rider={detailModal}  onClose={() => setDetailModal(null)} />}
      <PromptDialog
        open={!!rejectTarget}
        title="Reject rider"
        description="Provide a reason (optional). The rider will be notified."
        placeholder="Rejection reason"
        confirmLabel="Reject"
        onClose={() => setRejectTarget(null)}
        onSubmit={submitReject}
      />
    </PullToRefresh>
  );
}
