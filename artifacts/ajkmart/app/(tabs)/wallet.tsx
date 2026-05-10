import { Ionicons } from "@expo/vector-icons";
import { withErrorBoundary } from "@/utils/withErrorBoundary";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useCollapsibleHeader } from "@/hooks/useCollapsibleHeader";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "react-native-qrcode-svg";
import Colors from "@/constants/colors";
import { T as Typ, Font } from "@/constants/typography";
import { useAuth, hasRole } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { usePlatformConfig, useCurrency } from "@/context/PlatformConfigContext";
import { useLanguage } from "@/context/LanguageContext";
import { tDual } from "@workspace/i18n";
import { SmartRefresh } from "@/components/ui/SmartRefresh";
import { useGetWallet, getGetWalletQueryKey } from "@workspace/api-client-react";
import { API_BASE as API, unwrapApiResponse } from "@/utils/api";
import { AuthGateSheet } from "@/components/AuthGateSheet";

const C = Colors.light;

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

type TxFilter = "all" | "credit" | "debit";

type PayMethod = {
  id: string;
  label: string;
  description?: string;
  manualNumber?: string;
  manualName?: string;
  manualInstructions?: string;
  iban?: string;
  accountTitle?: string;
  bankName?: string;
};

type DepositStep = "method" | "details" | "amount" | "confirm" | "done";

const TX_STATUS_PENDING  = "pending";
const TX_STATUS_APPROVED = "approved";
const TX_STATUS_REJECTED = "rejected";

type WalletTx = {
  id: string;
  type: string;
  amount: number | string;
  description: string;
  status?: string;
  createdAt: string | Date;
  reference?: string;
};

/* ── Exhaustive, centrally-maintained credit/debit type lists ─────────────── */
const CREDIT_TYPES = new Set([
  "credit", "refund", "cashback", "referral", "bonus", "insurance",
  "simulated_topup",
]);
const DEBIT_TYPES = new Set([
  "debit", "withdrawal", "transfer", "ride", "order", "mart", "food",
  "pharmacy", "parcel",
]);

function isCreditTx(tx: WalletTx): boolean {
  if (tx.type === "deposit") {
    const status = tx.status ?? TX_STATUS_PENDING;
    return status === TX_STATUS_APPROVED || status === TX_STATUS_PENDING;
  }
  return CREDIT_TYPES.has(tx.type);
}

function isDebitTx(tx: WalletTx): boolean {
  if (tx.type === "deposit") return false;
  return DEBIT_TYPES.has(tx.type);
}

function TxItem({ tx }: { tx: WalletTx }) {
  const { symbol: currencySymbol } = useCurrency();
  const txStatus: string = tx.status ?? TX_STATUS_PENDING;
  const isManualTx = tx.type === "deposit" || tx.type === "withdrawal";
  const isPending  = isManualTx && txStatus === TX_STATUS_PENDING;
  const isApproved = isManualTx && txStatus === TX_STATUS_APPROVED;
  const isRejected = isManualTx && txStatus === TX_STATUS_REJECTED;
  const isCredit   = isCreditTx(tx);
  const date = new Date(tx.createdAt).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
  const time = new Date(tx.createdAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });

  let iconName: string;
  if (tx.type === "deposit") {
    iconName = isPending ? "time-outline" : isApproved ? "checkmark-circle" : "close-circle";
  } else if (CREDIT_TYPES.has(tx.type)) {
    iconName = "arrow-down";
  } else if (tx.type === "ride") {
    iconName = "car";
  } else if (tx.type === "order" || tx.type === "mart" || tx.type === "food") {
    iconName = "bag";
  } else if (tx.type === "pharmacy") {
    iconName = "medkit";
  } else if (tx.type === "parcel") {
    iconName = "cube";
  } else if (tx.type === "transfer" || tx.type === "debit") {
    iconName = "arrow-up";
  } else if (tx.type === "withdrawal") {
    iconName = "arrow-up";
  } else {
    iconName = isCredit ? "arrow-down" : "arrow-up";
  }

  const amtColor = isPending ? C.textMuted : isRejected ? C.amber : isCredit ? C.success : C.danger;
  const prefix   = isPending ? "" : isCredit ? "+" : "−";
  const suffix   = isPending ? " (Pending)" : isRejected ? " (Rejected)" : "";
  const bgColor  = isPending ? C.amberSoft : isRejected ? C.amberSoft : isCredit ? C.emeraldSoft : C.redSoft;
  const iconColor = isPending ? C.amber : isRejected ? C.amber : isCredit ? C.success : C.danger;

  return (
    <View style={ws.txRow} accessibilityLabel={`${tx.description}, ${prefix}${currencySymbol} ${Number(tx.amount).toLocaleString()}${suffix}, ${date}`}>
      <View style={[ws.txIcon, { backgroundColor: bgColor }]}>
        <Ionicons name={iconName as keyof typeof Ionicons.glyphMap} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={ws.txDesc} numberOfLines={1}>{tx.description}</Text>
        <Text style={ws.txDate}>{date} · {time}</Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[ws.txAmt, { color: amtColor }]}>
          {prefix}{currencySymbol} {Number(tx.amount).toLocaleString()}
        </Text>
        {suffix ? <Text style={{ fontSize: 9, color: amtColor, fontFamily: Font.medium }}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

function MethodIcon({ id, size = 24 }: { id: string; size?: number }) {
  if (id === "jazzcash") {
    return <Ionicons name="phone-portrait" size={size} color={C.crimson} />;
  }
  if (id === "easypaisa") {
    return <Ionicons name="phone-landscape" size={size} color={C.greenVivid} />;
  }
  return <Ionicons name="business" size={size} color={C.blueDeep} />;
}

function MpinInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const inputRef = useRef<TextInput>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => inputRef.current?.focus(), 300); }, []);
  return (
    <View style={{ alignItems: "center", gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "center" }}>
        {[0, 1, 2, 3].map(i => (
          <View key={i} style={{ width: 48, height: 56, borderRadius: 14, borderWidth: 2, borderColor: value.length > i ? C.primary : C.border, backgroundColor: value.length > i ? C.primarySoft : C.surfaceSecondary, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontFamily: Font.bold, fontSize: 24, color: C.text }}>{value[i] ? "●" : ""}</Text>
          </View>
        ))}
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={t => { if (/^\d{0,4}$/.test(t)) onChange(t); }}
        keyboardType="number-pad"
        maxLength={4}
        secureTextEntry
        style={{ position: "absolute", opacity: 0, height: 1, width: 1 }}
        autoFocus={autoFocus}
      />
      <TouchableOpacity activeOpacity={0.7} onPress={() => inputRef.current?.focus()} style={{ paddingVertical: 8 }}>
        <Text style={{ ...Typ.caption, color: C.primary }}>Tap to enter PIN</Text>
      </TouchableOpacity>
    </View>
  );
}

