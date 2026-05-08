import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/shared";
import { PackageSearch, Plus, Search, Edit, Trash2, ToggleLeft, ToggleRight, Download, Filter, CheckCircle, XCircle, Clock, Upload, X, ImageIcon, ArrowUpDown, ArrowUp, ArrowDown, History, Tag, Percent, ChevronDown } from "lucide-react";
import { fetcher } from "@/lib/api";
import { useProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, usePendingProducts, useApproveProduct, useRejectProduct, useCategories, useProductStockHistory } from "@/hooks/use-admin";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useErrorHandler } from "@/hooks/useErrorHandler";
import { parseApiError } from "@/lib/errorParser";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/lib/useLanguage";
import { tDual, type TranslationKey } from "@workspace/i18n";
import { uploadAdminImageWithProgress } from "@/lib/api";
import { UploadProgress } from "@/components/ui/UploadProgress";
import type { ProductRow } from "@/lib/adminApiTypes";
import { useHasPermission } from "@/hooks/usePermissions";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SafeImage } from "@/components/ui/SafeImage";
import { LastUpdated } from "@/components/ui/LastUpdated";

const EMPTY_FORM = {
  name: "", description: "", price: "", originalPrice: "",
  category: "", type: "mart", unit: "", vendorName: "",
  inStock: true, deliveryTime: "30-45 min", image: ""
};

