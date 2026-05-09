import { useState } from "react";
import { useHasPermission } from "@/hooks/usePermissions";
import { PageHeader } from "@/components/shared";
import {
  Server, Plus, Trash2, Edit2, RefreshCw, CheckCircle2,
  XCircle, Loader2, ToggleRight, ToggleLeft, Wifi,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSmsGateways, useCreateSmsGateway, useUpdateSmsGateway, useDeleteSmsGateway, useToggleSmsGateway } from "@/hooks/use-admin";

const PROVIDERS = [
  { value: "twilio",  label: "Twilio",           color: "text-red-600"    },
  { value: "msg91",   label: "MSG91",             color: "text-blue-600"   },
  { value: "zong",    label: "Zong / CM.com",     color: "text-green-600"  },
  { value: "console", label: "Console (Dev Only)", color: "text-gray-500"  },
];

const PROVIDER_FIELDS: Record<string, { key: string; label: string; placeholder: string; secret?: boolean }[]> = {
  twilio: [
    { key: "accountSid", label: "Account SID",  placeholder: "ACxxxxxxxxxxxxx" },
    { key: "authToken",  label: "Auth Token",   placeholder: "••••••••••", secret: true },
    { key: "fromNumber", label: "From Number",  placeholder: "+12345678900" },
    { key: "senderId",   label: "Sender Name",  placeholder: "AJKMart" },
  ],
  msg91: [
    { key: "msg91Key",  label: "Auth Key",     placeholder: "MSG91 auth key", secret: true },
    { key: "senderId",  label: "Sender ID",    placeholder: "AJKMAT" },
  ],
  zong: [
    { key: "apiKey",    label: "API Key",      placeholder: "CM.com product token", secret: true },
    { key: "senderId",  label: "Sender Name",  placeholder: "AJKMart" },
    { key: "apiUrl",    label: "API URL",      placeholder: "https://api.cm.com/v1.0/message" },
  ],
  console: [],
};

const emptyForm = { name: "", provider: "twilio", priority: 10, accountSid: "", authToken: "", fromNumber: "", msg91Key: "", senderId: "", apiKey: "", apiUrl: "" };