function MpinSetupModal({ token, onClose, onSuccess }: { token: string | null; onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<"create" | "confirm">("create");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToast();

  const handleCreate = () => {
    if (pin.length !== 4) { setError("Enter 4-digit MPIN"); return; }
    setError("");
    setStep("confirm");
  };

  const handleConfirm = async () => {
    if (confirmPin !== pin) { setError("PINs do not match"); setConfirmPin(""); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/wallet/pin/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ pin }),
      });
      const data = unwrapApiResponse<{ message?: string }>(await res.json());
      if (!res.ok) { setError(data.message || "Failed to create MPIN"); setLoading(false); return; }
      showToast("MPIN created successfully!", "success");
      onSuccess();
      onClose();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={ws.sheet} onPress={e => e.stopPropagation()}>
            <View style={ws.handle} />
            <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.primarySoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="shield-checkmark" size={28} color={C.primary} />
              </View>
              <Text style={{ ...Typ.title, color: C.text }}>{step === "create" ? "Create MPIN" : "Confirm MPIN"}</Text>
              <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center" }}>
                {step === "create" ? "Set a 4-digit MPIN to secure your wallet transactions" : "Re-enter your MPIN to confirm"}
              </Text>
            </View>
            {step === "create" ? (
              <>
                <MpinInput value={pin} onChange={setPin} autoFocus />
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={handleCreate} disabled={pin.length !== 4} style={[ws.actionBtn, { opacity: pin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                  <Text style={ws.actionBtnTxt}>Continue</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <MpinInput value={confirmPin} onChange={setConfirmPin} autoFocus />
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={handleConfirm} disabled={confirmPin.length !== 4 || loading} style={[ws.actionBtn, { opacity: confirmPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={ws.actionBtnTxt}>Create MPIN</Text>}
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} onPress={() => { setStep("create"); setConfirmPin(""); setError(""); }} style={{ alignItems: "center", marginTop: 12 }}>
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Go Back</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

function MpinVerifyModal({ token, onClose, onVerified }: { token: string | null; onClose: () => void; onVerified: (pinToken: string) => void }) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [lockCountdown, setLockCountdown] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!lockUntil) { setLockCountdown(""); return; }
    const tick = () => {
      const remaining = Math.max(0, lockUntil - Date.now());
      if (remaining <= 0) { setLocked(false); setLockUntil(null); setLockCountdown(""); setError(""); setAttemptsRemaining(null); return; }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setLockCountdown(`${mins}:${secs.toString().padStart(2, "0")}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lockUntil]);

  const handleVerify = async () => {
    if (pin.length !== 4 || locked) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/wallet/pin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ pin }),
      });
      const data = unwrapApiResponse<{ error?: string; message?: string; lockUntil?: string | number; lockMinutes?: number; attemptsRemaining?: number; pinToken?: string }>(await res.json());
      if (!res.ok) {
        if (data.error === "pin_locked") {
          setLocked(true);
          if (data.lockUntil) setLockUntil(new Date(data.lockUntil).getTime());
          else if (data.lockMinutes) setLockUntil(Date.now() + data.lockMinutes * 60000);
          setError(data.message || "MPIN locked. Try again later.");
        } else {
          if (typeof data.attemptsRemaining === "number") setAttemptsRemaining(data.attemptsRemaining);
          setError(data.message || "Wrong MPIN");
        }
        setPin("");
        setLoading(false);
        return;
      }
      onVerified(data.pinToken ?? "");
      onClose();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  useEffect(() => { if (pin.length === 4 && !locked) handleVerify(); }, [pin]);

  if (showForgot) {
    return <MpinForgotModal token={token} onClose={() => setShowForgot(false)} onReset={() => { setShowForgot(false); onClose(); }} />;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={ws.sheet} onPress={e => e.stopPropagation()}>
            <View style={ws.handle} />
            {locked ? (
              <View style={{ alignItems: "center", gap: 12, paddingVertical: 8 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.redSoft, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="lock-closed" size={32} color={C.danger} />
                </View>
                <Text style={{ ...Typ.title, color: C.danger }}>MPIN Locked</Text>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", lineHeight: 20 }}>
                  Too many incorrect attempts. Your MPIN has been temporarily locked.
                </Text>
                <View style={{ backgroundColor: C.redSoft, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: C.redMist }}>
                  <Text style={{ ...Typ.h3, color: C.danger, textAlign: "center" }}>
                    {lockCountdown ? `Try again in ${lockCountdown}` : error || "Please try again later."}
                  </Text>
                </View>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowForgot(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                  <Ionicons name="key-outline" size={16} color={C.primary} />
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Forgot MPIN? Reset via OTP</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="lock-closed" size={28} color={C.amber} />
                  </View>
                  <Text style={{ ...Typ.title, color: C.text }}>Enter MPIN</Text>
                  <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center" }}>Enter your 4-digit MPIN to proceed</Text>
                </View>
                <MpinInput value={pin} onChange={setPin} autoFocus />
                {!!error && (
                  <View style={{ alignItems: "center", gap: 4, marginTop: 8 }}>
                    <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center" }}>{error}</Text>
                    {attemptsRemaining !== null && (
                      <Text style={{ ...Typ.caption, color: C.amber, textAlign: "center" }}>
                        {attemptsRemaining} attempt{attemptsRemaining !== 1 ? "s" : ""} remaining before lockout
                      </Text>
                    )}
                  </View>
                )}
                {loading && <ActivityIndicator color={C.primary} style={{ marginTop: 12 }} />}
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowForgot(true)} style={{ alignItems: "center", marginTop: 20 }}>
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Forgot MPIN?</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

function MpinForgotModal({ token, onClose, onReset }: { token: string | null; onClose: () => void; onReset: () => void }) {
  const [step, setStep] = useState<"request" | "verify">("request");
  const [otp, setOtp] = useState("");
  const [newPin, setNewPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [devOtp, setDevOtp] = useState("");
  const [otpCooldown, setOtpCooldown] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    if (otpCooldown <= 0) return;
    const timer = setInterval(() => setOtpCooldown(prev => Math.max(0, prev - 1)), 1000);
    return () => clearInterval(timer);
  }, [otpCooldown]);

  const requestOtp = async () => {
    if (otpCooldown > 0) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/wallet/pin/forgot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const data = unwrapApiResponse<{ message?: string; phone?: string; _dev_otp?: string }>(await res.json());
      if (!res.ok) { setError(data.message || "Failed to send OTP"); setLoading(false); return; }
      setMaskedPhone(data.phone || "");
      if (data._dev_otp) setDevOtp(data._dev_otp);
      setOtpCooldown(60);
      setStep("verify");
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  const resetPin = async () => {
    if (otp.length < 4) { setError("Enter the OTP sent to your phone"); return; }
    if (newPin.length !== 4) { setError("Enter a 4-digit new MPIN"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/wallet/pin/reset-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ otp, newPin }),
      });
      const data = unwrapApiResponse<{ message?: string }>(await res.json());
      if (!res.ok) { setError(data.message || "Reset failed"); setLoading(false); return; }
      showToast("MPIN reset successfully!", "success");
      onReset();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={ws.sheet} onPress={e => e.stopPropagation()}>
            <View style={ws.handle} />
            <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.redSoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="key" size={28} color={C.red} />
              </View>
              <Text style={{ ...Typ.title, color: C.text }}>Reset MPIN</Text>
            </View>
            {step === "request" ? (
              <>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", marginBottom: 16 }}>
                  We'll send an OTP to your registered phone number to verify your identity.
                </Text>
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginBottom: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={requestOtp} disabled={loading} style={ws.actionBtn}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={ws.actionBtnTxt}>Send OTP</Text>}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", marginBottom: 4 }}>
                  OTP sent to {maskedPhone}
                </Text>
                {!!devOtp && (
                  <View style={{ backgroundColor: C.amberSoft, borderRadius: 8, padding: 8, marginBottom: 8 }}>
                    <Text style={{ ...Typ.captionMedium, color: C.amberDark, textAlign: "center" }}>Dev OTP: {devOtp}</Text>
                  </View>
                )}
                <TextInput value={otp} onChangeText={setOtp} placeholder="Enter OTP" keyboardType="number-pad" maxLength={6} style={[ws.input, { marginBottom: 12 }]} placeholderTextColor={C.textMuted} />
                <Text style={{ ...Typ.captionMedium, color: C.textSecondary, marginBottom: 4 }}>New MPIN</Text>
                <MpinInput value={newPin} onChange={setNewPin} />
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={resetPin} disabled={loading || otp.length < 4 || newPin.length !== 4} style={[ws.actionBtn, { opacity: otp.length < 4 || newPin.length !== 4 ? 0.5 : 1, marginTop: 16 }]}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={ws.actionBtnTxt}>Reset MPIN</Text>}
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} onPress={requestOtp} disabled={loading || otpCooldown > 0} style={{ alignItems: "center", marginTop: 12, opacity: otpCooldown > 0 ? 0.5 : 1 }}>
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>
                    {otpCooldown > 0 ? `Resend OTP in ${otpCooldown}s` : "Resend OTP"}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

function MpinChangeModal({ token, onClose, onSuccess }: { token: string | null; onClose: () => void; onSuccess: () => void }) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [step, setStep] = useState<"old" | "new" | "confirm">("old");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [lockCountdown, setLockCountdown] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [showForgot, setShowForgot] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (!lockUntil) { setLockCountdown(""); return; }
    const tick = () => {
      const remaining = Math.max(0, lockUntil - Date.now());
      if (remaining <= 0) { setLocked(false); setLockUntil(null); setLockCountdown(""); setError(""); setAttemptsRemaining(null); return; }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setLockCountdown(`${mins}:${secs.toString().padStart(2, "0")}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lockUntil]);

  const handleChange = async () => {
    if (confirmPin !== newPin) { setError("PINs do not match"); setConfirmPin(""); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/wallet/pin/change`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ oldPin, newPin }),
      });
      const data = unwrapApiResponse<{ error?: string; message?: string; lockUntil?: string | number; lockMinutes?: number; attemptsRemaining?: number }>(await res.json());
      if (!res.ok) {
        if (data.error === "pin_locked") {
          setLocked(true);
          if (data.lockUntil) setLockUntil(new Date(data.lockUntil).getTime());
          else if (data.lockMinutes) setLockUntil(Date.now() + data.lockMinutes * 60000);
          setError(data.message || "MPIN locked. Try again later.");
        } else {
          if (typeof data.attemptsRemaining === "number") setAttemptsRemaining(data.attemptsRemaining);
          setError(data.message || "Failed to change MPIN");
        }
        setLoading(false);
        return;
      }
      showToast("MPIN changed successfully!", "success");
      onSuccess();
      onClose();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  if (showForgot) {
    return <MpinForgotModal token={token} onClose={() => setShowForgot(false)} onReset={() => { setShowForgot(false); onClose(); }} />;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={ws.sheet} onPress={e => e.stopPropagation()}>
            <View style={ws.handle} />
            {locked ? (
              <View style={{ alignItems: "center", gap: 12, paddingVertical: 8 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.redSoft, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="lock-closed" size={32} color={C.danger} />
                </View>
                <Text style={{ ...Typ.title, color: C.danger }}>MPIN Locked</Text>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", lineHeight: 20 }}>
                  Too many incorrect attempts. Your MPIN has been temporarily locked.
                </Text>
                <View style={{ backgroundColor: C.redSoft, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: C.redMist }}>
                  <Text style={{ ...Typ.h3, color: C.danger, textAlign: "center" }}>
                    {lockCountdown ? `Try again in ${lockCountdown}` : error || "Please try again later."}
                  </Text>
                </View>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowForgot(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                  <Ionicons name="key-outline" size={16} color={C.primary} />
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Forgot MPIN? Reset via OTP</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.primarySoft, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="key" size={28} color={C.primary} />
                  </View>
                  <Text style={{ ...Typ.title, color: C.text }}>{step === "old" ? "Current MPIN" : step === "new" ? "New MPIN" : "Confirm New MPIN"}</Text>
                  <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center" }}>
                    {step === "old" ? "Enter your current MPIN" : step === "new" ? "Enter your new 4-digit MPIN" : "Re-enter your new MPIN to confirm"}
                  </Text>
                </View>
                {step === "old" ? (
                  <>
                    <MpinInput value={oldPin} onChange={setOldPin} autoFocus />
                    {!!error && (
                      <View style={{ alignItems: "center", gap: 4, marginTop: 8 }}>
                        <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center" }}>{error}</Text>
                        {attemptsRemaining !== null && (
                          <Text style={{ ...Typ.caption, color: C.amber, textAlign: "center" }}>
                            {attemptsRemaining} attempt{attemptsRemaining !== 1 ? "s" : ""} remaining before lockout
                          </Text>
                        )}
                      </View>
                    )}
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { if (oldPin.length === 4) { setError(""); setStep("new"); } }} disabled={oldPin.length !== 4} style={[ws.actionBtn, { opacity: oldPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      <Text style={ws.actionBtnTxt}>Continue</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setShowForgot(true)} style={{ alignItems: "center", marginTop: 12 }}>
                      <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Forgot MPIN?</Text>
                    </TouchableOpacity>
                  </>
                ) : step === "new" ? (
                  <>
                    <MpinInput value={newPin} onChange={setNewPin} autoFocus />
                    {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { if (newPin.length === 4) { setError(""); setStep("confirm"); } }} disabled={newPin.length !== 4} style={[ws.actionBtn, { opacity: newPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      <Text style={ws.actionBtnTxt}>Continue</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setStep("old"); setNewPin(""); setError(""); }} style={{ alignItems: "center", marginTop: 12 }}>
                      <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Go Back</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <MpinInput value={confirmPin} onChange={setConfirmPin} autoFocus />
                    {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                    <TouchableOpacity activeOpacity={0.7} onPress={handleChange} disabled={confirmPin.length !== 4 || loading} style={[ws.actionBtn, { opacity: confirmPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      {loading ? <ActivityIndicator color="#fff" /> : <Text style={ws.actionBtnTxt}>Change MPIN</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setStep("new"); setConfirmPin(""); setError(""); }} style={{ alignItems: "center", marginTop: 12 }}>
                      <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Go Back</Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

type WithdrawMethod = { id: string; label: string; placeholder: string };
type WithdrawStep = "method" | "details" | "confirm" | "done";

const NOTE_MAX_LENGTH = 200;

function WithdrawModal({ onClose, onSuccess, onFrozen, token, balance, minWithdrawal, pinToken }: { onClose: () => void; onSuccess: () => void; onFrozen?: () => void; token: string | null; balance: number; minWithdrawal: number; pinToken?: string | null }) {
  const { config: withdrawConfig } = usePlatformConfig();
  const withdrawalProcessingDays = withdrawConfig.customer?.withdrawalProcessingDays;
  const processingText = withdrawalProcessingDays ? `${withdrawalProcessingDays} business day(s)` : "24–48 hours";
  const { symbol: currencySymbol, code: currencyCode } = useCurrency();
  const [step, setStep]               = useState<WithdrawStep>("method");
  const [withdrawMethods, setWithdrawMethods] = useState<WithdrawMethod[]>([]);
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [methodsError, setMethodsError] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<WithdrawMethod | null>(null);
  const [amount, setAmount]           = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [note, setNote]               = useState("");
  const [submitting, setSubmitting]   = useState(false);
  const [err, setErr]                 = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const { showToast } = useToast();
  const doneAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    (async () => {
      const { randomUUID } = await import("expo-crypto");
      setIdempotencyKey(randomUUID());
    })();
  }, []);

  useEffect(() => {
    if (step === "done") {
      doneAnim.setValue(0);
      Animated.timing(doneAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    }
  }, [step]);

  useEffect(() => {
    fetch(`${API}/wallet/withdrawal-methods`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.json())
      .then(unwrapApiResponse)
      .then((data: { methods?: WithdrawMethod[] }) => {
        if (!data.methods || data.methods.length === 0) setMethodsError(true);
        else setWithdrawMethods(data.methods);
      })
      .catch(() => setMethodsError(true))
      .finally(() => setLoadingMethods(false));
  }, []);

  const goToConfirm = () => {
    const amt = parseFloat(amount);
    if (!amount || !isFinite(amt) || isNaN(amt) || amt <= 0) { setErr("Please enter a valid amount"); return; }
    if (amt < (minWithdrawal ?? 0))                          { setErr(`Minimum withdrawal amount is ${currencySymbol} ${(minWithdrawal ?? 0).toLocaleString()}`); return; }
    if (amt > balance)                                        { setErr(`Insufficient balance. Available: ${currencySymbol} ${balance.toLocaleString()}`); return; }
    if (!accountNumber.trim())                                { setErr("Account number is required"); return; }
    setErr("");
    setStep("confirm");
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErr("");
    try {
      const amt = parseFloat(amount);
      const res = await fetch(`${API}/wallet/withdraw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(pinToken ? { "x-wallet-pin-token": pinToken } : {}),
        },
        body: JSON.stringify({ amount: amt, paymentMethod: selectedMethod?.id, accountNumber: accountNumber.trim(), note: note.trim() || undefined }),
      });
      const data = unwrapApiResponse<{ error?: string; message?: string }>(await res.json());
      if (!res.ok) {
        if (data.error === "wallet_frozen") {
          setErr("Your wallet has been temporarily frozen. Please contact support.");
          setSubmitting(false);
          return;
        }
        setErr(data.error || data.message || "Request failed");
        setSubmitting(false); return;
      }
      setStep("done");
      onSuccess();
    } catch {
      setErr("Network error. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={0.7} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }} keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}>
        <TouchableOpacity activeOpacity={0.7} style={[ws.sheet, { maxHeight: "90%" }]} onPress={e => e.stopPropagation()}>
          <View style={ws.handle} />
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">

              {step === "done" && (
                <Animated.View style={{ alignItems: "center", paddingVertical: 20, opacity: doneAnim, transform: [{ translateY: doneAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }}>
                  <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.redSoft, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                    <Ionicons name="arrow-up-circle" size={40} color={C.danger} />
                  </View>
                  <Text style={{ ...Typ.title, color: C.text, marginBottom: 8 }}>Request Submitted!</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, textAlign: "center", lineHeight: 20, maxWidth: 280 }}>Your withdrawal will be processed within {processingText}.</Text>
                  <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 16, padding: 16, width: "100%", marginTop: 20, gap: 10, borderWidth: 1, borderColor: C.border }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Method</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{selectedMethod?.label}</Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Account</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{accountNumber}</Text>
                    </View>
                    <View style={{ height: 1, backgroundColor: C.border }} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Amount</Text>
                      <Text style={{ ...Typ.h2, color: C.danger }}>{currencySymbol} {parseFloat(amount).toLocaleString()}</Text>
                    </View>
                  </View>
                  <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={[ws.actionBtn, { backgroundColor: C.primary, marginTop: 16, width: "100%" }]} accessibilityRole="button" accessibilityLabel="Done">
                    <Text style={ws.actionBtnTxt}>Done</Text>
                  </TouchableOpacity>
                </Animated.View>
              )}

              {step === "method" && (
                <View>
                  <Text style={ws.sheetTitle}>Withdraw Money</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 18 }}>Choose your withdrawal method</Text>
                  {loadingMethods ? (
                    <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
                  ) : methodsError || withdrawMethods.length === 0 ? (
                    <View style={{ backgroundColor: C.redBg, borderRadius: 16, padding: 24, alignItems: "center", gap: 10, borderWidth: 1, borderColor: C.redSoft }}>
                      <Ionicons name="alert-circle-outline" size={28} color={C.danger} />
                      <Text style={{ ...Typ.button, fontFamily: Font.bold, color: C.text }}>Withdrawal Not Available</Text>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted, textAlign: "center" }}>No withdrawal methods are currently enabled. Please contact support.</Text>
                    </View>
                  ) : (
                  <View style={{ gap: 10 }}>
                    {withdrawMethods.map(m => (
                      <TouchableOpacity activeOpacity={0.7} key={m.id} onPress={() => { setSelectedMethod(m); setErr(""); setStep("details"); }} style={{ flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.border, borderRadius: 16, padding: 16, backgroundColor: C.surface }} accessibilityRole="button" accessibilityLabel={`Withdraw via ${m.label}`}>
                        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center" }}>
                          <MethodIcon id={m.id} size={26} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ ...Typ.button, fontFamily: Font.bold, color: C.text }}>{m.label}</Text>
                          <Text style={{ ...Typ.caption, color: C.textMuted, marginTop: 2 }}>Withdraw to your {m.label} account</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
                      </TouchableOpacity>
                    ))}
                  </View>
                  )}
                </View>
              )}

              {step === "details" && selectedMethod && (
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 18 }}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setStep("method")} style={{ marginRight: 10, padding: 4 }} accessibilityRole="button" accessibilityLabel="Go back to method selection">
                      <Ionicons name="arrow-back" size={20} color={C.text} />
                    </TouchableOpacity>
                    <Text style={[ws.sheetTitle, { marginBottom: 0 }]}>{selectedMethod.label} Withdrawal</Text>
                  </View>

                  <Text style={ws.sheetLbl}>Amount ({currencyCode}) *</Text>
                  <View style={ws.amtWrap}>
                    <Text style={ws.rupee}>{currencySymbol}</Text>
                    <TextInput
                      style={ws.amtInput}
                      value={amount}
                      onChangeText={t => { setAmount(t.replace(/[^0-9]/g, "")); setErr(""); }}
                      keyboardType="numeric"
                      placeholder="0"
                      placeholderTextColor={C.textMuted}
                    />
                  </View>
                  <View style={ws.quickRow}>
                    {QUICK_AMOUNTS.map(a => (
                      <TouchableOpacity activeOpacity={0.7} key={a} onPress={() => setAmount(a.toString())} style={[ws.quickBtn, amount === a.toString() && ws.quickBtnActive]} accessibilityRole="button" accessibilityLabel={`${currencySymbol} ${a.toLocaleString()}`} accessibilityState={{ selected: amount === a.toString() }}>
                        <Text style={[ws.quickTxt, amount === a.toString() && ws.quickTxtActive]}>{currencySymbol} {a.toLocaleString()}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 14, backgroundColor: C.amberSoft, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: C.amberBorder }}>
                    <Ionicons name="wallet-outline" size={14} color={C.amber} />
                    <Text style={{ ...Typ.caption, color: C.amberDark, flex: 1 }}>Available: {currencySymbol} {balance.toLocaleString()}</Text>
                  </View>

                  <Text style={ws.sheetLbl}>Your {selectedMethod.label} Account *</Text>
                  <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                    <TextInput
                      value={accountNumber}
                      onChangeText={v => { setAccountNumber(v); setErr(""); }}
                      placeholder={selectedMethod.placeholder}
                      placeholderTextColor={C.textMuted}
                      style={[ws.sendInput, { paddingVertical: 0 }]}
                      autoCapitalize="characters"
                    />
                  </View>

                  <Text style={ws.sheetLbl}>Note (Optional)</Text>
                  <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                    <TextInput
                      value={note}
                      onChangeText={setNote}
                      placeholder="Any additional info..."
                      placeholderTextColor={C.textMuted}
                      style={[ws.sendInput, { paddingVertical: 0 }]}
                      maxLength={NOTE_MAX_LENGTH}
                    />
                  </View>
                  <Text style={{ ...Typ.small, color: C.textMuted, textAlign: "right", marginTop: 2, marginBottom: 8 }}>{note.length}/{NOTE_MAX_LENGTH}</Text>

                  {err ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, backgroundColor: C.redBg, padding: 10, borderRadius: 10 }}>
                      <Ionicons name="alert-circle-outline" size={14} color={C.danger} />
                      <Text style={{ ...Typ.caption, color: C.danger, flex: 1 }}>{err}</Text>
                    </View>
                  ) : null}

                  <TouchableOpacity activeOpacity={0.7} onPress={goToConfirm} style={[ws.actionBtn, { backgroundColor: C.danger }]} accessibilityRole="button" accessibilityLabel="Review withdrawal request">
                    <Ionicons name="arrow-forward" size={18} color={C.textInverse} />
                    <Text style={ws.actionBtnTxt}>Review Withdrawal</Text>
                  </TouchableOpacity>
                </View>
              )}

              {step === "confirm" && selectedMethod && (
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 18 }}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setStep("details")} style={{ marginRight: 10, padding: 4 }} accessibilityRole="button" accessibilityLabel="Go back to details">
                      <Ionicons name="arrow-back" size={20} color={C.text} />
                    </TouchableOpacity>
                    <Text style={[ws.sheetTitle, { marginBottom: 0 }]}>Confirm Withdrawal</Text>
                  </View>

                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 18 }}>Review your withdrawal details before submitting</Text>

                  <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 16, padding: 16, gap: 10, marginBottom: 14, borderWidth: 1, borderColor: C.border }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Method</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{selectedMethod.label}</Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>{selectedMethod.id === "bank" ? "IBAN / Account" : "Account Number"}</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text, maxWidth: "60%" }} numberOfLines={2}>{accountNumber}</Text>
                    </View>
                    {note ? (
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Note</Text>
                        <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{note}</Text>
                      </View>
                    ) : null}
                    <View style={{ height: 1, backgroundColor: C.border, marginVertical: 4 }} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ ...Typ.buttonSmall, color: C.textMuted }}>Amount</Text>
                      <Text style={{ ...Typ.h2, fontSize: 24, color: C.danger }}>{currencySymbol} {parseFloat(amount).toLocaleString()}</Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.amberSoft, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: C.amberBorder }}>
                    <Ionicons name="information-circle-outline" size={16} color={C.amber} />
                    <Text style={{ ...Typ.caption, color: C.amberDark, flex: 1 }}>Once submitted, this request cannot be cancelled. Make sure account details are correct. Withdrawals are processed within {processingText} by admin.</Text>
                  </View>

                  {err ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, backgroundColor: C.redBg, padding: 10, borderRadius: 10 }}>
                      <Ionicons name="alert-circle-outline" size={14} color={C.danger} />
                      <Text style={{ ...Typ.caption, color: C.danger, flex: 1 }}>{err}</Text>
                    </View>
                  ) : null}

                  <TouchableOpacity activeOpacity={0.7} onPress={handleSubmit} disabled={submitting || !idempotencyKey} style={[ws.actionBtn, { backgroundColor: C.danger }, (submitting || !idempotencyKey) && { opacity: 0.6 }]} accessibilityRole="button" accessibilityLabel="Confirm and submit withdrawal request" accessibilityState={{ disabled: submitting || !idempotencyKey }}>
                    {submitting ? <ActivityIndicator color={C.textInverse} /> : (
                      <>
                        <Ionicons name="arrow-up-outline" size={18} color={C.textInverse} />
                        <Text style={ws.actionBtnTxt}>Confirm & Submit</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

const SUBMITTED_TX_KEY = "wallet_submitted_tx_ids";

/* In-memory fallback for submitted TxIDs when AsyncStorage is unavailable */
let inMemorySubmittedTxIds: Set<string> = new Set();

function DepositModal({ onClose, onSuccess, onFrozen, token, minTopup, maxTopup }: { onClose: () => void; onSuccess: () => void; onFrozen?: () => void; token: string | null; minTopup: number; maxTopup: number }) {
  const { symbol: currencySymbol, code: currencyCode } = useCurrency();
  const { config: platformCfg } = usePlatformConfig();
  const withdrawalProcessingDays = platformCfg.customer.withdrawalProcessingDays;
  const processingTimeText = withdrawalProcessingDays
    ? `${withdrawalProcessingDays} business day${withdrawalProcessingDays !== 1 ? "s" : ""}`
    : "24–48 hours";
  const [step, setStep]               = useState<DepositStep>("method");
  const [methods, setMethods]         = useState<PayMethod[]>([]);
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [methodsError, setMethodsError]     = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<PayMethod | null>(null);
  const [amount, setAmount]           = useState("");
  const [txId, setTxId]               = useState("");
  const [senderAcNo, setSenderAcNo]   = useState("");
  const [note, setNote]               = useState("");
  const [submitting, setSubmitting]   = useState(false);
  const [submittedTxIds, setSubmittedTxIds] = useState<Set<string>>(new Set(inMemorySubmittedTxIds));
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [err, setErr]                 = useState("");
  const { showToast } = useToast();

  /* Load previously submitted TxIDs from AsyncStorage on mount */
  useEffect(() => {
    AsyncStorage.getItem(SUBMITTED_TX_KEY)
      .then(raw => {
        if (raw) {
          let ids: string[];
          try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every(v => typeof v === "string")) {
              ids = parsed;
            } else {
              AsyncStorage.removeItem(SUBMITTED_TX_KEY).catch(() => {});
              ids = [];
            }
          } catch {
            AsyncStorage.removeItem(SUBMITTED_TX_KEY).catch(() => {});
            ids = [];
          }
          const merged = new Set([...inMemorySubmittedTxIds, ...ids]);
          setSubmittedTxIds(merged);
          inMemorySubmittedTxIds = merged;
        }
      })
      .catch((storageErr) => {
        /* AsyncStorage failed — use in-memory set; warn but do not block */
        if (__DEV__) console.warn("[Wallet] AsyncStorage read failed, using in-memory fallback:", storageErr instanceof Error ? storageErr.message : String(storageErr));
        showToast("Storage warning: duplicate-submission guard using session memory only.", "warning");
      });
  }, []);

  useEffect(() => {
    (async () => {
      const { randomUUID } = await import("expo-crypto");
      setIdempotencyKey(randomUUID());
    })();
  }, []);

  useEffect(() => {
    fetch(`${API}/wallet/deposit-methods`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then(unwrapApiResponse)
      .then((data: { methods?: PayMethod[] }) => {
        const methods: PayMethod[] = data.methods || [];
        if (methods.length === 0) setMethodsError(true);
        else setMethods(methods);
      })
      .catch(() => setMethodsError(true))
      .finally(() => setLoadingMethods(false));
  }, [token]);

  const STEPS: DepositStep[] = ["method", "details", "amount", "confirm"];
  const stepIdx = STEPS.indexOf(step);

  const selectMethod = (m: PayMethod) => {
    setSelectedMethod(m);
    setErr("");
    setStep("details");
  };

  const goToAmount = () => {
    setErr("");
    setStep("amount");
  };

  const safeMinTopup = minTopup || 100;
  const safeMaxTopup = maxTopup || 100000;

  const goToConfirm = () => {
    const amt = parseFloat(amount);
    if (!amount || !isFinite(amt) || isNaN(amt) || amt <= 0) { setErr("Please enter a valid amount"); return; }
    if (amt < safeMinTopup)  { setErr(`Minimum deposit amount is ${currencySymbol} ${safeMinTopup.toLocaleString()}`); return; }
    if (amt > safeMaxTopup) { setErr(`Maximum deposit amount is ${currencySymbol} ${safeMaxTopup.toLocaleString()}`); return; }
    if (!txId.trim()) { setErr("Transaction ID is required"); return; }
    setErr("");
    setStep("confirm");
  };

  const handleSubmit = async () => {
    /* Lock immediately — must be the very first check before any async work */
    if (submitting) return;
    setSubmitting(true);
    setErr("");

    if (!selectedMethod) { setErr("No payment method selected"); setSubmitting(false); return; }
    const normalizedTxId = txId.trim();
    if (submittedTxIds.has(normalizedTxId)) {
      setErr("This transaction ID has already been submitted. Please check your wallet history.");
      setSubmitting(false);
      return;
    }
    if (!idempotencyKey) { setSubmitting(false); return; }

    try {
      const res = await fetch(`${API}/wallet/deposit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount: parseFloat(amount),
          paymentMethod: selectedMethod.id,
          transactionId: normalizedTxId,
          idempotencyKey,
          accountNumber: senderAcNo.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = unwrapApiResponse<{ error?: string; message?: string }>(await res.json());
      if (!res.ok && res.status !== 202) {
        if (data.error === "wallet_frozen") {
          setErr("Your wallet has been temporarily frozen. Please contact support.");
          setSubmitting(false); return;
        }
        setErr(data.error || data.message || "Request failed");
        setSubmitting(false); return;
      }
      /* Persist the TxID to prevent future duplicate submissions */
      const newSet = new Set(submittedTxIds).add(normalizedTxId);
      setSubmittedTxIds(newSet);
      inMemorySubmittedTxIds = newSet;

      AsyncStorage.getItem(SUBMITTED_TX_KEY)
        .then(raw => {
          const existing: string[] = raw ? JSON.parse(raw) : [];
          const merged = Array.from(new Set([...existing, normalizedTxId])).slice(-100);
          return AsyncStorage.setItem(SUBMITTED_TX_KEY, JSON.stringify(merged));
        })
        .catch((storageErr) => {
          if (__DEV__) console.warn("[Wallet] AsyncStorage write failed, in-memory fallback active:", storageErr instanceof Error ? storageErr.message : String(storageErr));
          /* Non-blocking: show a brief warning so user knows the duplicate-submission guard
             is session-only (in-memory set already holds the TxID). */
          showToast("Note: Duplicate-submission guard is active only for this session (storage unavailable).", "warning");
        });


      setStep("done");
      onSuccess();
    } catch {
      setErr("Network error. Please try again.");
    }
    setSubmitting(false);
  };

  const copyToClipboard = (text: string) => {
    Clipboard.setStringAsync(text);
    showToast("Copied!", "success");
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={0.7} style={ws.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }} keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}>
        <TouchableOpacity activeOpacity={0.7} style={[ws.sheet, { maxHeight: "90%" }]} onPress={e => e.stopPropagation()}>
          <View style={ws.handle} />

          {step !== "done" && stepIdx >= 0 && (
            <View style={{ marginBottom: 18 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {STEPS.map((_, i) => (
                  <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= stepIdx ? C.primary : C.border }} />
                ))}
              </View>
              <Text style={{ ...Typ.small, color: C.textMuted, textAlign: "right", marginTop: 6 }}>Step {stepIdx + 1} of {STEPS.length}</Text>
            </View>
          )}

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">

              {step === "done" && (
                <View style={{ alignItems: "center", paddingVertical: 20 }}>
                  <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.emeraldSoft, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                    <Ionicons name="checkmark-circle" size={40} color={C.success} />
                  </View>
                  <Text style={{ ...Typ.title, color: C.text, marginBottom: 8 }}>Request Submitted!</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, textAlign: "center", lineHeight: 20, maxWidth: 280 }}>Our team will review your transaction and credit your wallet after approval — usually within {processingTimeText}.</Text>
                  <View style={{ backgroundColor: C.blueSoft, borderRadius: 12, padding: 12, marginTop: 12, borderWidth: 1, borderColor: C.brandBlueSoft, flexDirection: "row", alignItems: "flex-start", gap: 8, width: "100%" }}>
                    <Ionicons name="information-circle-outline" size={16} color={C.primary} style={{ marginTop: 1 }} />
                    <Text style={{ ...Typ.caption, color: C.textSecondary, flex: 1, lineHeight: 16 }}>This is a manual review process. Funds are NOT instant — an admin must verify and approve your Transaction ID first.</Text>
                  </View>
                  <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 16, padding: 16, width: "100%", marginTop: 20, gap: 10, borderWidth: 1, borderColor: C.border }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Method</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{selectedMethod?.label}</Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Transaction ID</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{txId}</Text>
                    </View>
                    <View style={{ height: 1, backgroundColor: C.border }} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Amount</Text>
                      <Text style={{ ...Typ.h2, color: C.success }}>{currencySymbol} {parseFloat(amount).toLocaleString()}</Text>
                    </View>
                  </View>
                  <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={[ws.actionBtn, { backgroundColor: C.primary, marginTop: 16, width: "100%" }]} accessibilityRole="button" accessibilityLabel="Done">
                    <Text style={ws.actionBtnTxt}>Done</Text>
                  </TouchableOpacity>
                </View>
              )}

              {step === "method" && (
                <View>
                  <Text style={ws.sheetTitle}>Add Money</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 12 }}>Choose how you'd like to deposit</Text>
                  <View style={{ backgroundColor: C.amberSoft, borderRadius: 12, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: C.amberBorder, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                    <Ionicons name="time-outline" size={15} color={C.amber} style={{ marginTop: 1 }} />
                    <Text style={{ ...Typ.caption, color: C.amberDark, flex: 1, lineHeight: 15 }}>
                      Top-ups require manual review. Your Transaction ID will be verified by our team before funds are credited — usually within <Text style={{ fontFamily: Font.bold }}>{processingTimeText}</Text>.
                    </Text>
                  </View>
                  {loadingMethods ? (
                    <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
                  ) : methodsError ? (
                    <View style={{ backgroundColor: C.redBg, borderRadius: 16, padding: 24, alignItems: "center", gap: 10, borderWidth: 1, borderColor: C.redSoft }}>
                      <Ionicons name="alert-circle-outline" size={28} color={C.danger} />
                      <Text style={{ ...Typ.button, fontFamily: Font.bold, color: C.text }}>Deposit Not Available</Text>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted, textAlign: "center" }}>JazzCash, EasyPaisa, and Bank Transfer are not yet enabled. Please contact support to add funds.</Text>
                      <TouchableOpacity activeOpacity={0.7} onPress={() => {
                        setMethodsError(false);
                        setLoadingMethods(true);
                        fetch(`${API}/wallet/deposit-methods`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
                          .then(r => r.json())
                          .then(unwrapApiResponse)
                          .then((data: { methods?: PayMethod[] }) => {
                            const methods: PayMethod[] = data.methods || [];
                            if (methods.length === 0) setMethodsError(true);
                            else setMethods(methods);
                          })
                          .catch(() => setMethodsError(true))
                          .finally(() => setLoadingMethods(false));
                      }} style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 }} accessibilityRole="button" accessibilityLabel="Try again to load payment methods">
                        <Ionicons name="refresh-outline" size={15} color={C.textInverse} />
                        <Text style={{ ...Typ.buttonSmall, color: C.textInverse }}>Try Again</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={{ gap: 10 }}>
                      {methods.map(m => (
                        <TouchableOpacity activeOpacity={0.7} key={m.id} onPress={() => selectMethod(m)} style={{ flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1.5, borderColor: C.border, borderRadius: 16, padding: 16, backgroundColor: C.surface }} accessibilityRole="button" accessibilityLabel={`Deposit via ${m.label}`}>
                          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center" }}>
                            <MethodIcon id={m.id} size={26} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ ...Typ.button, fontFamily: Font.bold, color: C.text }}>{m.label}</Text>
                            <Text style={{ ...Typ.caption, color: C.textMuted, marginTop: 2 }}>{m.description || `Deposit via ${m.label}`}</Text>
                            {m.manualNumber && <Text style={{ ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.primary, marginTop: 3 }}>{m.manualNumber}</Text>}
                          </View>
                          <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {step === "details" && selectedMethod && (
                <View>
                  <Text style={ws.sheetTitle}>{selectedMethod.label}</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 18 }}>Send payment to the account below</Text>

                  <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 16, padding: 4, marginBottom: 14, borderWidth: 1, borderColor: C.border }}>
                    {selectedMethod.manualNumber && (
                      <TouchableOpacity activeOpacity={0.7} onPress={() => copyToClipboard(selectedMethod.manualNumber!)} style={{ flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderBottomColor: C.border }} accessibilityRole="button" accessibilityLabel={`Copy account number ${selectedMethod.manualNumber}`}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ ...Typ.small, color: C.textMuted }}>Account Number</Text>
                          <Text style={{ ...Typ.button, fontFamily: Font.bold, color: C.text, marginTop: 2 }}>{selectedMethod.manualNumber}</Text>
                        </View>
                        <Ionicons name="copy-outline" size={18} color={C.primary} />
                      </TouchableOpacity>
                    )}
                    {selectedMethod.manualName && (
                      <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: C.border }}>
                        <Text style={{ ...Typ.small, color: C.textMuted }}>Account Title</Text>
                        <Text style={{ ...Typ.bodyMedium, color: C.text, marginTop: 2 }}>{selectedMethod.manualName}</Text>
                      </View>
                    )}
                    {selectedMethod.iban && (
                      <TouchableOpacity activeOpacity={0.7} onPress={() => copyToClipboard(selectedMethod.iban!)} style={{ flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderBottomColor: C.border }} accessibilityRole="button" accessibilityLabel="Copy IBAN">
                        <View style={{ flex: 1 }}>
                          <Text style={{ ...Typ.small, color: C.textMuted }}>IBAN</Text>
                          <Text style={{ ...Typ.captionMedium, color: C.text, marginTop: 2 }}>{selectedMethod.iban}</Text>
                        </View>
                        <Ionicons name="copy-outline" size={18} color={C.primary} />
                      </TouchableOpacity>
                    )}
                    {selectedMethod.bankName && (
                      <View style={{ padding: 14, borderBottomWidth: selectedMethod.manualInstructions ? 1 : 0, borderBottomColor: C.border }}>
                        <Text style={{ ...Typ.small, color: C.textMuted }}>Bank</Text>
                        <Text style={{ ...Typ.bodyMedium, color: C.text, marginTop: 2 }}>{selectedMethod.bankName}</Text>
                      </View>
                    )}
                    {selectedMethod.manualInstructions && (
                      <View style={{ padding: 14 }}>
                        <Text style={{ ...Typ.caption, color: C.textSecondary }}>{selectedMethod.manualInstructions}</Text>
                      </View>
                    )}
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.blueSoft, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: C.brandBlueSoft }}>
                    <Ionicons name="information-circle-outline" size={16} color={C.primary} />
                    <Text style={{ ...Typ.caption, color: C.textSecondary, flex: 1 }}>After payment, enter the Transaction ID in the next step</Text>
                  </View>

                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setStep("method")} style={[ws.actionBtn, { flex: 1, backgroundColor: C.surfaceSecondary }]} accessibilityRole="button" accessibilityLabel="Back">
                      <Text style={[ws.actionBtnTxt, { color: C.text }]}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={goToAmount} style={[ws.actionBtn, { flex: 2, backgroundColor: C.primary }]} accessibilityRole="button" accessibilityLabel="Payment done, continue">
                      <Ionicons name="checkmark-circle-outline" size={18} color={C.textInverse} />
                      <Text style={ws.actionBtnTxt}>Payment Done</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {step === "amount" && selectedMethod && (
                <View>
                  <Text style={ws.sheetTitle}>Transaction Details</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 18 }}>Enter your payment details</Text>

                  <Text style={ws.sheetLbl}>Amount ({currencyCode}) *</Text>
                  <View style={ws.amtWrap}>
                    <Text style={ws.rupee}>{currencySymbol}</Text>
                    <TextInput
                      style={ws.amtInput}
                      value={amount}
                      onChangeText={t => setAmount(t.replace(/[^0-9]/g, ""))}
                      keyboardType="numeric"
                      placeholder="0"
                      placeholderTextColor={C.textMuted}
                    />
                  </View>
                  <Text style={{ ...Typ.caption, color: C.textMuted, marginTop: 4, marginBottom: 4 }}>
                    {minTopup && maxTopup
                      ? `Limits: ${currencySymbol} ${safeMinTopup.toLocaleString()} – ${currencySymbol} ${safeMaxTopup.toLocaleString()}`
                      : "Loading limits…"}
                  </Text>
                  <View style={ws.quickRow}>
                    {QUICK_AMOUNTS.map(a => (
                      <TouchableOpacity activeOpacity={0.7} key={a} onPress={() => setAmount(a.toString())} style={[ws.quickBtn, amount === a.toString() && ws.quickBtnActive]} accessibilityRole="button" accessibilityLabel={`${currencySymbol} ${a.toLocaleString()}`} accessibilityState={{ selected: amount === a.toString() }}>
                        <Text style={[ws.quickTxt, amount === a.toString() && ws.quickTxtActive]}>{currencySymbol} {a.toLocaleString()}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={ws.sheetLbl}>Transaction ID *</Text>
                  <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                    <TextInput
                      value={txId}
                      onChangeText={setTxId}
                      placeholder="e.g. T12345678"
                      placeholderTextColor={C.textMuted}
                      style={[ws.sendInput, { paddingVertical: 0 }]}
                      maxLength={100}
                    />
                  </View>

                  <Text style={ws.sheetLbl}>Your Account / Phone (Optional)</Text>
                  <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                    <TextInput
                      value={senderAcNo}
                      onChangeText={setSenderAcNo}
                      placeholder={selectedMethod.id === "bank" ? "Your IBAN" : "03XX-XXXXXXX"}
                      placeholderTextColor={C.textMuted}
                      style={[ws.sendInput, { paddingVertical: 0 }]}
                      maxLength={50}
                    />
                  </View>

                  <Text style={ws.sheetLbl}>Note (Optional)</Text>
                  <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                    <TextInput
                      value={note}
                      onChangeText={setNote}
                      placeholder="Any additional info..."
                      placeholderTextColor={C.textMuted}
                      style={[ws.sendInput, { paddingVertical: 0 }]}
                      maxLength={NOTE_MAX_LENGTH}
                    />
                  </View>
                  <Text style={{ ...Typ.small, color: C.textMuted, textAlign: "right", marginTop: 2, marginBottom: 8 }}>{note.length}/{NOTE_MAX_LENGTH}</Text>

                  {err ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, backgroundColor: C.redBg, padding: 10, borderRadius: 10 }}>
                      <Ionicons name="alert-circle-outline" size={14} color={C.danger} />
                      <Text style={{ ...Typ.caption, color: C.danger, flex: 1 }}>{err}</Text>
                    </View>
                  ) : null}

                  <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setStep("details")} style={[ws.actionBtn, { flex: 1, backgroundColor: C.surfaceSecondary }]} accessibilityRole="button" accessibilityLabel="Back">
                      <Text style={[ws.actionBtnTxt, { color: C.text }]}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={goToConfirm} style={[ws.actionBtn, { flex: 2, backgroundColor: C.primary }]} accessibilityRole="button" accessibilityLabel="Review deposit">
                      <Text style={ws.actionBtnTxt}>Review</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {step === "confirm" && selectedMethod && (
                <View>
                  <Text style={ws.sheetTitle}>Confirm Request</Text>
                  <Text style={{ ...Typ.body, color: C.textMuted, marginBottom: 18 }}>Review before submitting</Text>

                  <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 16, padding: 16, gap: 10, marginBottom: 14, borderWidth: 1, borderColor: C.border }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Method</Text>
                      <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{selectedMethod.label}</Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Transaction ID</Text>
                      <Text style={{ ...Typ.buttonSmall, fontFamily: Font.bold, color: C.text, fontVariant: ["tabular-nums"] }}>{txId}</Text>
                    </View>
                    {senderAcNo ? (
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Sender</Text>
                        <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{senderAcNo}</Text>
                      </View>
                    ) : null}
                    {note ? (
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Note</Text>
                        <Text style={{ ...Typ.bodyMedium, fontSize: 13, color: C.text }}>{note}</Text>
                      </View>
                    ) : null}
                    <View style={{ height: 1, backgroundColor: C.border, marginVertical: 4 }} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ ...Typ.buttonSmall, color: C.textMuted }}>Amount</Text>
                      <Text style={{ ...Typ.h2, fontSize: 24, color: C.success }}>{currencySymbol} {parseFloat(amount).toLocaleString()}</Text>
                    </View>
                  </View>

                  <View style={{ backgroundColor: C.blueSoft, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: C.brandBlueSoft, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                    <Ionicons name="time-outline" size={16} color={C.primary} style={{ marginTop: 1 }} />
                    <Text style={{ ...Typ.caption, color: C.textSecondary, flex: 1, lineHeight: 16 }}>
                      Your request will be reviewed by our team. Funds appear in your wallet after approval — usually within <Text style={{ fontFamily: Font.bold, color: C.primary }}>{processingTimeText}</Text>.
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.amberSoft, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: C.amberBorder }}>
                    <Ionicons name="alert-circle-outline" size={16} color={C.amber} />
                    <Text style={{ ...Typ.caption, color: C.amberDark, flex: 1 }}>An incorrect TxID may cause rejection. Enter the real transaction ID.</Text>
                  </View>

                  {err ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, backgroundColor: C.redBg, padding: 10, borderRadius: 10 }}>
                      <Ionicons name="alert-circle-outline" size={14} color={C.danger} />
                      <Text style={{ ...Typ.caption, color: C.danger, flex: 1 }}>{err}</Text>
                    </View>
                  ) : null}

                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setStep("amount"); setErr(""); }} style={[ws.actionBtn, { flex: 1, backgroundColor: C.surfaceSecondary }]} accessibilityRole="button" accessibilityLabel="Edit deposit details">
                      <Text style={[ws.actionBtnTxt, { color: C.text }]}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={handleSubmit} disabled={submitting} style={[ws.actionBtn, { flex: 2, backgroundColor: C.primary, opacity: submitting ? 0.6 : 1 }]} accessibilityRole="button" accessibilityLabel="Submit deposit request" accessibilityState={{ disabled: submitting }}>
                      {submitting ? (
                        <ActivityIndicator color={C.textInverse} />
                      ) : (
                        <>
                          <Ionicons name="checkmark-circle-outline" size={18} color={C.textInverse} />
                          <Text style={ws.actionBtnTxt}>Submit Request</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              )}

            </ScrollView>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </TouchableOpacity>
    </Modal>
  );
}

function WalletScreenInner() {
  const insets = useSafeAreaInsets();
  const { user, updateUser, token, socket } = useAuth();
  const { showToast } = useToast();
  const { language } = useLanguage();
  const T = (key: Parameters<typeof tDual>[0]) => tDual(key, language);
  const qc = useQueryClient();
  /* Fix: use insets.top for all platforms to account for notch/status bar */
  const topPad = Platform.OS === "web" ? 67 : (insets.top > 0 ? insets.top : 44);
  const TAB_H  = Platform.OS === "web" ? 84 : 49;
  const { searchOpacity: actionsOpacity, searchMaxHeight: actionsMaxHeight, subtitleOpacity: balanceLabelOpacity, subtitleMaxHeight: balanceLabelMaxHeight, scrollHandler: walletScrollHandler, scrollEventThrottle: walletScrollThrottle } = useCollapsibleHeader({ expandedHeight: 200, collapsedHeight: 80, scrollThreshold: 100, searchBarHeight: 70 });

  const [showDeposit,  setShowDeposit]  = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showSend,     setShowSend]     = useState(false);
  const [showQR,       setShowQR]       = useState(false);
  const [lastRefreshed,  setLastRefreshed]  = useState<Date | null>(null);
  const [txFilter,    setTxFilter]    = useState<TxFilter>("all");

  const [walletHidden, setWalletHidden] = useState(false);
  const [pinSetup, setPinSetup] = useState(false);
  const [showMpinSetup, setShowMpinSetup] = useState(false);
  const [showMpinChange, setShowMpinChange] = useState(false);
  const [showMpinVerify, setShowMpinVerify] = useState(false);
  const [pendingPinAction, setPendingPinAction] = useState<"send" | "withdraw" | null>(null);
  const [activePinToken, setActivePinToken] = useState<string | null>(null);
  const mpinSetupSucceededRef = useRef(false);

  const [sendPhone,   setSendPhone]   = useState("");
  const [sendAmount,  setSendAmount]  = useState("");
  const [sendNote,    setSendNote]    = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendStep,    setSendStep]    = useState<"input" | "confirm">("input");
  const [sendPhoneError, setSendPhoneError] = useState("");
  const [sendReceiverName, setSendReceiverName] = useState("");
  const [sendNetworkError, setSendNetworkError] = useState(false);
  const [sendMode, setSendMode] = useState<"phone" | "ajkid">("phone");

  const [pendingTopups,  setPendingTopups]  = useState<{ count: number; total: number }>({ count: 0, total: 0 });

  const { config: platformConfig } = usePlatformConfig();
  const { symbol: currencySymbol, code: currencyCode } = useCurrency();
  const appName     = platformConfig.platform.appName;
  const minTransfer = platformConfig.customer.minTransfer;
  const p2pEnabled  = platformConfig.customer.p2pEnabled;
  const p2pFee      = platformConfig.customer.p2pFeePct ?? 0;

  const [walletFrozen, setWalletFrozen] = useState(false);
  const [socketBalance, setSocketBalance] = useState<number | null>(null);
  const prevUserBalanceRef = useRef<number | undefined>(user?.walletBalance);

  const { data: rawData, isLoading, isFetching, isError: walletError, error: walletErrorObj, refetch } = useGetWallet(
    { userId: user?.id || "" },
    { query: { queryKey: ["wallet", user?.id] as const, enabled: !!user?.id, retry: 2, retryDelay: (attempt: number) => Math.floor(1500 * Math.pow(1.5, attempt - 1)) } }
  );
  const data = rawData as (typeof rawData & { pinSetup?: boolean; walletHidden?: boolean }) | undefined;

  const walletQueryKey = getGetWalletQueryKey({ userId: user?.id || "" });
  const queryState = qc.getQueryState(walletQueryKey);
  const dataUpdatedAt = queryState?.dataUpdatedAt;
  const prevDataUpdatedAtRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (dataUpdatedAt && dataUpdatedAt !== prevDataUpdatedAtRef.current) {
      prevDataUpdatedAtRef.current = dataUpdatedAt;
      setSocketBalance(null);
    }
  }, [dataUpdatedAt]);

  useEffect(() => {
    const current = user?.walletBalance;
    if (current !== undefined && current !== prevUserBalanceRef.current) {
      prevUserBalanceRef.current = current;
      if (data?.balance !== undefined && current !== data.balance) {
        setSocketBalance(current);
      }
    }
  }, [user?.walletBalance, data?.balance]);

  /* Subscribe to freeze/unfreeze events via socket for real-time updates (single consolidated listener) */
  useEffect(() => {
    if (!socket) return;
    const handleFrozen   = () => setWalletFrozen(true);
    const handleUnfrozen = () => setWalletFrozen(false);
    const handleFreezeChange = (payload: { frozen: boolean }) => {
      setWalletFrozen(payload.frozen);
    };
    socket.on("wallet:frozen", handleFrozen);
    socket.on("wallet:unfrozen", handleUnfrozen);
    socket.on("wallet:freeze_change", handleFreezeChange);
    return () => {
      socket.off("wallet:frozen", handleFrozen);
      socket.off("wallet:unfrozen", handleUnfrozen);
      socket.off("wallet:freeze_change", handleFreezeChange);
    };
  }, [socket]);

  useEffect(() => {
    if (walletErrorObj) {
      const status =
        (walletErrorObj instanceof Error && "status" in walletErrorObj && typeof (walletErrorObj as Error & { status?: unknown }).status === "number")
          ? (walletErrorObj as Error & { status: number }).status
          : undefined;
      if (status === 403) {
        setWalletFrozen(true);
      }
    } else if (data) {
      setWalletFrozen(false);
    }
  }, [walletErrorObj, data]);

  useEffect(() => {
    if (data) {
      if (typeof data.pinSetup === "boolean") setPinSetup(data.pinSetup);
      if (typeof data.walletHidden === "boolean") setWalletHidden(data.walletHidden);
    }
  }, [data]);

  useEffect(() => {
    if (token) {
      fetch(`${API}/wallet`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async r => {
          if (r.status === 403) {
            const d = unwrapApiResponse<{ error?: string }>(await r.json().catch(() => ({})));
            if (d.error === "wallet_frozen") setWalletFrozen(true);
          } else {
            setWalletFrozen(false);
          }
        })
        .catch((err) => { if (__DEV__) console.warn("[Wallet] Frozen-status check failed:", err instanceof Error ? err.message : String(err)); });
    }
  }, [token]);

  const onRefresh = useCallback(async () => {
    if (token) {
      try {
        const r = await fetch(`${API}/wallet`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.status === 403) {
          const d = unwrapApiResponse<{ error?: string }>(await r.json().catch(() => ({})));
          if (d.error === "wallet_frozen") { setWalletFrozen(true); return; }
        } else { setWalletFrozen(false); }
      } catch (err) {
        if (__DEV__) console.warn("[Wallet] Status check failed:", err instanceof Error ? err.message : String(err));
      }
    }
    const res = await refetch();
    if (res.data?.balance !== undefined) {
      updateUser({ walletBalance: res.data.balance });
    }
    setLastRefreshed(new Date());
  }, [refetch, updateUser, token, socket]);

  useEffect(() => {
    if (token) {
      fetch(`${API}/wallet/pending-topups`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(j => unwrapApiResponse<{ count?: number; total?: number }>(j))
        .then(d => setPendingTopups({ count: d.count || 0, total: d.total || 0 }))
        .catch((err) => { if (__DEV__) console.warn("[Wallet] Pending topups fetch failed:", err instanceof Error ? err.message : String(err)); });
    }
  }, [token]);

  const toggleWalletVisibility = async () => {
    const newHidden = !walletHidden;
    setWalletHidden(newHidden);
    try {
      await fetch(`${API}/wallet/visibility`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ hidden: newHidden }),
      });
    } catch { setWalletHidden(!newHidden); }
  };

  const handlePinVerified = (pinToken: string) => {
    setActivePinToken(pinToken);
    if (pendingPinAction === "send") setShowSend(true);
    else if (pendingPinAction === "withdraw") setShowWithdraw(true);
    setPendingPinAction(null);
  };

  const openWithPinCheck = (action: "send" | "withdraw") => {
    if (pinSetup) {
      setPendingPinAction(action);
      setShowMpinVerify(true);
    } else {
      setPendingPinAction(action);
      setShowMpinSetup(true);
    }
  };

  const handleDepositSuccess = () => {
    qc.invalidateQueries({ queryKey: walletQueryKey });
    showToast("Deposit request submitted! It will be approved within 1-2 hours.", "success");
  };

  const openSendFromQR = (phone: string) => {
    setShowQR(false);
    setSendPhone(phone);
    setShowSend(true);
  };

  const resetSendState = () => {
    setSendPhone(""); setSendAmount(""); setSendNote("");
    setSendStep("input"); setSendPhoneError(""); setSendReceiverName(""); setSendLoading(false);
    setSendNetworkError(false); setSendMode("phone");
  };

  const closeSendModal = () => {
    setShowSend(false);
    resetSendState();
    setActivePinToken(null);
  };

  const validateSendPhone = (phone: string): boolean => {
    const cleaned = phone.trim().replace(/\s/g, "");
    if (!cleaned) { setSendPhoneError("Phone number is required"); return false; }
    if (!cleaned.startsWith("3")) { setSendPhoneError("Phone number must start with 3"); return false; }
    if (cleaned.length !== 10) { setSendPhoneError("Phone number must be exactly 10 digits"); return false; }
    if (!/^\d+$/.test(cleaned)) { setSendPhoneError("Phone number must contain only digits"); return false; }
    setSendPhoneError("");
    return true;
  };

  const validateSendAjkId = (id: string): boolean => {
    const cleaned = id.trim().toUpperCase();
    if (!cleaned) { setSendPhoneError("AJK ID is required"); return false; }
    if (!/^AJK-[A-Z0-9]{4,8}$/.test(cleaned)) { setSendPhoneError("AJK ID format: AJK-XXXXXX"); return false; }
    setSendPhoneError("");
    return true;
  };

  const handleSendContinue = async () => {
    setSendNetworkError(false);
    if (sendMode === "ajkid") {
      if (!validateSendAjkId(sendPhone)) return;
    } else {
      if (!validateSendPhone(sendPhone)) return;
    }
    const num = parseFloat(sendAmount);
    const safeMinTransfer = minTransfer || 200;
    if (!num || !isFinite(num) || isNaN(num) || num < safeMinTransfer) { showToast(`Minimum transfer amount is ${currencySymbol} ${safeMinTransfer.toLocaleString()}`, "error"); return; }
    const feeAmount = Math.round(num * p2pFee) / 100;
    const totalRequired = num + feeAmount;
    if (totalRequired > balance) { showToast(`Insufficient balance. Need ${currencySymbol} ${totalRequired.toLocaleString()} (includes ${currencySymbol} ${feeAmount.toLocaleString()} fee)`, "error"); return; }
    setSendReceiverName("");
    setSendNetworkError(false);
    setSendLoading(true);
    try {
      const resolveBody = sendMode === "ajkid"
        ? { ajkId: sendPhone.trim().toUpperCase() }
        : { phone: sendPhone.trim() };
      const res = await fetch(`${API}/wallet/resolve-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(resolveBody),
      });
      if (!res.ok) {
        if (__DEV__) console.warn("[Wallet] Receiver lookup returned HTTP error:", res.status);
        setSendNetworkError(true);
        setSendLoading(false);
        return;
      }
      const data = unwrapApiResponse<{ found?: boolean; name?: string }>(await res.json());
      if (!data.found) {
        showToast(sendMode === "ajkid" ? "No account found with this AJK ID." : "No AJKMart account found with this phone number.", "error");
        setSendLoading(false);
        return;
      }
      setSendReceiverName(data.name || "");
    } catch (err) {
      if (__DEV__) console.warn("[Wallet] Receiver lookup failed (network):", err instanceof Error ? err.message : String(err));
      setSendNetworkError(true);
      setSendLoading(false);
      return;
    }
    setSendLoading(false);
    setSendStep("confirm");
  };

  const [sendIdempotencyKey, setSendIdempotencyKey] = useState("");
  const [sendFrozenError, setSendFrozenError] = useState("");

  useEffect(() => {
    if (showSend) {
      (async () => {
        const { randomUUID } = await import("expo-crypto");
        setSendIdempotencyKey(randomUUID());
        setSendFrozenError("");
      })();
    }
  }, [showSend]);

  const handleSendConfirm = async () => {
    if (sendLoading) return;
    const num = parseFloat(sendAmount);
    setSendLoading(true);
    setSendFrozenError("");
    try {
      const res = await fetch(`${API}/wallet/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": sendIdempotencyKey,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(activePinToken ? { "x-wallet-pin-token": activePinToken } : {}),
        },
        body: JSON.stringify(sendMode === "ajkid"
          ? { ajkId: sendPhone.trim().toUpperCase(), amount: num, note: sendNote || null }
          : { receiverPhone: sendPhone.trim(), amount: num, note: sendNote || null }),
      });
      const data = unwrapApiResponse<{ error?: string; newBalance?: number; receiverName?: string }>(await res.json());
      if (!res.ok) {
        if (data.error === "wallet_frozen") {
          setSendFrozenError("Your wallet has been temporarily frozen. Please contact support.");
          setSendLoading(false);
          return;
        }
        showToast(data.error || "Transfer failed", "error");
        setSendLoading(false); return;
      }
      updateUser({ walletBalance: data.newBalance });
      qc.invalidateQueries({ queryKey: walletQueryKey });
      closeSendModal();
      showToast(`${currencySymbol} ${num.toLocaleString()} sent to ${data.receiverName || sendPhone}!`, "success");
    } catch {
      showToast("Network error. Please try again.", "error");
      setSendLoading(false);
    }
  };

  /* Fix: socket-first priority — real-time socket balance wins if available */
  const balance      = socketBalance ?? data?.balance ?? user?.walletBalance ?? 0;
  const transactions = data?.transactions ?? [];
  const filtered     = txFilter === "all"
    ? transactions
    : txFilter === "debit"
    ? transactions.filter(isDebitTx)
    : transactions.filter(isCreditTx);
  const totalIn      = transactions.filter(isCreditTx).reduce((s, t) => s + Number(t.amount), 0);
  const totalOut     = transactions.filter(isDebitTx).reduce((s, t) => s + Number(t.amount), 0);

  /* Sanitize QR name — truncate to 30 chars to avoid over-dense codes */
  const qrName = (user?.name ?? "").slice(0, 30);

  if (!user?.id) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingTop: topPad }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <Ionicons name="lock-closed-outline" size={32} color={C.primary} />
        </View>
        <Text style={{ fontFamily: Font.bold, fontSize: 20, color: C.text, textAlign: "center", marginBottom: 8 }}>{T("signInToContinue")}</Text>
        <Text style={{ fontFamily: Font.regular, fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22, marginBottom: 28 }}>
          {T("signInWalletSub")}
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={async () => {
            await AsyncStorage.setItem("@ajkmart_auth_return_to", "/(tabs)/wallet");
            router.push("/auth");
          }}
          style={{ backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32, width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Sign In or Register"
        >
          <Ionicons name="person-circle-outline" size={18} color="#fff" />
          <Text style={{ fontFamily: Font.bold, fontSize: 15, color: "#fff" }}>{T("signInRegister")}</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} onPress={() => router.back()} style={{ paddingVertical: 12 }} accessibilityRole="button">
          <Text style={{ fontFamily: Font.semiBold, fontSize: 14, color: C.textMuted }}>{T("continueBrowsing")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasRole(user, "customer")) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <Ionicons name="alert-circle-outline" size={36} color={C.amber} />
        </View>
        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 20, color: C.text, textAlign: "center", marginBottom: 8 }}>{T("customerAccountRequired")}</Text>
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22 }}>
          {`You're signed in as a ${(user.roles ?? []).join(", ")} account. The wallet is only available for customer accounts.`}
        </Text>
      </View>
    );
  }

  if (!platformConfig.features.wallet) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingTop: topPad }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <Ionicons name="wallet-outline" size={36} color={C.textMuted} />
        </View>
        <Text style={{ fontFamily: Font.bold, fontSize: 20, color: C.text, textAlign: "center", marginBottom: 8 }}>Wallet Unavailable</Text>
        <Text style={{ fontFamily: Font.regular, fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22 }}>
          The wallet service is currently unavailable. Please check back later.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <LinearGradient colors={[C.primaryDark, C.primary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingTop: topPad + 12, paddingHorizontal: 20, paddingBottom: 14 }}>
        {walletError && !data && !walletFrozen && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => refetch()} style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.redSoft, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.redMist }} accessibilityRole="button" accessibilityLabel="No network connection, tap to retry">
            <Ionicons name="cloud-offline-outline" size={20} color={C.red} />
            <View style={{ flex: 1 }}>
              <Text style={{ ...Typ.body, fontFamily: Font.bold, color: C.redDeep }}>No network connection</Text>
              <Text style={{ ...Typ.caption, color: C.redDeepest, marginTop: 2 }}>Showing last known balance. Tap to retry.</Text>
            </View>
            <Ionicons name="refresh-outline" size={16} color={C.red} />
          </TouchableOpacity>
        )}

        {walletFrozen ? (
          <View style={{ alignItems: "center", paddingVertical: 24, gap: 14 }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="lock-closed" size={36} color={C.amber} />
            </View>
            <Text style={{ ...Typ.title, color: C.amberDark }}>Wallet Frozen</Text>
            <Text style={{ ...Typ.body, color: C.amberDark, textAlign: "center", lineHeight: 20, maxWidth: 280 }}>
              Your wallet has been temporarily frozen. Please contact support to resolve this issue.
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.amberSoft, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.amberBorder, width: "100%", marginTop: 4 }}>
              <Ionicons name="headset-outline" size={16} color={C.amber} />
              <Text style={{ ...Typ.captionMedium, color: C.amberDark, flex: 1 }}>Contact support to unfreeze your wallet</Text>
            </View>
          </View>
        ) : (
          <>
            <Text style={{ ...Typ.body, fontSize: 12, color: "rgba(255,255,255,0.75)", marginBottom: 2 }}>{appName} {T("wallet")}</Text>
            {isLoading && !data ? (
              <View style={{ marginBottom: 4 }}>
                <View style={{ height: 44, width: 180, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.2)", opacity: 0.7 }} />
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 2 }}>
                <Text style={{ fontFamily: Font.bold, fontSize: 34, color: "#FFFFFF" }}>
                  {walletHidden ? `${currencySymbol} ••••••` : `${currencySymbol} ${balance.toLocaleString()}`}
                </Text>
                <TouchableOpacity activeOpacity={0.7} onPress={toggleWalletVisibility} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={walletHidden ? "Show balance" : "Hide balance"}>
                  <Ionicons name={walletHidden ? "eye-off" : "eye"} size={22} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>
            )}
            <Animated.Text style={{ ...Typ.body, fontSize: 12, color: "rgba(255,255,255,0.75)", marginBottom: 10, opacity: balanceLabelOpacity, maxHeight: balanceLabelMaxHeight }}>{T("availableBalance")}</Animated.Text>

            <Animated.View style={{ opacity: actionsOpacity, maxHeight: actionsMaxHeight, overflow: "hidden" }}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowDeposit(true)} style={ws.actionCard} accessibilityRole="button" accessibilityLabel={T("topUp")}>
                  <View style={[ws.actionCardIcon, { backgroundColor: "rgba(255,255,255,0.2)" }]}>
                    <Ionicons name="add" size={20} color="#FFFFFF" />
                  </View>
                  <Text style={[ws.actionCardTxt, { color: "rgba(255,255,255,0.9)" }]}>{T("topUp")}</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} onPress={() => openWithPinCheck("withdraw")} style={ws.actionCard} accessibilityRole="button" accessibilityLabel="Withdraw money">
                  <View style={[ws.actionCardIcon, { backgroundColor: "rgba(255,255,255,0.2)" }]}>
                    <Ionicons name="arrow-up-outline" size={18} color="#FFFFFF" />
                  </View>
                  <Text style={[ws.actionCardTxt, { color: "rgba(255,255,255,0.9)" }]}>Withdraw</Text>
                </TouchableOpacity>
                {p2pEnabled && (
                  <TouchableOpacity activeOpacity={0.7} onPress={() => openWithPinCheck("send")} style={ws.actionCard} accessibilityRole="button" accessibilityLabel={T("send")}>
                    <View style={[ws.actionCardIcon, { backgroundColor: "rgba(255,255,255,0.2)" }]}>
                      <Ionicons name="send-outline" size={18} color="#FFFFFF" />
                    </View>
                    <Text style={[ws.actionCardTxt, { color: "rgba(255,255,255,0.9)" }]}>{T("send")}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowQR(true)} style={ws.actionCard} accessibilityRole="button" accessibilityLabel={T("receive")}>
                  <View style={[ws.actionCardIcon, { backgroundColor: "rgba(255,255,255,0.2)" }]}>
                    <Ionicons name="qr-code-outline" size={18} color="#FFFFFF" />
                  </View>
                  <Text style={[ws.actionCardTxt, { color: "rgba(255,255,255,0.9)" }]}>{T("receive")}</Text>
                </TouchableOpacity>
              </View>

              {pendingTopups.count > 0 && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.amberSoft, borderRadius: 12, marginTop: 12, padding: 12, borderWidth: 1, borderColor: C.amberBorder }}>
                  <Ionicons name="time-outline" size={14} color={C.amber} />
                  <Text style={{ ...Typ.captionMedium, color: C.amberDark, flex: 1 }}>
                    {pendingTopups.count} pending ({`${currencySymbol} ${pendingTopups.total.toLocaleString()}`}) — awaiting approval
                  </Text>
                </View>
              )}
            </Animated.View>
          </>
        )}
      </LinearGradient>

      <SmartRefresh
        onRefresh={onRefresh}
        lastUpdated={lastRefreshed}
        showsVerticalScrollIndicator={false}
        onScroll={walletScrollHandler}
        scrollEventThrottle={walletScrollThrottle}
      >

        <View style={{ flexDirection: "row", paddingHorizontal: 20, gap: 10, marginTop: 16 }}>
          <View style={ws.statCard}>
            <View style={[ws.statIcon, { backgroundColor: C.emeraldSoft }]}>
              <Ionicons name="arrow-down-outline" size={16} color={C.success} />
            </View>
            <Text style={ws.statLbl}>{T("moneyIn")}</Text>
            <Text style={[ws.statAmt, { color: C.success }]}>{currencySymbol} {totalIn.toLocaleString()}</Text>
          </View>
          <View style={ws.statCard}>
            <View style={[ws.statIcon, { backgroundColor: C.redSoft }]}>
              <Ionicons name="arrow-up-outline" size={16} color={C.danger} />
            </View>
            <Text style={ws.statLbl}>{T("moneyOut")}</Text>
            <Text style={[ws.statAmt, { color: C.danger }]}>{currencySymbol} {totalOut.toLocaleString()}</Text>
          </View>
          <View style={ws.statCard}>
            <View style={[ws.statIcon, { backgroundColor: C.brandBlueSoft }]}>
              <Ionicons name="receipt-outline" size={16} color={C.primary} />
            </View>
            <Text style={ws.statLbl}>{T("transactions")}</Text>
            <Text style={[ws.statAmt, { color: C.primary }]}>{transactions.length}</Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
          <View style={{ backgroundColor: C.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.primarySoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="shield-checkmark" size={18} color={C.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ ...Typ.bodySemiBold, color: C.text }}>Wallet Security</Text>
                <Text style={{ ...Typ.caption, color: C.textMuted }}>{pinSetup ? "MPIN active" : "Set up MPIN for secure transactions"}</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {!pinSetup ? (
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowMpinSetup(true)} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: C.primary, borderRadius: 12, paddingVertical: 10 }}>
                  <Ionicons name="lock-closed" size={16} color="#fff" />
                  <Text style={{ ...Typ.bodySemiBold, color: "#fff" }}>Create MPIN</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowMpinChange(true)} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: C.surfaceSecondary, borderRadius: 12, paddingVertical: 10, borderWidth: 1, borderColor: C.border }}>
                  <Ionicons name="key" size={16} color={C.primary} />
                  <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Change MPIN</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ ...Typ.price, color: C.text }}>{T("transactionHistory")}</Text>
              {isFetching && data && (
                <ActivityIndicator size="small" color={C.primary} />
              )}
            </View>
            {transactions.length > 0 && (
              <View style={{ flexDirection: "row", gap: 6 }}>
                {(["all", "credit", "debit"] as TxFilter[]).map(f => (
                  <TouchableOpacity activeOpacity={0.7} key={f} onPress={() => setTxFilter(f)} style={[ws.filterChip, txFilter === f && ws.filterChipActive]} accessibilityRole="tab" accessibilityLabel={f === "all" ? T("allFilter") : f === "credit" ? T("inFilter") : T("outFilter")} accessibilityState={{ selected: txFilter === f }}>
                    <Text style={[ws.filterTxt, txFilter === f && ws.filterTxtActive]}>
                      {f === "all" ? T("allFilter") : f === "credit" ? T("inFilter") : T("outFilter")}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {isLoading && !data ? (
            <View style={{ gap: 12, marginTop: 8 }}>
              {[1,2,3,4].map(i => (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: C.border }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <View style={{ height: 13, width: "70%", borderRadius: 6, backgroundColor: C.border }} />
                    <View style={{ height: 11, width: "45%", borderRadius: 5, backgroundColor: C.slateGray }} />
                  </View>
                  <View style={{ height: 14, width: 64, borderRadius: 6, backgroundColor: C.border }} />
                </View>
              ))}
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ alignItems: "center", gap: 10, paddingVertical: 48 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="receipt-outline" size={26} color={C.textMuted} />
              </View>
              <Text style={{ ...Typ.button, color: C.text }}>{transactions.length === 0 ? T("noTransactionLabel") : T("filterNoResultsLabel")}</Text>
              <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>{transactions.length === 0 ? T("noTransactionSub") : T("changeFilterLabel")}</Text>
              {transactions.length === 0 && (
                <TouchableOpacity activeOpacity={0.7}
                  onPress={() => router.replace("/(tabs)")}
                  style={{ marginTop: 8, backgroundColor: C.primary, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 11 }}
                  accessibilityRole="button"
                  accessibilityLabel="Explore services"
                >
                  <Text style={{ color: C.textInverse, ...Typ.bodySemiBold }}>Explore Services</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View>
              {filtered.map(tx => <TxItem key={tx.id} tx={tx} />)}
            </View>
          )}
        </View>

        <View style={{ height: TAB_H + insets.bottom + 20 }} />
      </SmartRefresh>

      {showDeposit && (
        <DepositModal
          token={token}
          onClose={() => setShowDeposit(false)}
          onSuccess={handleDepositSuccess}
          onFrozen={() => setWalletFrozen(true)}
          minTopup={platformConfig.customer.minTopup}
          maxTopup={platformConfig.customer.maxTopup}
        />
      )}

      {showWithdraw && (
        <WithdrawModal
          token={token}
          balance={balance}
          minWithdrawal={platformConfig.customer.minWithdrawal}
          pinToken={activePinToken}
          onClose={() => { setShowWithdraw(false); setActivePinToken(null); }}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: walletQueryKey });
            showToast(`Withdrawal request submitted! It will be processed within ${platformConfig.customer?.withdrawalProcessingDays ? `${platformConfig.customer.withdrawalProcessingDays} business day(s)` : "24–48 hours"}.`, "success");
            setActivePinToken(null);
          }}
          onFrozen={() => setWalletFrozen(true)}
        />
      )}

      <Modal visible={showSend} transparent animationType="slide" onRequestClose={closeSendModal}>
        <TouchableOpacity activeOpacity={0.7} style={ws.overlay} onPress={closeSendModal}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }} keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}>
          <TouchableOpacity activeOpacity={0.7} style={ws.sheet} onPress={e => e.stopPropagation()}>
            <View style={ws.handle} />
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">

                {sendStep === "input" ? (
                  <>
                    <Text style={ws.sheetTitle}>Send Money</Text>

                    {/* Mode toggle: Phone vs AJK ID */}
                    <View style={{ flexDirection: "row", gap: 6, marginBottom: 12, backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 3 }}>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => { setSendMode("phone"); setSendPhone(""); setSendPhoneError(""); }}
                        style={{ flex: 1, paddingVertical: 7, borderRadius: 8, backgroundColor: sendMode === "phone" ? C.surface : "transparent", alignItems: "center" }}
                      >
                        <Text style={{ ...Typ.caption, fontFamily: sendMode === "phone" ? Font.bold : Font.regular, color: sendMode === "phone" ? C.text : C.textMuted }}>Phone Number</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => { setSendMode("ajkid"); setSendPhone(""); setSendPhoneError(""); }}
                        style={{ flex: 1, paddingVertical: 7, borderRadius: 8, backgroundColor: sendMode === "ajkid" ? C.surface : "transparent", alignItems: "center" }}
                      >
                        <Text style={{ ...Typ.caption, fontFamily: sendMode === "ajkid" ? Font.bold : Font.regular, color: sendMode === "ajkid" ? C.purple : C.textMuted }}>AJK ID</Text>
                      </TouchableOpacity>
                    </View>

                    <Text style={ws.sheetLbl}>{sendMode === "ajkid" ? "Receiver's AJK ID" : "Receiver's Phone Number"}</Text>
                    {sendMode === "ajkid" ? (
                      <View style={[ws.inputWrap, sendPhoneError ? { borderColor: C.redBright } : {}]}>
                        <View style={ws.phonePrefix}>
                          <Text style={[ws.phonePrefixTxt, { color: C.purple }]}>AJK-</Text>
                        </View>
                        <TextInput
                          value={sendPhone.startsWith("AJK-") ? sendPhone.slice(4) : sendPhone}
                          onChangeText={(t) => { setSendPhone("AJK-" + t.toUpperCase().replace(/[^A-Z0-9]/g, "")); if (sendPhoneError) setSendPhoneError(""); setSendNetworkError(false); }}
                          placeholder="XXXXXX"
                          placeholderTextColor={C.textMuted}
                          style={ws.sendInput}
                          autoCapitalize="characters"
                          maxLength={8}
                        />
                      </View>
                    ) : (
                      <View style={[ws.inputWrap, sendPhoneError ? { borderColor: C.redBright } : {}]}>
                        <View style={ws.phonePrefix}>
                          <Text style={ws.phonePrefixTxt}>+92</Text>
                        </View>
                        <TextInput
                          value={sendPhone}
                          onChangeText={(t) => { setSendPhone(t); if (sendPhoneError) setSendPhoneError(""); setSendNetworkError(false); }}
                          placeholder="3XX XXXXXXX"
                          placeholderTextColor={C.textMuted}
                          style={ws.sendInput}
                          keyboardType="phone-pad"
                          maxLength={10}
                        />
                      </View>
                    )}
                    {sendPhoneError ? <Text style={{ ...Typ.caption, color: C.redBright, marginTop: 2, marginBottom: 6 }}>{sendPhoneError}</Text> : null}

                    {sendNetworkError ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.amberSoft, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: C.amberBorder }}>
                        <Ionicons name="cloud-offline-outline" size={16} color={C.amber} />
                        <Text style={{ ...Typ.caption, color: C.amberDark, flex: 1 }}>Network error. Could not verify receiver.</Text>
                        <TouchableOpacity activeOpacity={0.7} onPress={handleSendContinue} style={{ backgroundColor: C.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }} accessibilityRole="button" accessibilityLabel="Retry phone resolution">
                          <Text style={{ ...Typ.caption, color: C.textInverse, fontFamily: Font.bold }}>Retry</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}

                    <Text style={ws.sheetLbl}>Amount ({currencyCode})</Text>
                    <View style={ws.amtWrap}>
                      <Text style={ws.rupee}>{currencySymbol}</Text>
                      <TextInput style={ws.amtInput} value={sendAmount} onChangeText={t => setSendAmount(t.replace(/[^0-9]/g, ""))} keyboardType="numeric" placeholder="0" placeholderTextColor={C.textMuted} />
                    </View>

                    <Text style={ws.sheetLbl}>Note (Optional)</Text>
                    <View style={[ws.inputWrap, { paddingHorizontal: 14, paddingVertical: 10 }]}>
                      <TextInput value={sendNote} onChangeText={setSendNote} placeholder="e.g. Lunch bill" placeholderTextColor={C.textMuted} style={[ws.sendInput, { paddingVertical: 0 }]} maxLength={NOTE_MAX_LENGTH} />
                    </View>
                    <Text style={{ ...Typ.small, color: C.textMuted, textAlign: "right", marginTop: 2, marginBottom: 8 }}>{sendNote.length}/{NOTE_MAX_LENGTH}</Text>

                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, marginTop: 4 }}>
                      <Ionicons name="wallet-outline" size={14} color={C.primary} />
                      <Text style={{ ...Typ.caption, color: C.textMuted, flex: 1 }}>Available: {currencySymbol} {balance.toLocaleString()} · Min: {currencySymbol} {(minTransfer || 200).toLocaleString()}</Text>
                    </View>
                    {p2pFee > 0 && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
                        <Ionicons name="information-circle-outline" size={14} color={C.textMuted} />
                        <Text style={{ ...Typ.caption, color: C.textMuted }}>P2P fee: {p2pFee}% will be deducted from your wallet</Text>
                      </View>
                    )}

                    <TouchableOpacity activeOpacity={0.7} onPress={handleSendContinue} disabled={!sendPhone || !sendAmount || sendLoading} style={[ws.actionBtn, { backgroundColor: C.purple }, (!sendPhone || !sendAmount || sendLoading) && { opacity: 0.5 }]} accessibilityRole="button" accessibilityLabel="Continue to confirm send" accessibilityState={{ disabled: !sendPhone || !sendAmount || sendLoading }}>
                      {sendLoading ? <ActivityIndicator color={C.textInverse} /> : (
                        <>
                          <Ionicons name="arrow-forward" size={17} color={C.textInverse} />
                          <Text style={ws.actionBtnTxt}>Continue</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
                      <TouchableOpacity activeOpacity={0.7} onPress={() => { setSendStep("input"); setSendFrozenError(""); }} style={{ marginRight: 10, padding: 4 }} accessibilityRole="button" accessibilityLabel="Go back">
                        <Ionicons name="arrow-back" size={20} color={C.text} />
                      </TouchableOpacity>
                      <Text style={[ws.sheetTitle, { marginBottom: 0 }]}>Confirm Transfer</Text>
                    </View>

                    <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 16, marginBottom: 16, gap: 12 }}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>To</Text>
                        <View style={{ alignItems: "flex-end" }}>
                          {sendReceiverName ? <Text style={{ ...Typ.bodySemiBold, color: C.text }}>{sendReceiverName}</Text> : null}
                          <Text style={{ ...Typ.body, fontSize: 13, color: sendReceiverName ? C.textMuted : C.text }}>
                            {sendMode === "ajkid" ? sendPhone.trim().toUpperCase() : `+92 ${sendPhone.trim()}`}
                          </Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Amount</Text>
                        <Text style={{ ...Typ.h3, fontSize: 16, color: C.purple }}>{currencySymbol} {parseFloat(sendAmount || "0").toLocaleString()}</Text>
                      </View>
                      {p2pFee > 0 && (
                        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                          <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>P2P Fee ({p2pFee}%)</Text>
                          <Text style={{ ...Typ.body, fontSize: 13, color: C.danger }}>{currencySymbol} {(Math.round(parseFloat(sendAmount || "0") * p2pFee) / 100).toLocaleString()}</Text>
                        </View>
                      )}
                      {sendNote ? (
                        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                          <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted }}>Note</Text>
                          <Text style={{ ...Typ.body, fontSize: 13, color: C.text }}>{sendNote}</Text>
                        </View>
                      ) : null}
                    </View>

                    {sendFrozenError ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12, backgroundColor: C.redBg, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.redSoft }}>
                        <Ionicons name="lock-closed" size={16} color={C.danger} />
                        <Text style={{ ...Typ.caption, color: C.danger, flex: 1 }}>{sendFrozenError}</Text>
                      </View>
                    ) : null}

                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setSendStep("input"); setSendFrozenError(""); }} style={{ alignSelf: "center", marginBottom: 12 }} accessibilityRole="button" accessibilityLabel="Edit transfer details">
                      <Text style={{ ...Typ.buttonSmall, color: C.primary }}>Edit Details</Text>
                    </TouchableOpacity>

                    <TouchableOpacity activeOpacity={0.7} onPress={handleSendConfirm} disabled={sendLoading || !sendIdempotencyKey} style={[ws.actionBtn, { backgroundColor: C.purple }, (sendLoading || !sendIdempotencyKey) && { opacity: 0.5 }]} accessibilityRole="button" accessibilityLabel={`Send ${currencySymbol} ${parseFloat(sendAmount || "0").toLocaleString()}`} accessibilityState={{ disabled: sendLoading || !sendIdempotencyKey }}>
                      {sendLoading ? <ActivityIndicator color={C.textInverse} /> : (
                        <>
                          <Ionicons name="send" size={17} color={C.textInverse} />
                          <Text style={ws.actionBtnTxt}>Send {currencySymbol} {parseFloat(sendAmount || "0").toLocaleString()}</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </>
                )}
              </ScrollView>
          </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showQR} transparent animationType="fade" onRequestClose={() => setShowQR(false)}>
        <TouchableOpacity activeOpacity={0.7} style={[ws.overlay, { justifyContent: "center", paddingHorizontal: 32 }]} onPress={() => setShowQR(false)}>
          <TouchableOpacity activeOpacity={0.7} style={[ws.sheet, { borderRadius: 24, paddingVertical: 28 }]} onPress={e => e.stopPropagation()}>
            <Text style={[ws.sheetTitle, { textAlign: "center" }]}>Receive Money</Text>
            <Text style={{ ...Typ.body, fontSize: 13, color: C.textMuted, textAlign: "center", marginBottom: 20 }}>
              Scan this QR code or share your phone number
            </Text>

            <View style={{ backgroundColor: C.surfaceSecondary, borderRadius: 20, padding: 24, alignItems: "center", marginBottom: 16, gap: 12, borderWidth: 1, borderColor: C.border }}>
              <View style={{ width: 140, height: 140, borderRadius: 16, backgroundColor: C.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.border }}>
                <QRCode
                  value={JSON.stringify({ type: "ajkmart_pay", phone: user?.phone, id: user?.id, name: qrName })}
                  size={120}
                  color={C.primary}
                  backgroundColor={C.surface}
                  ecl="M"
                />
              </View>
              <Text style={{ ...Typ.price, color: C.text }}>{user?.name || "AJKMart User"}</Text>
              <Text style={{ ...Typ.body, color: C.textMuted }}>+92 {user?.phone}</Text>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 16 }}>
              <Ionicons name="shield-checkmark-outline" size={14} color={C.success} />
              <Text style={{ ...Typ.caption, color: C.textMuted, flex: 1 }}>{appName} users can send directly to your wallet</Text>
            </View>

            <TouchableOpacity activeOpacity={0.7} onPress={() => setShowQR(false)} style={[ws.actionBtn, { backgroundColor: C.primary }]} accessibilityRole="button" accessibilityLabel="Close QR code">
              <Text style={ws.actionBtnTxt}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {showMpinSetup && (
        <MpinSetupModal
          token={token}
          onClose={() => {
            setShowMpinSetup(false);
            if (!mpinSetupSucceededRef.current) {
              setPendingPinAction(null);
            }
            mpinSetupSucceededRef.current = false;
          }}
          onSuccess={() => {
            mpinSetupSucceededRef.current = true;
            setPinSetup(true);
            qc.invalidateQueries({ queryKey: walletQueryKey });
            if (pendingPinAction) {
              setShowMpinVerify(true);
            }
          }}
        />
      )}

      {showMpinChange && (
        <MpinChangeModal
          token={token}
          onClose={() => setShowMpinChange(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: walletQueryKey })}
        />
      )}

      {showMpinVerify && (
        <MpinVerifyModal
          token={token}
          onClose={() => { setShowMpinVerify(false); setPendingPinAction(null); }}
          onVerified={handlePinVerified}
        />
      )}

    </View>
  );
}