function StockHistoryDialog({
  product,
  vendors,
  onClose,
}: {
  product: ProductRow;
  vendors: string[];
  onClose: () => void;
}) {
  const [vendorFilter, setVendorFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [applied, setApplied] = useState<{ vendorId?: string; from?: string; to?: string }>({});

  const { data, isLoading, isError } = useProductStockHistory(product.id, applied);
  const rows: Array<{
    id: string;
    delta: number;
    previousStock: number | null;
    newStock: number | null;
    reason: string;
    source: string;
    orderId: string | null;
    vendorId: string;
    changedAt: string;
  }> = Array.isArray(data?.history) ? data.history : [];

  const applyFilters = () => {
    setApplied({
      vendorId: vendorFilter || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    });
  };

  const clearFilters = () => {
    setVendorFilter("");
    setFromDate("");
    setToDate("");
    setApplied({});
  };

  const hasFilters = !!(vendorFilter || fromDate || toDate);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85dvh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-gradient-to-r from-violet-600 to-purple-600 p-5 flex-shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-white flex items-center gap-2">
                <History className="w-5 h-5" /> Stock History
              </h2>
              <p className="text-purple-200 text-sm mt-0.5 truncate max-w-xs">{product.name}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex-shrink-0 space-y-2">
          <div className="flex flex-wrap gap-2 items-end">
            {vendors.length > 0 && (
              <div className="flex flex-col gap-1 min-w-[160px]">
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Vendor</label>
                <select
                  value={vendorFilter}
                  onChange={e => setVendorFilter(e.target.value)}
                  className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-violet-400"
                >
                  <option value="">All vendors</option>
                  {vendors.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">From</label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-violet-400"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">To</label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="h-9 px-3 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-violet-400"
              />
            </div>
            <button
              onClick={applyFilters}
              className="h-9 px-4 bg-violet-600 text-white font-bold rounded-lg text-sm hover:bg-violet-700 transition-colors"
            >
              Apply
            </button>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="h-9 px-3 bg-gray-100 text-gray-500 font-bold rounded-lg text-sm hover:bg-gray-200 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 px-5 py-3">
          {isLoading && (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading history…</div>
          )}
          {isError && (
            <div className="py-12 text-center text-sm text-red-500">Failed to load stock history.</div>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-2xl mb-2">📦</p>
              <p className="text-sm text-muted-foreground">No stock movements recorded yet.</p>
              {Object.keys(applied).length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">Try clearing the filters to see all history.</p>
              )}
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider pr-3">Date</th>
                  <th className="text-center py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider pr-3">Change</th>
                  <th className="text-center py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider pr-3">Before</th>
                  <th className="text-center py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider pr-3">After</th>
                  <th className="text-left py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider pr-3">Source</th>
                  <th className="text-left py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Order</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                    <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(r.changedAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                      <span className="block text-[10px]">{new Date(r.changedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                    </td>
                    <td className="py-2 pr-3 text-center">
                      <span className={`inline-block font-extrabold tabular-nums text-sm px-2 py-0.5 rounded-lg ${r.delta < 0 ? "bg-red-100 text-red-600" : "bg-green-100 text-green-700"}`}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-center text-xs text-muted-foreground tabular-nums">
                      {r.previousStock ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-center text-xs font-semibold text-foreground tabular-nums">
                      {r.newStock ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="text-xs capitalize text-foreground">{r.source || r.reason || "—"}</span>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground font-mono">
                      {r.orderId ? r.orderId.slice(-8) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex-shrink-0 flex justify-between items-center">
          <p className="text-xs text-muted-foreground">
            {rows.length > 0 ? `${rows.length} record${rows.length !== 1 ? "s" : ""}` : ""}
          </p>
          <button
            onClick={onClose}
            className="h-9 px-5 bg-gray-100 text-gray-600 font-bold rounded-xl text-sm hover:bg-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RejectModal({ product, onClose }: { product: ProductRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const reject = useRejectProduct();
  const { onError: onRejectError } = useErrorHandler({ title: "Error" });
  const handleReject = () => {
    if (!reason.trim()) { toast({ title: "Reason required", variant: "destructive" }); return; }
    reject.mutate({ id: product.id, reason: reason.trim() }, {
      onSuccess: () => { toast({ title: "Product rejected" }); onClose(); },
      onError: onRejectError,
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-red-600 to-rose-600 p-5">
          <h2 className="text-lg font-extrabold text-white">Reject Product</h2>
          <p className="text-red-200 text-sm mt-0.5">Product will be rejected and the vendor notified</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-red-50 rounded-xl p-4 space-y-1">
            <p className="text-sm font-bold text-gray-800">{product.name}</p>
            <p className="text-xs text-gray-500">By: {product.vendorName || "Unknown Vendor"} · {formatCurrency(product.price)}</p>
          </div>
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Rejection Reason *</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
              placeholder="e.g. Poor image quality · Price too high · Duplicate product"
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-red-400 resize-none"/>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold" onClick={handleReject} disabled={reject.isPending}>
              {reject.isPending ? "Rejecting..." : "Reject"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Products() {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { data, isLoading, dataUpdatedAt } = useProducts();
  const { data: pendingData, isLoading: pendingLoading } = usePendingProducts();
  const { data: categoriesData } = useCategories();
  const createMutation = useCreateProduct();
  const updateMutation = useUpdateProduct();
  const deleteMutation = useDeleteProduct();
  const approveMutation = useApproveProduct();
  const { toast } = useToast();
  const { onError: onProductError } = useErrorHandler();
  const canWrite = useHasPermission("content.products.edit");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<"all" | "pending" | "pricing">("all");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkStock, setBulkStock] = useState<"" | "in" | "out">("");
  const [bulkApplying, setBulkApplying] = useState(false);

  const [pricingRules, setPricingRules] = useState<Array<{ id: string; name: string; type: string; value: string; category: string; active: boolean }>>([]);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingSaving, setPricingSaving] = useState(false);

  // Load pricing rules from platform settings on mount / tab switch to "pricing"
  useEffect(() => {
    if (tab !== "pricing") return;
    setPricingLoading(true);
    fetcher("/platform-settings")
      .then((data: any) => {
        const all: Array<{ key: string; value: string }> = data?.settings ?? [];
        const raw = all.find(s => s.key === "global_pricing_rules")?.value;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) { setPricingRules(parsed); return; }
          } catch { /* ignore parse errors */ }
        }
        // Default seed rules when no saved value
        setPricingRules([
          { id: "1", name: "Weekend Sale", type: "discount_pct", value: "10", category: "all", active: true },
          { id: "2", name: "Bulk Discount (5+ items)", type: "discount_flat", value: "50", category: "mart", active: false },
        ]);
      })
      .catch(() => setPricingRules([]))
      .finally(() => setPricingLoading(false));
  }, [tab]);

  const savePricingRules = async () => {
    setPricingSaving(true);
    try {
      await fetcher("/platform-settings", {
        method: "PUT",
        body: JSON.stringify({ settings: [{ key: "global_pricing_rules", value: JSON.stringify(pricingRules) }] }),
      });
      toast({ title: "Pricing rules saved", description: "Rules will apply at checkout." });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    }
    setPricingSaving(false);
  };

  const toggleProductSelect = useCallback((id: string) => {
    setSelectedProductIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleBulkEdit = useCallback(async () => {
    if (!bulkPrice && !bulkCategory && !bulkStock) {
      toast({ title: "Select at least one field to change", variant: "destructive" });
      return;
    }
    setBulkApplying(true);
    const ids = Array.from(selectedProductIds);
    const payload: Record<string, any> = {};
    if (bulkPrice) payload.price = parseFloat(bulkPrice);
    if (bulkCategory) payload.category = bulkCategory;
    if (bulkStock === "in") payload.inStock = true;
    if (bulkStock === "out") payload.inStock = false;
    let succeeded = 0;
    for (const id of ids) {
      try {
        await fetcher(`/products/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
        succeeded++;
      } catch { /* continue */ }
    }
    toast({ title: `Bulk edit applied`, description: `${succeeded} of ${ids.length} products updated.` });
    setSelectedProductIds(new Set());
    setShowBulkEdit(false);
    setBulkPrice("");
    setBulkCategory("");
    setBulkStock("");
    setBulkApplying(false);
  }, [selectedProductIds, bulkPrice, bulkCategory, bulkStock, toast]);
  const [search, setSearch]         = useState("");
  const [typeFilter, setTypeFilter]   = useState("all");
  const [vendorFilter, setVendorFilter] = useState("");
  const [stockFilter, setStockFilter]   = useState("all");
  const [isFormOpen, setIsFormOpen]   = useState(false);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [formData, setFormData]       = useState({ ...EMPTY_FORM });
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ProductRow | null>(null);
  const [stockHistoryProduct, setStockHistoryProduct] = useState<ProductRow | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  const [imageUploading, setImageUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const imageBlobRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (imageBlobRef.current) URL.revokeObjectURL(imageBlobRef.current);
    };
  }, []);
  const [categorySearch, setCategorySearch] = useState("");
  const [categoryDropOpen, setCategoryDropOpen] = useState(false);

  const categories = categoriesData || [];
  const filteredCategories = categories.filter(c =>
    c.name.toLowerCase().includes(categorySearch.toLowerCase()) ||
    c.id.toLowerCase().includes(categorySearch.toLowerCase())
  );

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.type)) {
      toast({ title: "Invalid file type", description: "Only JPEG, PNG, and WebP images are allowed", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Image must be under 10MB", variant: "destructive" });
      return;
    }
    if (imageBlobRef.current) URL.revokeObjectURL(imageBlobRef.current);
    const previewUrl = URL.createObjectURL(file);
    imageBlobRef.current = previewUrl;
    setImagePreview(previewUrl);
    setImageUploading(true);
    setUploadPercent(0);
    try {
      const url = await uploadAdminImageWithProgress(file, (pct) => setUploadPercent(pct));
      setFormData(prev => ({ ...prev, image: url }));
      toast({ title: "Image uploaded" });
    } catch (err: unknown) {
      toast({ title: "Upload failed", description: parseApiError(err), variant: "destructive" });
      setImagePreview(formData.image || "");
    } finally {
      setImageUploading(false);
      setUploadPercent(null);
    }
  };

  const openAdd = useCallback(() => {
    setEditingId(null);
    setFormData({ ...EMPTY_FORM });
    setImagePreview("");
    setCategorySearch("");
    setIsFormOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener("admin:new-item", openAdd);
    return () => window.removeEventListener("admin:new-item", openAdd);
  }, [openAdd]);

  const openEdit = (prod: ProductRow) => {
    setEditingId(prod.id);
    setFormData({
      name: prod.name || "", description: prod.description || "",
      price: String(prod.price || ""),
      originalPrice: prod.originalPrice ? String(prod.originalPrice) : "",
      category: prod.category || "", type: prod.type || "mart",
      unit: prod.unit || "", vendorName: prod.vendorName || "",
      inStock: prod.inStock ?? false, deliveryTime: prod.deliveryTime || "30-45 min",
      image: prod.image || "",
    });
    setImagePreview(prod.image || "");
    setCategorySearch(prod.category || "");
    setIsFormOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.category.trim()) {
      toast({ title: "Category required", description: "Please search and select a category from the dropdown", variant: "destructive" });
      return;
    }
    const payload = {
      ...formData,
      price: Number(formData.price),
      originalPrice: formData.originalPrice ? Number(formData.originalPrice) : null
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload }, {
        onSuccess: () => { toast({ title: "Product updated" }); setIsFormOpen(false); },
        onError: onProductError,
      });
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => { toast({ title: "Product created" }); setIsFormOpen(false); },
        onError: onProductError,
      });
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast({ title: "Product deleted" }); setDeleteTarget(null); },
      onError: onProductError,
    });
  };

  const handleApprove = (prod: ProductRow) => {
    approveMutation.mutate({ id: prod.id }, {
      onSuccess: () => toast({ title: "Product approved", description: `${prod.name} is now live in the store` }),
      onError: onProductError,
    });
  };

  const toggleStock = (prod: ProductRow) => {
    updateMutation.mutate({ id: prod.id, inStock: !prod.inStock }, {
      onSuccess: () => toast({ title: prod.inStock ? "Marked out of stock" : "Marked in stock" }),
      onError: onProductError,
    });
  };

  const exportCSV = () => {
    const header = "ID,Name,Category,Type,Price,Vendor,InStock";
    const rows = filtered.map((p: ProductRow) =>
      [p.id, p.name, p.category, p.type, p.price, p.vendorName || "", p.inStock ? "yes" : "no"].join(",")
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    const csvUrl = URL.createObjectURL(blob);
    a.href = csvUrl;
    a.download = `products-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(csvUrl), 0);
  };

  const products = data?.products || [];
  const pendingProducts = pendingData?.products || [];
  const vendors = [...new Set(products.filter((p: ProductRow) => p.vendorName).map((p: ProductRow) => p.vendorName as string))] as string[];
  const q = search.toLowerCase();
  const [sortKey, setSortKey] = useState<"name" | "category" | "price" | "vendor" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = useCallback((key: "name" | "category" | "price" | "vendor") => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === "asc" ? "desc" : "asc"); return key; }
      setSortDir("asc");
      return key;
    });
  }, []);

  const filtered = useMemo(() => {
    const base = products.filter((p: ProductRow) =>
      (typeFilter === "all" || p.type === typeFilter) &&
      (stockFilter === "all" || (stockFilter === "in" ? p.inStock : !p.inStock)) &&
      (!vendorFilter || (p.vendorName || "").toLowerCase().includes(vendorFilter.toLowerCase())) &&
      (p.name.toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q))
    );
    if (!sortKey) return base;
    return [...base].sort((a: ProductRow, b: ProductRow) => {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortKey === "name")     { av = (a.name || "").toLowerCase();       bv = (b.name || "").toLowerCase(); }
      if (sortKey === "category") { av = (a.category || "").toLowerCase();   bv = (b.category || "").toLowerCase(); }
      if (sortKey === "price")    { av = a.price ?? 0;                       bv = b.price ?? 0; }
      if (sortKey === "vendor")   { av = (a.vendorName || "").toLowerCase(); bv = (b.vendorName || "").toLowerCase(); }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [products, typeFilter, stockFilter, vendorFilter, q, sortKey, sortDir]);

  const martCount = products.filter((p: ProductRow) => p.type === "mart").length;
  const foodCount = products.filter((p: ProductRow) => p.type === "food").length;
  const pendingCount = pendingProducts.length;

  return (
    <>
    <ErrorBoundary fallback={<div className="p-8 text-center text-sm text-red-500">Products page crashed. Please reload.</div>}>
    <div className="space-y-6">
      <PageHeader
        icon={PackageSearch}
        title={T("products")}
        subtitle={`${martCount} mart · ${foodCount} food · ${products.length} ${T("total")}${pendingCount > 0 ? ` · ${pendingCount} pending approval` : ""}`}
        iconBgClass="bg-purple-100"
        iconColorClass="text-purple-600"
        actions={
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <Button variant="outline" onClick={exportCSV} className="h-11 rounded-xl gap-2">
                <Download className="w-4 h-4" /> CSV
              </Button>
              <Button onClick={openAdd} className="h-11 rounded-xl shadow-md gap-2">
                <Plus className="w-5 h-5" /> Add Product
              </Button>
            </div>
            <LastUpdated dataUpdatedAt={dataUpdatedAt ?? 0} />
          </div>
        }
      />

      {/* Tab switcher */}
      <div className="flex gap-2 border-b border-border/40 pb-0">
        <button
          onClick={() => setTab("all")}
          className={`px-5 py-2.5 text-sm font-bold rounded-t-xl border-b-2 transition-colors ${
            tab === "all" ? "border-primary text-primary bg-primary/5" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          All Products ({products.length})
        </button>
        <button
          onClick={() => setTab("pending")}
          className={`px-5 py-2.5 text-sm font-bold rounded-t-xl border-b-2 transition-colors flex items-center gap-2 ${
            tab === "pending" ? "border-amber-500 text-amber-700 bg-amber-50" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Clock className="w-4 h-4" />
          Pending Approval
          {pendingCount > 0 && (
            <span className="bg-amber-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{pendingCount}</span>
          )}
        </button>
        <button
          onClick={() => setTab("pricing")}
          className={`px-5 py-2.5 text-sm font-bold rounded-t-xl border-b-2 transition-colors flex items-center gap-2 ${
            tab === "pricing" ? "border-purple-500 text-purple-700 bg-purple-50" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Tag className="w-4 h-4" />
          Pricing Rules
        </button>
      </div>

      {/* Pricing Rules Tab */}
      {tab === "pricing" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Define global pricing rules that apply across products. Rules are applied at checkout.</p>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="outline" className="h-9 rounded-xl gap-2" onClick={() => {
                const newRule = { id: String(Date.now()), name: "New Rule", type: "discount_pct", value: "5", category: "all", active: false };
                setPricingRules(prev => [...prev, newRule]);
              }}>
                <Plus className="w-4 h-4" /> Add Rule
              </Button>
              <Button size="sm" className="h-9 rounded-xl gap-2" onClick={() => void savePricingRules()} disabled={pricingSaving || pricingLoading}>
                {pricingSaving ? "Saving…" : "Save Rules"}
              </Button>
            </div>
          </div>
          {pricingLoading && <div className="h-24 rounded-xl bg-muted animate-pulse" />}
          <Card className="rounded-2xl border-border/50 shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="font-bold">Rule Name</TableHead>
                  <TableHead className="font-bold">Type</TableHead>
                  <TableHead className="font-bold">Value</TableHead>
                  <TableHead className="font-bold">Category</TableHead>
                  <TableHead className="font-bold text-center">Active</TableHead>
                  <TableHead className="font-bold text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pricingRules.map(rule => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <input
                        value={rule.name}
                        onChange={e => setPricingRules(prev => prev.map(r => r.id === rule.id ? { ...r, name: e.target.value } : r))}
                        className="w-full text-sm bg-transparent border border-transparent hover:border-border focus:border-primary rounded-lg px-2 py-1 focus:outline-none"
                      />
                    </TableCell>
                    <TableCell>
                      <select
                        value={rule.type}
                        onChange={e => setPricingRules(prev => prev.map(r => r.id === rule.id ? { ...r, type: e.target.value } : r))}
                        className="text-xs rounded-lg border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="discount_pct">% Discount</option>
                        <option value="discount_flat">Flat Discount (PKR)</option>
                        <option value="markup_pct">% Markup</option>
                        <option value="markup_flat">Flat Markup (PKR)</option>
                      </select>
                    </TableCell>
                    <TableCell>
                      <input
                        type="number"
                        value={rule.value}
                        onChange={e => setPricingRules(prev => prev.map(r => r.id === rule.id ? { ...r, value: e.target.value } : r))}
                        className="w-20 text-sm bg-transparent border border-border rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </TableCell>
                    <TableCell>
                      <select
                        value={rule.category}
                        onChange={e => setPricingRules(prev => prev.map(r => r.id === rule.id ? { ...r, category: e.target.value } : r))}
                        className="text-xs rounded-lg border border-border bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="all">All Categories</option>
                        <option value="mart">Mart</option>
                        <option value="food">Food</option>
                        <option value="pharmacy">Pharmacy</option>
                      </select>
                    </TableCell>
                    <TableCell className="text-center">
                      <button
                        onClick={() => setPricingRules(prev => prev.map(r => r.id === rule.id ? { ...r, active: !r.active } : r))}
                        className={`w-10 h-5 rounded-full relative transition-colors ${rule.active ? "bg-green-500" : "bg-slate-200"}`}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${rule.active ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-red-600 hover:bg-red-50"
                        onClick={() => setPricingRules(prev => prev.filter(r => r.id !== rule.id))}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {pricingRules.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">No pricing rules. Click "Add Rule" to create one.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
          {pricingRules.some(r => r.active) && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-700 flex items-center gap-2">
              <Percent className="w-4 h-4 shrink-0" />
              <span>{pricingRules.filter(r => r.active).length} active rule{pricingRules.filter(r => r.active).length !== 1 ? "s" : ""} will apply at checkout. Rules are applied in order from top to bottom.</span>
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="w-[95vw] max-w-2xl max-h-[90dvh] overflow-y-auto rounded-3xl p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">{editingId ? T("editProduct") : T("addNewProduct")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-4">
            {/* Image Uploader */}
            <div className="space-y-2">
              <label className="text-sm font-semibold">Product Image</label>
              <div
                className="relative border-2 border-dashed border-border rounded-xl overflow-hidden cursor-pointer hover:border-primary/60 transition-colors"
                style={{ height: imagePreview ? 160 : 100 }}
                onClick={() => fileInputRef.current?.click()}
              >
                {imagePreview ? (
                  <>
                    <SafeImage src={imagePreview} alt="preview" className="w-full h-full object-cover" />
                    {imageUploading && (
                      <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2">
                        <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span className="text-white text-xs font-semibold">Uploading...</span>
                      </div>
                    )}
                    {!imageUploading && (
                      <button
                        type="button"
                        className="absolute top-2 right-2 w-7 h-7 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
                        onClick={e => { e.stopPropagation(); setImagePreview(""); setFormData(prev => ({ ...prev, image: "" })); }}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <ImageIcon className="w-7 h-7" />
                    <span className="text-xs font-medium">Click to upload image (JPEG/PNG/WebP, max 10MB)</span>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                className="hidden"
                onChange={handleImageSelect}
              />
              {imageUploading && (
                <div className="mt-2">
                  <UploadProgress
                    status="uploading"
                    progress={uploadPercent ?? 0}
                    fileName="Uploading image"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-semibold">Name *</label>
                <Input required maxLength={120} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="h-11 rounded-xl" placeholder="e.g. Fresh Milk" />
              </div>
              <div className="space-y-2 relative">
                <label className="text-sm font-semibold">Category *</label>
                <div className="relative">
                  <Input
                    value={categorySearch}
                    onChange={e => {
                      setCategorySearch(e.target.value);
                      setCategoryDropOpen(true);
                      if (!e.target.value.trim()) {
                        setFormData(prev => ({ ...prev, category: "" }));
                      }
                    }}
                    onFocus={() => setCategoryDropOpen(true)}
                    onBlur={() => setTimeout(() => {
                      setCategoryDropOpen(false);
                      if (!formData.category) setCategorySearch("");
                    }, 150)}
                    className="h-11 rounded-xl pr-8"
                    placeholder="Search and select a category..."
                  />
                  {formData.category && (
                    <div className="mt-1 text-xs text-muted-foreground px-1">
                      Selected: <span className="font-semibold text-primary">{formData.category}</span>
                    </div>
                  )}
                  {categoryDropOpen && filteredCategories.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-border rounded-xl shadow-lg max-h-40 overflow-y-auto">
                      {filteredCategories.slice(0, 8).map(cat => (
                        <button
                          key={cat.id}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted/60 flex items-center gap-2"
                          onMouseDown={() => {
                            setCategorySearch(cat.name);
                            setFormData(prev => ({ ...prev, category: cat.id }));
                            setCategoryDropOpen(false);
                          }}
                        >
                          {cat.icon && <span>{cat.icon}</span>}
                          <span className="font-medium">{cat.name}</span>
                          <span className="text-muted-foreground text-xs ml-auto">{cat.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Type *</label>
                <select
                  className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm"
                  value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}
                >
                  <option value="mart">Mart</option>
                  <option value="food">Food</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Unit</label>
                <Input maxLength={32} value={formData.unit} onChange={e => setFormData({...formData, unit: e.target.value})} className="h-11 rounded-xl" placeholder="e.g. 1 kg, 500ml" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Price (Rs.) *</label>
                {/* Cap retail price at 1,000,000 to catch typos before
                    they reach the order/inventory pipeline. */}
                <Input type="number" required min="1" max="1000000" step="0.01" value={formData.price} onChange={e => setFormData({...formData, price: e.target.value})} className="h-11 rounded-xl" placeholder="e.g. 250" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Original Price (Rs.)</label>
                <Input type="number" min="1" max="1000000" step="0.01" value={formData.originalPrice} onChange={e => setFormData({...formData, originalPrice: e.target.value})} className="h-11 rounded-xl" placeholder="optional (for sale)" />
              </div>
              <div className="space-y-2 col-span-2">
                <label className="text-sm font-semibold">Description</label>
                <Input maxLength={500} value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} className="h-11 rounded-xl" placeholder="Short description..." />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Vendor / Restaurant</label>
                <Input maxLength={120} value={formData.vendorName} onChange={e => setFormData({...formData, vendorName: e.target.value})} className="h-11 rounded-xl" placeholder="e.g. AJK Fresh Foods" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold">Delivery Time</label>
                <Input maxLength={48} value={formData.deliveryTime} onChange={e => setFormData({...formData, deliveryTime: e.target.value})} className="h-11 rounded-xl" placeholder="e.g. 30-45 min" />
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-xl border border-border/50">
              <input
                type="checkbox" id="instock"
                checked={formData.inStock}
                onChange={e => setFormData({...formData, inStock: e.target.checked})}
                className="w-5 h-5 rounded accent-primary"
              />
              <label htmlFor="instock" className="font-semibold text-sm cursor-pointer">
                Product is currently in stock
              </label>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" className="h-11 px-6 rounded-xl" onClick={() => setIsFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending || imageUploading} className="h-11 px-8 rounded-xl">
                {imageUploading ? "Uploading image..." : (createMutation.isPending || updateMutation.isPending) ? "Saving..." : editingId ? 'Save Changes' : 'Create Product'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="w-[95vw] max-w-sm rounded-3xl p-6">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete Product?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mt-2">
            Are you sure you want to delete <strong>"{deleteTarget?.name}"</strong>? This cannot be undone.
          </p>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-xl"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject Modal */}
      {rejectTarget && <RejectModal product={rejectTarget} onClose={() => setRejectTarget(null)} />}

      {/* PENDING APPROVAL TAB */}
      {tab === "pending" && (
        <div className="space-y-4">
          {pendingCount > 0 && (
            <div className="flex items-center gap-3 bg-amber-50 border-2 border-amber-400 rounded-2xl px-4 py-3">
              <span className="text-2xl">⏳</span>
              <div>
                <p className="text-sm font-bold text-amber-800">{pendingCount} product{pendingCount > 1 ? "s" : ""} waiting for your review</p>
                <p className="text-xs text-amber-600">Vendor-submitted products that need approval before going live</p>
              </div>
            </div>
          )}
          {/* Mobile cards — visible below md */}
          <div className="md:hidden space-y-3">
            {pendingLoading ? (
              [1,2,3].map(i => <div key={i} className="h-28 bg-muted rounded-2xl animate-pulse" />)
            ) : pendingProducts.length === 0 ? (
              <Card className="rounded-2xl border-border/50">
                <CardContent className="p-12 flex flex-col items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-10 h-10 text-green-400" />
                  <p className="font-semibold">All caught up!</p>
                  <p className="text-sm">No products waiting for approval.</p>
                </CardContent>
              </Card>
            ) : pendingProducts.map((p: ProductRow) => (
              <Card key={p.id} className="rounded-2xl border-border/50 shadow-sm">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground truncate">{p.name}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant={p.type === 'food' ? 'default' : 'secondary'} className="text-[10px] uppercase">{p.type}</Badge>
                        <span className="text-xs text-muted-foreground capitalize">{p.category}</span>
                        {p.unit && <span className="text-xs text-muted-foreground">{p.unit}</span>}
                      </div>
                      {p.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{p.description}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="font-bold text-foreground">{formatCurrency(p.price)}</p>
                      {p.originalPrice && <p className="text-xs line-through text-muted-foreground">{formatCurrency(p.originalPrice)}</p>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{p.vendorName || "—"}</span>
                    <span>{p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-PK", { day: "numeric", month: "short" }) : "—"}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleApprove(p)}
                      disabled={approveMutation.isPending}
                      className="flex-1 bg-green-600 hover:bg-green-700 text-white h-8 rounded-xl gap-1.5 text-xs font-bold disabled:opacity-60"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRejectTarget(p)}
                      className="flex-1 border-red-300 text-red-600 hover:bg-red-50 h-8 rounded-xl gap-1.5 text-xs font-bold"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Desktop table — visible from md up */}
          <Card className="hidden md:block rounded-2xl border-border/50 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingLoading ? (
                    <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Loading pending products...</TableCell></TableRow>
                  ) : pendingProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-48 text-center">
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          <CheckCircle className="w-10 h-10 text-green-400" />
                          <p className="font-semibold">All caught up!</p>
                          <p className="text-sm">No products waiting for approval.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    pendingProducts.map((p: ProductRow) => (
                      <TableRow key={p.id} className="hover:bg-amber-50/40">
                        <TableCell>
                          <p className="font-semibold text-foreground">{p.name}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant={p.type === 'food' ? 'default' : 'secondary'} className="text-[10px] uppercase">
                              {p.type}
                            </Badge>
                            {p.unit && <span className="text-xs text-muted-foreground">{p.unit}</span>}
                          </div>
                          {p.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{p.description}</p>}
                        </TableCell>
                        <TableCell className="capitalize font-medium text-sm">{p.category}</TableCell>
                        <TableCell>
                          <p className="font-bold text-foreground">{formatCurrency(p.price)}</p>
                          {p.originalPrice && (
                            <p className="text-xs line-through text-muted-foreground">{formatCurrency(p.originalPrice)}</p>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.vendorName || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-PK", { day: "numeric", month: "short" }) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleApprove(p)}
                              disabled={approveMutation.isPending}
                              className="bg-green-600 hover:bg-green-700 text-white h-8 px-3 rounded-xl gap-1.5 text-xs font-bold disabled:opacity-60"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setRejectTarget(p)}
                              className="border-red-300 text-red-600 hover:bg-red-50 h-8 px-3 rounded-xl gap-1.5 text-xs font-bold"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>
      )}

      {/* ALL PRODUCTS TAB */}
      {tab === "all" && (
        <>
          {/* Filters */}
          <Card className="p-4 rounded-2xl border-border/50 shadow-sm space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or category..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 h-11 rounded-xl"
                />
              </div>
              <div className="relative sm:w-44">
                <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Filter vendor..."
                  value={vendorFilter}
                  onChange={e => setVendorFilter(e.target.value)}
                  className="pl-9 h-11 rounded-xl"
                />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {["all", "mart", "food"].map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold capitalize transition-colors border ${
                    typeFilter === t ? "bg-primary text-white border-primary" : "bg-muted/30 border-border/50 hover:border-primary text-muted-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
              <div className="w-px bg-border/60 mx-1" />
              {[{ v: "all", l: "All Stock" }, { v: "in", l: "In Stock" }, { v: "out", l: "Out of Stock" }].map(s => (
                <button
                  key={s.v}
                  onClick={() => setStockFilter(s.v)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors border ${
                    stockFilter === s.v ? "bg-green-600 text-white border-green-600" : "bg-muted/30 border-border/50 hover:border-green-300 text-muted-foreground"
                  }`}
                >
                  {s.l}
                </button>
              ))}
            </div>
          </Card>

          {/* Mobile card list */}
          <div className="md:hidden space-y-3">
            {isLoading ? (
              [1,2,3].map(i => <div key={i} className="h-20 bg-muted rounded-2xl animate-pulse" />)
            ) : filtered.length === 0 ? (
              <Card className="rounded-2xl p-12 text-center border-border/50">
                <p className="text-muted-foreground text-sm">No products found.</p>
              </Card>
            ) : filtered.map((p: ProductRow) => (
              <Card key={p.id} className="rounded-2xl border-border/50 shadow-sm p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground truncate">{p.name}</p>
                      <Badge variant={p.type === "food" ? "default" : "secondary"} className="text-[10px] uppercase">{p.type}</Badge>
                      {!p.inStock && <StatusBadge status="inactive" label="Out of Stock" size="xs" />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 capitalize">{p.category}{p.vendorName ? ` · ${p.vendorName}` : ""}</p>
                    <p className="font-bold text-foreground text-sm mt-1">{formatCurrency(p.price)}</p>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button
                      onClick={() => toggleStock(p)}
                      disabled={updateMutation.isPending || !canWrite}
                      className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold border disabled:opacity-50 ${p.inStock ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}
                    >
                      {p.inStock ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                      {p.inStock ? "In Stock" : "Out"}
                    </button>
                    {canWrite && (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)} className="hover:bg-blue-50 hover:text-blue-600 h-7 w-7">
                          <Edit className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(p)} className="hover:bg-red-50 hover:text-red-600 h-7 w-7">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Bulk Actions Bar */}
          {selectedProductIds.size > 0 && (
            <div className="sticky top-0 z-20 bg-violet-600 text-white rounded-2xl px-4 py-3 flex items-center justify-between shadow-lg">
              <span className="text-sm font-semibold">{selectedProductIds.size} product{selectedProductIds.size > 1 ? "s" : ""} selected</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={() => setShowBulkEdit(true)} disabled={!canWrite}>
                  <Edit className="w-3.5 h-3.5 mr-1" /> Bulk Edit
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-white hover:bg-white/20 text-xs" onClick={() => setSelectedProductIds(new Set())}>
                  <X className="w-3.5 h-3.5" /> Clear
                </Button>
              </div>
            </div>
          )}

          {/* Desktop table */}
          <Card className="hidden md:block rounded-2xl border-border/50 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[600px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-violet-600"
                        checked={filtered.length > 0 && filtered.every((p: ProductRow) => selectedProductIds.has(p.id))}
                        onChange={e => {
                          if (e.target.checked) setSelectedProductIds(new Set(filtered.map((p: ProductRow) => p.id)));
                          else setSelectedProductIds(new Set());
                        }}
                      />
                    </TableHead>
                    {([
                      { key: "name",     label: T("product") },
                      { key: "category", label: T("category") },
                      { key: "price",    label: T("price") },
                      { key: "vendor",   label: T("vendor") },
                    ] as const).map(col => (
                      <TableHead key={col.key} className="cursor-pointer select-none group" onClick={() => toggleSort(col.key)}>
                        <div className="flex items-center gap-1">
                          {col.label}
                          {sortKey === col.key
                            ? sortDir === "asc"
                              ? <ArrowUp className="w-3 h-3 text-primary" />
                              : <ArrowDown className="w-3 h-3 text-primary" />
                            : <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />}
                        </div>
                      </TableHead>
                    ))}
                    <TableHead>{T("stock")}</TableHead>
                    <TableHead className="text-right">{T("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Loading products...</TableCell></TableRow>
                  ) : filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No products found.</TableCell></TableRow>
                  ) : (
                    filtered.map((p: ProductRow) => (
                      <TableRow key={p.id} className={`hover:bg-muted/30 ${selectedProductIds.has(p.id) ? "bg-violet-50/60" : ""}`}>
                        <TableCell>
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded accent-violet-600 cursor-pointer"
                            checked={selectedProductIds.has(p.id)}
                            onChange={() => toggleProductSelect(p.id)}
                            onClick={e => e.stopPropagation()}
                          />
                        </TableCell>
                        <TableCell>
                          <p className="font-semibold text-foreground">{p.name}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant={p.type === 'food' ? 'default' : 'secondary'} className="text-[10px] uppercase">
                              {p.type}
                            </Badge>
                            {p.unit && <span className="text-xs text-muted-foreground">{p.unit}</span>}
                          </div>
                        </TableCell>
                        <TableCell className="capitalize font-medium text-sm">{p.category}</TableCell>
                        <TableCell>
                          <p className="font-bold text-foreground">{formatCurrency(p.price)}</p>
                          {p.originalPrice && (
                            <p className="text-xs line-through text-muted-foreground">{formatCurrency(p.originalPrice)}</p>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.vendorName || "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <StatusBadge
                              status={p.inStock ? "active" : "inactive"}
                              label={p.inStock ? "In Stock" : "Out of Stock"}
                              size="xs"
                            />
                            {canWrite && (
                              <button
                                onClick={() => toggleStock(p)}
                                disabled={updateMutation.isPending}
                                className="ml-1 opacity-50 hover:opacity-100 transition-opacity"
                                title={p.inStock ? "Mark out of stock" : "Mark in stock"}
                              >
                                {p.inStock
                                  ? <ToggleRight className="w-4 h-4 text-green-600" />
                                  : <ToggleLeft  className="w-4 h-4 text-red-600" />
                                }
                              </button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setStockHistoryProduct(p)}
                              className="hover:bg-violet-50 hover:text-violet-600 h-8 w-8"
                              title="Stock history"
                            >
                              <History className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => openEdit(p)} className="hover:bg-blue-50 hover:text-blue-600 h-8 w-8" disabled={!canWrite}>
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(p)} className="hover:bg-red-50 hover:text-red-600 h-8 w-8" disabled={!canWrite}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
    </ErrorBoundary>

    {stockHistoryProduct && (
      <StockHistoryDialog
        product={stockHistoryProduct}
        vendors={vendors}
        onClose={() => setStockHistoryProduct(null)}
      />
    )}

    {/* Bulk Edit Dialog */}
    {showBulkEdit && (
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowBulkEdit(false)}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center">
              <Edit className="w-5 h-5 text-violet-700" />
            </div>
            <div>
              <h2 className="font-bold text-foreground">Bulk Edit Products</h2>
              <p className="text-xs text-muted-foreground">{selectedProductIds.size} product{selectedProductIds.size !== 1 ? "s" : ""} will be updated</p>
            </div>
          </div>
          <div className="px-5 py-4 space-y-4">
            <p className="text-xs text-muted-foreground">Leave any field blank to keep existing values unchanged.</p>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">New Price (Rs.)</label>
              <Input
                type="number"
                min="1"
                max="1000000"
                step="0.01"
                value={bulkPrice}
                onChange={e => setBulkPrice(e.target.value)}
                placeholder="Leave blank to keep current price"
                className="h-10 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category</label>
              <Input
                value={bulkCategory}
                onChange={e => setBulkCategory(e.target.value)}
                placeholder="Leave blank to keep current category"
                className="h-10 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Stock Status</label>
              <select
                value={bulkStock}
                onChange={e => setBulkStock(e.target.value as "" | "in" | "out")}
                className="w-full h-10 rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">No change</option>
                <option value="in">Mark all In Stock</option>
                <option value="out">Mark all Out of Stock</option>
              </select>
            </div>
          </div>
          <div className="px-5 py-4 border-t border-border flex justify-end gap-3 bg-muted/30">
            <Button variant="outline" className="h-9 rounded-xl" onClick={() => setShowBulkEdit(false)}>Cancel</Button>
            <Button className="h-9 rounded-xl" onClick={handleBulkEdit} disabled={bulkApplying}>
              {bulkApplying ? "Applying…" : `Apply to ${selectedProductIds.size} products`}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