export default function SmsGateways() {
  const { toast } = useToast();
  const canWrite = useHasPermission("system.secrets.manage");
  const { data, isLoading, refetch } = useSmsGateways();
  const createGw = useCreateSmsGateway();
  const updateGw = useUpdateSmsGateway();
  const deleteGw = useDeleteSmsGateway();
  const toggleGw = useToggleSmsGateway();

  const [modal, setModal] = useState<"add" | "edit" | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof emptyForm>({ ...emptyForm });
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const gateways = data?.gateways ?? [];

  function openAdd() { setForm({ ...emptyForm }); setEditId(null); setModal("add"); }
  function openEdit(gw: any) {
    setForm({ name: gw.name, provider: gw.provider, priority: gw.priority, accountSid: "", authToken: "", fromNumber: gw.fromNumber ?? "", msg91Key: "", senderId: gw.senderId ?? "", apiKey: "", apiUrl: gw.apiUrl ?? "" });
    setEditId(gw.id); setModal("edit");
  }

  async function handleSave() {
    if (!form.name || !form.provider) { toast({ title: "Name and provider are required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      if (modal === "add") {
        await createGw.mutateAsync(form);
        toast({ title: "Gateway created" });
      } else if (editId) {
        await updateGw.mutateAsync({ id: editId, ...form });
        toast({ title: "Gateway updated" });
      }
      setModal(null);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete gateway "${name}"?`)) return;
    try { await deleteGw.mutateAsync(id); toast({ title: "Gateway deleted" }); }
    catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  }

  async function handleToggle(id: string) {
    try { await toggleGw.mutateAsync(id); }
    catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  }

  const fields = PROVIDER_FIELDS[form.provider] ?? [];

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        icon={Server}
        title="SMS Gateways"
        subtitle="Configure SMS providers with priority-based automatic failover."
        iconBgClass="bg-blue-100"
        iconColorClass="text-blue-600"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} className="rounded-xl gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>
            <Button size="sm" onClick={openAdd} className="rounded-xl gap-1.5"><Plus className="w-4 h-4" /> Add Gateway</Button>
          </div>
        }
      />

      {/* Failover explanation */}
      <Card className="p-4 border-blue-200 bg-blue-50">
        <div className="flex items-start gap-3">
          <Wifi className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-semibold text-blue-800">Auto-Failover Active</p>
            <p className="text-blue-700 mt-0.5">When a gateway fails, AJKMart automatically tries the next active gateway by priority. Set lower priority numbers for preferred providers.</p>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="w-8 h-8 animate-spin" /></div>
      ) : gateways.length === 0 ? (
        <Card className="p-12 text-center border-dashed">
          <Server className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-40" />
          <p className="text-muted-foreground">No SMS gateways configured</p>
          <Button variant="outline" onClick={openAdd} className="mt-4 rounded-xl gap-2"><Plus className="w-4 h-4" /> Add First Gateway</Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {gateways.map((gw: any) => {
            const prov = PROVIDERS.find(p => p.value === gw.provider);
            return (
              <Card key={gw.id} className={`p-4 ${gw.isActive ? "border-green-200 bg-green-50/30" : "border-gray-200 bg-muted/20 opacity-60"}`}>
                <div className="flex items-center gap-4 flex-wrap">
                  {/* Priority badge */}
                  <div className="w-10 h-10 rounded-full bg-white border-2 border-border flex items-center justify-center font-bold text-sm shadow-sm flex-shrink-0">{gw.priority}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm truncate">{gw.name}</p>
                      <span className={`text-xs font-medium ${prov?.color ?? "text-gray-600"}`}>{prov?.label ?? gw.provider}</span>
                      {gw.hasCredentials && <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-200">Configured</Badge>}
                      {!gw.hasCredentials && gw.provider !== "console" && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">No Credentials</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {gw.senderId && `Sender: ${gw.senderId}`}
                      {gw.fromNumber && ` • From: ${gw.fromNumber}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {gw.isActive
                      ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                      : <XCircle className="w-4 h-4 text-gray-400" />}
                    <Switch checked={gw.isActive} onCheckedChange={() => handleToggle(gw.id)} />
                    <Button variant="ghost" size="sm" onClick={() => openEdit(gw)} className="rounded-lg" disabled={!canWrite} title={canWrite ? undefined : "You don't have permission to edit"}><Edit2 className="w-4 h-4" /></Button>
                    {gw.id !== "default-console" && (
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(gw.id, gw.name)} className="rounded-lg text-red-500 hover:bg-red-50" disabled={!canWrite} title={canWrite ? undefined : "You don't have permission to delete"}><Trash2 className="w-4 h-4" /></Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      <Dialog open={!!modal} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{modal === "add" ? "Add SMS Gateway" : "Edit SMS Gateway"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <label className="text-sm font-medium">Gateway Name</label>
              <Input className="mt-1 rounded-xl" placeholder="e.g. Twilio Primary" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium">Provider</label>
              <Select value={form.provider} onValueChange={v => setForm(f => ({ ...f, provider: v }))}>
                <SelectTrigger className="rounded-xl mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Priority <span className="text-muted-foreground">(lower = tried first)</span></label>
              <Input className="mt-1 rounded-xl" type="number" min={1} max={99} value={form.priority} onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 10 }))} />
            </div>
            {fields.map(field => (
              <div key={field.key}>
                <label className="text-sm font-medium">{field.label}</label>
                <div className="relative mt-1">
                  <Input
                    className="rounded-xl pr-10"
                    placeholder={field.placeholder}
                    type={field.secret && !showSecret[field.key] ? "password" : "text"}
                    value={(form[field.key as keyof typeof emptyForm] ?? "") as string}
                    onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                  />
                  {field.secret && (
                    <button type="button" onClick={() => setShowSecret(s => ({ ...s, [field.key]: !s[field.key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs">
                      {showSecret[field.key] ? "Hide" : "Show"}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setModal(null)}>Cancel</Button>
              <Button className="flex-1 rounded-xl" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {modal === "add" ? "Add Gateway" : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