export default withErrorBoundary(WalletScreenInner);

const ws = StyleSheet.create({
  actionCard: { flex: 1, alignItems: "center", gap: 8 },
  actionCardIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  actionCardTxt: { ...Typ.smallMedium, color: C.textSecondary, textAlign: "center" },

  statCard: { flex: 1, backgroundColor: C.surface, borderRadius: 16, padding: 14, alignItems: "center", gap: 6, borderWidth: 1, borderColor: C.border },
  statIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  statLbl: { ...Typ.small, fontSize: 10, color: C.textMuted },
  statAmt: { ...Typ.buttonSmall, fontFamily: Font.bold },

  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: C.surfaceSecondary },
  filterChipActive: { backgroundColor: C.primary },
  filterTxt: { ...Typ.smallMedium, color: C.textMuted },
  filterTxtActive: { color: C.textInverse },

  txRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.borderLight },
  txIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  txDesc: { ...Typ.bodyMedium, fontSize: 13, color: C.text },
  txDate: { ...Typ.small, color: C.textMuted, marginTop: 2 },
  txAmt: { ...Typ.body, fontFamily: Font.bold },

  overlay: { flex: 1, backgroundColor: C.overlayDark50, justifyContent: "flex-end" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingBottom: Platform.OS === "web" ? 40 : 48, paddingTop: 12 },
  handle: { width: 40, height: 4, backgroundColor: C.border, borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  sheetTitle: { ...Typ.h2, color: C.text, marginBottom: 4 },
  sheetLbl: { ...Typ.bodyMedium, fontSize: 13, color: C.textSecondary, marginBottom: 8 },

  amtWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, marginBottom: 18 },
  rupee: { ...Typ.h2, fontFamily: Font.semiBold, color: C.textSecondary, marginRight: 8 },
  amtInput: { flex: 1, ...Typ.h1, color: C.text, paddingVertical: 14 },

  quickRow: { flexDirection: "row", gap: 8, marginBottom: 18 },
  quickBtn: { flex: 1, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingVertical: 11, alignItems: "center" },
  quickBtnActive: { borderColor: C.primary, backgroundColor: C.blueSoft },
  quickTxt: { ...Typ.smallMedium, color: C.textSecondary },
  quickTxtActive: { color: C.primary, fontFamily: Font.bold },

  inputWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderColor: C.border, borderRadius: 14, marginBottom: 14, overflow: "hidden" },
  phonePrefix: { backgroundColor: C.surfaceSecondary, paddingHorizontal: 14, paddingVertical: 14, borderRightWidth: 1, borderRightColor: C.border },
  phonePrefixTxt: { ...Typ.button, color: C.text },
  sendInput: { flex: 1, ...Typ.body, fontSize: 15, color: C.text, paddingHorizontal: 14, paddingVertical: 13 },

  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 16, paddingVertical: 16, marginTop: 4, backgroundColor: C.primary },
  actionBtnTxt: { ...Typ.h3, fontSize: 16, color: C.textInverse },
  input: { borderWidth: 1.5, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, ...Typ.body, color: C.text, fontSize: 16, textAlign: "center" },
});
