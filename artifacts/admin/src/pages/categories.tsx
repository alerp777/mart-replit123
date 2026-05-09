import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FolderTree, Plus, Pencil, Trash2, Save,
  ChevronRight, ChevronDown, ArrowUp, ArrowDown,
  ToggleLeft, ToggleRight, Search, GripVertical, Upload, X, Loader2,
} from "lucide-react";
import { PageHeader } from "@/components/shared";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { useToast } from "@/hooks/use-toast";
import { useErrorHandler } from "@/hooks/useErrorHandler";
import { fetcher } from "@/lib/api";
import { getAdminTiming } from "@/lib/adminTiming";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/lib/useLanguage";
import { tDual, type TranslationKey } from "@workspace/i18n";

interface Category {
  id: string;
  name: string;
  icon: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  children?: Category[];
}

const ICON_OPTIONS = [
  "grid-outline", "leaf-outline", "fish-outline", "egg-outline", "cafe-outline",
  "home-outline", "wine-outline", "pizza-outline", "heart-outline",
  "restaurant-outline", "fast-food-outline", "flame-outline", "nutrition-outline",
  "ice-cream-outline", "basket-outline", "cart-outline", "medical-outline",
  "fitness-outline", "paw-outline", "shirt-outline", "car-outline",
  "book-outline", "laptop-outline", "phone-portrait-outline", "gift-outline",
  "flower-outline", "color-palette-outline", "construct-outline", "diamond-outline",
];

const TYPE_OPTIONS = [
  { value: "mart", label: "Mart" },
  { value: "food", label: "Food" },
  { value: "pharmacy", label: "Pharmacy" },
];

const EMPTY_FORM = {
  name: "",
  icon: "grid-outline",
  type: "mart",
  parentId: "",
  sortOrder: 0,
  isActive: true,
};

export default function CategoriesPage() {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { onError: onCategoryError } = useErrorHandler({ title: "Error" });

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editing, setEditing] = useState<Category | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<string>("");
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; msg: string } | null>(null);
  const [showAllCats, setShowAllCats] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-categories-tree", filterType],
    queryFn: () => fetcher(`/categories/tree${filterType ? `?type=${filterType}` : ""}`),
    refetchInterval: getAdminTiming().refetchIntervalCategoriesMs,
  });

  const categories: Category[] = data?.categories || [];

  /* ── Filtered view (search-aware) ── */
  const q = search.trim().toLowerCase();
  const filteredCategories = q
    ? categories
        .filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.children || []).some(ch => ch.name.toLowerCase().includes(q))
        )
        .map(c => ({
          ...c,
          children: (c.children || []).filter(ch =>
            c.name.toLowerCase().includes(q) || ch.name.toLowerCase().includes(q)
          ),
        }))
    : categories;

  const flatCategories = categories.flatMap(c => [c, ...(c.children || [])]);

  const showLoadMore = !showAllCats && filteredCategories.length > 200;

  /* ── Mutations ── */
  type SaveCategoryBody = {
    name: string;
    icon: string;
    type: string;
    parentId: string | null;
    sortOrder: number;
    isActive: boolean;
  };
  const saveMutation = useMutation({
    mutationFn: async (body: SaveCategoryBody) => {
      if (editing) return fetcher(`/categories/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      return fetcher("/categories", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-categories-tree"] });
      setDialogOpen(false);
      setEditing(null);
      setForm({ ...EMPTY_FORM });
      toast({ title: editing ? "Category updated" : "Category created" });
    },
    onError: onCategoryError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetcher(`/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-categories-tree"] });
      toast({ title: "Category deleted" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      fetcher(`/categories/${id}`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-categories-tree"] }),
  });

  const reorderMutation = useMutation({
    mutationFn: (items: { id: string; sortOrder: number }[]) =>
      fetcher("/categories/reorder", { method: "POST", body: JSON.stringify({ items }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-categories-tree"] }),
  });

  /* ── Drag-to-reorder handler (top-level) ── */
  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, type } = result;
    if (source.index === destination.index && source.droppableId === destination.droppableId) return;

    if (type === "TOP_LEVEL") {
      const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
      const reordered = [...sorted];
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      const items = reordered.map((cat, i) => ({ id: cat.id, sortOrder: i }));
      reorderMutation.mutate(items);
    } else {
      /* Sub-category reorder: droppableId = parent category id */
      const parentId = source.droppableId;
      const parent = categories.find(c => c.id === parentId);
      if (!parent?.children) return;
      const sorted = [...parent.children].sort((a, b) => a.sortOrder - b.sortOrder);
      const [moved] = sorted.splice(source.index, 1);
      sorted.splice(destination.index, 0, moved);
      const items = sorted.map((ch, i) => ({ id: ch.id, sortOrder: i }));
      reorderMutation.mutate(items);
    }
  };

  /* ── Arrow-based move (fallback for sub-cats when search active) ── */
  const moveCategory = (catId: string, direction: "up" | "down", parentId?: string | null) => {
    const siblings = parentId
      ? categories.find(c => c.id === parentId)?.children ?? []
      : categories;
    const sorted = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex(c => c.id === catId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[swapIdx];
    if (!a || !b) return;
    const items = [
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: a.sortOrder },
    ];
    reorderMutation.mutate(items);
  };

  const openNew = (parentId?: string) => {
    setEditing(null);
    const nextSort = parentId
      ? (categories.find(c => c.id === parentId)?.children?.length ?? 0)
      : categories.length;
    setForm({ ...EMPTY_FORM, parentId: parentId || "", sortOrder: nextSort });
    setDialogOpen(true);
  };

  const openEdit = (cat: Category) => {
    setEditing(cat);
    setForm({
      name: cat.name,
      icon: cat.icon,
      type: cat.type,
      parentId: cat.parentId || "",
      sortOrder: cat.sortOrder,
      isActive: cat.isActive,
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    saveMutation.mutate({
      name: form.name.trim(),
      icon: form.icon,
      type: form.type,
      parentId: form.parentId || null,
      sortOrder: form.sortOrder,
      isActive: form.isActive,
    });
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalActive = flatCategories.filter(c => c.isActive).length;
  const totalInactive = flatCategories.filter(c => !c.isActive).length;
  const isSearching = q.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderTree}
        title={T("navCategories")}
        subtitle={`${totalActive} active · ${totalInactive} inactive${!isSearching ? " · Drag rows to reorder" : ""}`}
        iconBgClass="bg-indigo-100"
        iconColorClass="text-indigo-600"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="h-10 rounded-xl border border-input bg-background px-3 text-sm"
          >
            <option value="">All Types</option>
            {TYPE_OPTIONS.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <Button onClick={() => openNew()} className="h-10 rounded-xl gap-2 shadow-md">
            <Plus className="w-4 h-4" />
            Add Category
          </Button>
        </div>
        }
      />

      {/* ── Search bar ── */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search categories by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 pr-9 h-10 rounded-xl"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ── Category list ── */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-16 bg-muted rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : filteredCategories.length === 0 ? (
          <Card className="rounded-2xl border-border/50">
            <CardContent className="p-16 text-center">
              <FolderTree className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground font-medium">
                {isSearching ? `No categories matching "${search}"` : "No categories yet"}
              </p>
              {!isSearching && (
                <>
                  <p className="text-sm text-muted-foreground/60 mt-1">Create your first category to get started</p>
                  <Button onClick={() => openNew()} className="mt-4 rounded-xl gap-2">
                    <Plus className="w-4 h-4" /> Add Category
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        ) : isSearching ? (
          /* Search results: flat list without drag-and-drop */
          <div className="space-y-2">
            {filteredCategories.map(cat => (
              <div key={cat.id}>
                <CategoryCard
                  cat={cat}
                  onEdit={openEdit}
                  onDelete={(id: string) => { setDeleteConfirm({ id, name: cat.name, msg: `Delete "${cat.name}"?` }); }}
                  onToggle={(id: string) => toggleMutation.mutate({ id, isActive: !cat.isActive })}
                  onAddChild={() => openNew(cat.id)}
                  onToggleExpand={toggleExpand}
                  expanded={expandedIds.has(cat.id)}
                  categories={categories}
                  toggleMutation={toggleMutation}
                  deleteMutation={deleteMutation}
                  openEdit={openEdit}
                  moveCategory={moveCategory}
                  isDragging={false}
                  isSearching={true}
                />
              </div>
            ))}
          </div>
        ) : (
          /* Normal view: drag-and-drop enabled */
          <>
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="top-level" type="TOP_LEVEL">
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={`space-y-2 transition-colors rounded-2xl ${snapshot.isDraggingOver ? "bg-indigo-50/50 p-2" : ""}`}
                >
                  {[...filteredCategories].sort((a, b) => a.sortOrder - b.sortOrder).slice(0, showAllCats ? undefined : 200).map((cat, index) => {
                    const hasChildren = (cat.children?.length ?? 0) > 0;
                    const isExpanded = expandedIds.has(cat.id);
                    return (
                      <Draggable key={cat.id} draggableId={cat.id} index={index}>
                        {(drag, dragSnapshot) => (
                          <div ref={drag.innerRef} {...drag.draggableProps}>
                            <Card className={`rounded-2xl border-border/50 shadow-sm transition-all ${
                              dragSnapshot.isDragging ? "shadow-xl ring-2 ring-indigo-300 rotate-1 scale-[1.02]" : "hover:shadow-md"
                            } ${!cat.isActive ? "opacity-60" : ""}`}>
                              <CardContent className="p-4">
                                <div className="flex items-center gap-3">
                                  {/* Drag handle */}
                                  <div {...drag.dragHandleProps} className="flex-shrink-0 cursor-grab active:cursor-grabbing p-1 hover:bg-muted rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                                    <GripVertical className="w-4 h-4" />
                                  </div>

                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    {hasChildren ? (
                                      <button onClick={() => toggleExpand(cat.id)} className="p-1 hover:bg-muted rounded-md">
                                        {isExpanded
                                          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                          : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                                      </button>
                                    ) : (
                                      <div className="w-6" />
                                    )}
                                  </div>

                                  <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                                    <span className="text-lg">📂</span>
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="font-bold text-foreground truncate">{cat.name}</p>
                                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                        cat.type === "mart" ? "bg-violet-100 text-violet-700"
                                        : cat.type === "food" ? "bg-amber-100 text-amber-700"
                                        : "bg-green-100 text-green-700"
                                      }`}>
                                        {cat.type.toUpperCase()}
                                      </span>
                                      {!cat.isActive && (
                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">INACTIVE</span>
                                      )}
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {cat.icon.replace("-outline", "")} · #{index + 1}
                                      {hasChildren && ` · ${(cat.children ?? []).length} sub-categories`}
                                    </p>
                                  </div>

                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    <button onClick={() => openNew(cat.id)} className="p-2 hover:bg-muted rounded-lg transition-colors" title="Add sub-category">
                                      <Plus className="w-4 h-4 text-indigo-600" />
                                    </button>
                                    <button
                                      onClick={() => toggleMutation.mutate({ id: cat.id, isActive: !cat.isActive })}
                                      disabled={toggleMutation.isPending}
                                      className="p-2 hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
                                    >
                                      {toggleMutation.isPending
                                        ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                        : cat.isActive
                                          ? <ToggleRight className="w-5 h-5 text-green-600" />
                                          : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
                                    </button>
                                    <button onClick={() => openEdit(cat)} className="p-2 hover:bg-muted rounded-lg transition-colors">
                                      <Pencil className="w-4 h-4 text-blue-600" />
                                    </button>
                                    <button
                                      onClick={() => { setDeleteConfirm({ id: cat.id, name: cat.name, msg: `Delete "${cat.name}"? This will also unparent any sub-categories.` }); }}
                                      className="p-2 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                      <Trash2 className="w-4 h-4 text-red-500" />
                                    </button>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>

                            {/* ── Sub-categories (nested droppable) ── */}
                            {hasChildren && isExpanded && (
                              <Droppable droppableId={cat.id} type="SUB_LEVEL">
                                {(subProvided, subSnapshot) => (
                                  <div
                                    ref={subProvided.innerRef}
                                    {...subProvided.droppableProps}
                                    className={`ml-10 mt-1 space-y-1 transition-colors rounded-xl ${subSnapshot.isDraggingOver ? "bg-indigo-50/40 p-1.5" : ""}`}
                                  >
                                    {[...cat.children!].sort((a, b) => a.sortOrder - b.sortOrder).map((child, ci) => (
                                      <Draggable key={child.id} draggableId={child.id} index={ci}>
                                        {(childDrag, childSnap) => (
                                          <div ref={childDrag.innerRef} {...childDrag.draggableProps}>
                                            <Card className={`rounded-xl border-border/40 shadow-sm transition-all ${
                                              childSnap.isDragging ? "shadow-lg ring-2 ring-indigo-200 rotate-1" : ""
                                            } ${!child.isActive ? "opacity-60" : ""}`}>
                                              <CardContent className="p-3">
                                                <div className="flex items-center gap-3">
                                                  <div {...childDrag.dragHandleProps} className="cursor-grab active:cursor-grabbing p-1 hover:bg-muted rounded-md text-muted-foreground/40 hover:text-muted-foreground">
                                                    <GripVertical className="w-3.5 h-3.5" />
                                                  </div>
                                                  <div className="w-8 h-8 bg-indigo-50/60 rounded-lg flex items-center justify-center flex-shrink-0">
                                                    <span className="text-sm">📄</span>
                                                  </div>
                                                  <div className="flex-1 min-w-0">
                                                    <p className="font-semibold text-sm text-foreground truncate">{child.name}</p>
                                                    <p className="text-[11px] text-muted-foreground">{child.icon.replace("-outline", "")} · #{ci + 1}</p>
                                                  </div>
                                                  <div className="flex items-center gap-1 flex-shrink-0">
                                                    <button onClick={() => toggleMutation.mutate({ id: child.id, isActive: !child.isActive })} disabled={toggleMutation.isPending} className="p-1.5 hover:bg-muted rounded-lg transition-colors disabled:opacity-50">
                                                      {child.isActive
                                                        ? <ToggleRight className="w-4 h-4 text-green-600" />
                                                        : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                                                    </button>
                                                    <button onClick={() => openEdit(child)} className="p-1.5 hover:bg-muted rounded-lg transition-colors">
                                                      <Pencil className="w-3.5 h-3.5 text-blue-600" />
                                                    </button>
                                                    <button
                                                      onClick={() => { setDeleteConfirm({ id: child.id, name: child.name, msg: `Delete "${child.name}"?` }); }}
                                                      className="p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                                                    >
                                                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                                    </button>
                                                  </div>
                                                </div>
                                              </CardContent>
                                            </Card>
                                          </div>
                                        )}
                                      </Draggable>
                                    ))}
                                    {subProvided.placeholder}
                                  </div>
                                )}
                              </Droppable>
                            )}
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
          {showLoadMore && (
            <div className="flex flex-col items-center gap-1 pt-2">
              <p className="text-xs text-muted-foreground">{filteredCategories.length - 200} more categories not shown.</p>
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setShowAllCats(true)}>Load more</Button>
            </div>
          )}
          </>
        )}
      </div>

      {/* ── Add/Edit dialog ── */}
      <Dialog open={dialogOpen} onOpenChange={v => { setDialogOpen(v); if (!v) { setEditing(null); setForm({ ...EMPTY_FORM }); } }}>
        <DialogContent className="w-[95vw] max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderTree className="w-5 h-5 text-indigo-500" />
              {editing ? "Edit Category" : "Add Category"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Name <span className="text-red-500">*</span></label>
              <Input
                placeholder="e.g. Dairy & Eggs"
                value={form.name}
                /* maxLength matches the backend categories.name VARCHAR(80)
                   limit so the user sees the cutoff in the input rather
                   than a 400 from the API on submit. */
                maxLength={80}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="h-11 rounded-xl"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Type</label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm"
              >
                {TYPE_OPTIONS.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Parent Category <span className="text-muted-foreground font-normal">(optional)</span></label>
              <select
                value={form.parentId}
                onChange={e => setForm(f => ({ ...f, parentId: e.target.value }))}
                className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm"
              >
                <option value="">— None (top level) —</option>
                {categories
                  .filter(c => c.id !== editing?.id)
                  .flatMap(c => [
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>,
                    ...(c.children || [])
                      .filter(ch => ch.id !== editing?.id)
                      .map(ch => (
                        <option key={ch.id} value={ch.id}>&nbsp;&nbsp;↳ {ch.name}</option>
                      ))
                  ])}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Icon</label>
              <div className="flex flex-wrap gap-2">
                {ICON_OPTIONS.map(icon => (
                  <button
                    key={icon}
                    onClick={() => setForm(f => ({ ...f, icon }))}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                      form.icon === icon
                        ? "bg-indigo-500 text-white border-indigo-500"
                        : "bg-muted border-border text-muted-foreground hover:border-indigo-300"
                    }`}
                  >
                    {icon.replace("-outline", "")}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Sort Order</label>
              <Input
                type="number"
                min={0}
                /* Cap sortOrder at a sensible 9999; categories with a
                   higher order make no UX sense and keep the value
                   inside a smallint on the backend. */
                max={9999}
                value={form.sortOrder}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  const clamped = Number.isFinite(v) ? Math.max(0, Math.min(9999, v)) : 0;
                  setForm(f => ({ ...f, sortOrder: clamped }));
                }}
                className="h-11 rounded-xl"
              />
            </div>

            <div
              onClick={() => setForm(f => ({ ...f, isActive: !f.isActive }))}
              className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${
                form.isActive ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200"
              }`}
            >
              <span className="text-sm font-semibold">Active (visible to users)</span>
              <div className={`w-10 h-5 rounded-full relative transition-colors ${form.isActive ? "bg-green-500" : "bg-gray-300"}`}>
                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-transform ${form.isActive ? "translate-x-5" : "translate-x-0.5"}`} />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={submit} disabled={saveMutation.isPending} className="flex-1 rounded-xl gap-2">
                <Save className="w-4 h-4" />
                {saveMutation.isPending ? "Saving..." : (editing ? "Update" : "Create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation dialog ── */}
      <Dialog open={!!deleteConfirm} onOpenChange={v => { if (!v) setDeleteConfirm(null); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">{deleteConfirm?.msg}</p>
          <div className="flex gap-3 pt-1">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" className="flex-1 rounded-xl" onClick={() => { if (deleteConfirm) deleteMutation.mutate(deleteConfirm.id); setDeleteConfirm(null); }}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Inline card for search-result view ── */
interface CategoryCardProps {
  cat: Category;
  onEdit: (c: Category) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onAddChild: (parentId: string) => void;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  categories?: Category[];
  toggleMutation: { mutate: (vars: { id: string; isActive: boolean }) => void };
  deleteMutation: { mutate: (id: string) => void };
  openEdit: (c: Category) => void;
  moveCategory: (id: string, dir: "up" | "down", parentId?: string | null) => void;
  isDragging?: boolean;
  isSearching?: boolean;
}
function CategoryCard({
  cat, onEdit, onDelete, onToggle, onAddChild, expanded, onToggleExpand,
  toggleMutation, deleteMutation, openEdit, moveCategory,
}: CategoryCardProps) {
  const hasChildren = (cat.children?.length ?? 0) > 0;
  return (
    <Card className={`rounded-2xl border-border/50 shadow-sm hover:shadow-md transition-shadow ${!cat.isActive ? "opacity-60" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 flex-shrink-0">
            {hasChildren ? (
              <button onClick={() => onToggleExpand(cat.id)} className="p-1 hover:bg-muted rounded-md">
                {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              </button>
            ) : <div className="w-6" />}
          </div>
          <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <span className="text-lg">📂</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold text-foreground truncate">{cat.name}</p>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                cat.type === "mart" ? "bg-violet-100 text-violet-700"
                : cat.type === "food" ? "bg-amber-100 text-amber-700"
                : "bg-green-100 text-green-700"
              }`}>{cat.type.toUpperCase()}</span>
              {!cat.isActive && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">INACTIVE</span>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{cat.icon.replace("-outline", "")} · {hasChildren && `${cat.children!.length} sub-categories`}</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => onAddChild(cat.id)} className="p-2 hover:bg-muted rounded-lg" title="Add sub-category"><Plus className="w-4 h-4 text-indigo-600" /></button>
            <button onClick={() => onToggle(cat.id)} className="p-2 hover:bg-muted rounded-lg">
              {cat.isActive ? <ToggleRight className="w-5 h-5 text-green-600" /> : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
            </button>
            <button onClick={() => onEdit(cat)} className="p-2 hover:bg-muted rounded-lg"><Pencil className="w-4 h-4 text-blue-600" /></button>
            <button onClick={() => onDelete(cat.id)} className="p-2 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4 text-red-500" /></button>
          </div>
        </div>
      </CardContent>
      {hasChildren && expanded && (
        <div className="ml-10 pb-3 px-3 space-y-1">
          {cat.children!.map((child: Category, ci: number) => (
            <Card key={child.id} className={`rounded-xl border-border/40 shadow-sm ${!child.isActive ? "opacity-60" : ""}`}>
              <CardContent className="p-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-indigo-50/60 rounded-lg flex items-center justify-center"><span className="text-sm">📄</span></div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{child.name}</p>
                    <p className="text-[11px] text-muted-foreground">{child.icon.replace("-outline", "")}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => toggleMutation.mutate({ id: child.id, isActive: !child.isActive })} className="p-1.5 hover:bg-muted rounded-lg">
                      {child.isActive ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                    </button>
                    <button onClick={() => moveCategory(child.id, "up", cat.id)} className="p-1.5 hover:bg-muted rounded-lg"><ArrowUp className="w-3.5 h-3.5 text-muted-foreground" /></button>
                    <button onClick={() => moveCategory(child.id, "down", cat.id)} className="p-1.5 hover:bg-muted rounded-lg"><ArrowDown className="w-3.5 h-3.5 text-muted-foreground" /></button>
                    <button onClick={() => openEdit(child)} className="p-1.5 hover:bg-muted rounded-lg"><Pencil className="w-3.5 h-3.5 text-blue-600" /></button>
                    <button onClick={() => { if (confirm(`Delete "${child.name}"?`)) deleteMutation.mutate(child.id); }} className="p-1.5 hover:bg-red-50 rounded-lg"><Trash2 className="w-3.5 h-3.5 text-red-500" /></button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Card>
  );
}
