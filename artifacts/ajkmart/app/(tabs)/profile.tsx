import { Ionicons } from "@expo/vector-icons";
import { withErrorBoundary } from "@/utils/withErrorBoundary";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import * as StoreReview from "expo-store-review";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  InteractionManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Share,
  Switch,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing, radii, shadows, typography } from "@/constants/colors";
import { T as Typ, Font } from "@/constants/typography";
import { useAuth, hasRole } from "@/context/AuthContext";
import { useFontSize, type FontSizeLevel } from "@/context/FontSizeContext";
import { useLanguage } from "@/context/LanguageContext";
import { usePlatformConfig, useCurrency } from "@/context/PlatformConfigContext";
import { useTheme } from "@/context/ThemeContext";
import { useToast } from "@/context/ToastContext";
import { tDual, type TranslationKey } from "@workspace/i18n";
import { SmartRefresh } from "@/components/ui/SmartRefresh";
import Accordion from "@/components/Accordion";
import { API_BASE as API, unwrapApiResponse } from "@/utils/api";
import {
  KycModal,
  EditProfileModal,
  NotificationsModal,
  PrivacyModal,
  AddressesModal,
} from "@/components/profile";
import { stripPkCode } from "@/components/profile/shared";

function validateMpin(pin: string): string | null {
  if (pin.length !== 4) return "Enter a 4-digit MPIN";
  if (/^(.)\1{3}$/.test(pin)) return "Choose a stronger PIN — avoid sequences and repeated digits.";
  const d = pin.split("").map(Number);
  const isAscending = d[0] + 1 === d[1] && d[1] + 1 === d[2] && d[2] + 1 === d[3];
  const isDescending = d[0] - 1 === d[1] && d[1] - 1 === d[2] && d[2] - 1 === d[3];
  if (isAscending || isDescending) return "Choose a stronger PIN — avoid sequences and repeated digits.";
  const common = ["1234", "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1212", "0123", "9876", "4321"];
  if (common.includes(pin)) return "Choose a stronger PIN — avoid sequences and repeated digits.";
  return null;
}

function ProfileMpinInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const inputRef = useRef<TextInput>(null);
  const { language } = useLanguage();
  const { colors: C } = useTheme();
  const T = (key: TranslationKey) => tDual(key, language);
  useEffect(() => {
    if (!autoFocus) return;
    const task = InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => { inputRef.current?.focus(); });
    });
    return () => task.cancel();
  }, []);
  return (
    <View style={{ alignItems: "center", gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "center" }}>
        {[0, 1, 2, 3].map(i => (
          <View key={i} style={{ width: 48, height: 56, borderRadius: 14, borderWidth: 2, borderColor: value.length > i ? C.primary : C.border, backgroundColor: value.length > i ? C.primarySoft : C.surfaceSecondary, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontFamily: Font.bold, fontSize: 24, color: C.text }}>{value[i] ? "\u25CF" : ""}</Text>
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
        <Text style={{ ...Typ.caption, color: C.primary }}>{T("tapToEnterPin")}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ProfileMpinChangeModal({ token, onClose, onSuccess }: { token: string | null; onClose: () => void; onSuccess: () => void }) {
  const { colors: C } = useTheme();
  const mpinStyles = getMpinStyles(C);
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
      onSuccess();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  if (showForgot) {
    return <ProfileMpinForgotModal token={token} onClose={() => setShowForgot(false)} onReset={() => { setShowForgot(false); onClose(); }} />;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={mpinStyles.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={mpinStyles.sheet} onPress={e => e.stopPropagation()}>
            <View style={mpinStyles.handle} />
            {locked ? (
              <View style={{ alignItems: "center", gap: 12, paddingVertical: 8 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.dangerSoft, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="lock-closed" size={32} color={C.danger} />
                </View>
                <Text style={{ ...Typ.title, color: C.danger }}>MPIN Locked</Text>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", lineHeight: 20 }}>
                  Too many incorrect attempts. Your MPIN has been temporarily locked.
                </Text>
                <View style={{ backgroundColor: C.dangerSoft, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: C.danger + "33" }}>
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
                    <ProfileMpinInput value={oldPin} onChange={setOldPin} autoFocus />
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
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { if (oldPin.length === 4) { setError(""); setStep("new"); } }} disabled={oldPin.length !== 4} style={[mpinStyles.actionBtn, { opacity: oldPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      <Text style={mpinStyles.actionBtnTxt}>Continue</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => setShowForgot(true)} style={{ alignItems: "center", marginTop: 12 }}>
                      <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Forgot MPIN?</Text>
                    </TouchableOpacity>
                  </>
                ) : step === "new" ? (
                  <>
                    <ProfileMpinInput value={newPin} onChange={setNewPin} autoFocus />
                    {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { if (newPin.length === 4) { const e = validateMpin(newPin); if (e) { setError(e); return; } setError(""); setStep("confirm"); } }} disabled={newPin.length !== 4} style={[mpinStyles.actionBtn, { opacity: newPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      <Text style={mpinStyles.actionBtnTxt}>Continue</Text>
                    </TouchableOpacity>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setStep("old"); setNewPin(""); setError(""); }} style={{ alignItems: "center", marginTop: 12 }}>
                      <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>Go Back</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <ProfileMpinInput value={confirmPin} onChange={setConfirmPin} autoFocus />
                    {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                    <TouchableOpacity activeOpacity={0.7} onPress={handleChange} disabled={confirmPin.length !== 4 || loading} style={[mpinStyles.actionBtn, { opacity: confirmPin.length !== 4 ? 0.5 : 1, marginTop: 20 }]}>
                      {loading ? <ActivityIndicator color="#fff" /> : <Text style={mpinStyles.actionBtnTxt}>Change MPIN</Text>}
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

function ProfileMpinForgotModal({ token, onClose, onReset }: { token: string | null; onClose: () => void; onReset: () => void }) {
  const { colors: C } = useTheme();
  const mpinStyles = getMpinStyles(C);
  const [step, setStep] = useState<"request" | "verify">("request");
  const [otp, setOtp] = useState("");
  const [newPin, setNewPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [devOtp, setDevOtp] = useState("");
  const [otpCooldown, setOtpCooldown] = useState(0);

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
    const pinErr = validateMpin(newPin);
    if (pinErr) { setError(pinErr); return; }
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
      onReset();
    } catch { setError("Network error. Try again."); }
    setLoading(false);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={mpinStyles.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ width: "100%" }}>
          <TouchableOpacity activeOpacity={1} style={mpinStyles.sheet} onPress={e => e.stopPropagation()}>
            <View style={mpinStyles.handle} />
            <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.dangerSoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="key" size={28} color={C.danger} />
              </View>
              <Text style={{ ...Typ.title, color: C.text }}>Reset MPIN</Text>
            </View>
            {step === "request" ? (
              <>
                <Text style={{ ...Typ.body, color: C.textSecondary, textAlign: "center", marginBottom: 16 }}>
                  We'll send an OTP to your registered phone number to verify your identity.
                </Text>
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginBottom: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={requestOtp} disabled={loading} style={mpinStyles.actionBtn}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={mpinStyles.actionBtnTxt}>Send OTP</Text>}
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
                <TextInput value={otp} onChangeText={setOtp} placeholder="Enter OTP" keyboardType="number-pad" maxLength={6} style={[mpinStyles.input, { marginBottom: 12 }]} placeholderTextColor={C.textMuted} />
                <Text style={{ ...Typ.captionMedium, color: C.textSecondary, marginBottom: 4 }}>New MPIN</Text>
                <ProfileMpinInput value={newPin} onChange={setNewPin} />
                {!!error && <Text style={{ ...Typ.caption, color: C.danger, textAlign: "center", marginTop: 8 }}>{error}</Text>}
                <TouchableOpacity activeOpacity={0.7} onPress={resetPin} disabled={loading || otp.length < 4 || newPin.length !== 4} style={[mpinStyles.actionBtn, { opacity: otp.length < 4 || newPin.length !== 4 ? 0.5 : 1, marginTop: 16 }]}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={mpinStyles.actionBtnTxt}>Reset MPIN</Text>}
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

function getMpinStyles(C: ReturnType<typeof useTheme>["colors"]) {
  return {
    overlay: { flex: 1, backgroundColor: C.overlayDark50, justifyContent: "flex-end" } as const,
    sheet: { backgroundColor: C.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingBottom: Platform.OS === "web" ? 40 : 48, paddingTop: 12 } as const,
    handle: { width: 40, height: 4, backgroundColor: C.border, borderRadius: 2, alignSelf: "center", marginBottom: 20 } as const,
    actionBtn: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 8, borderRadius: 16, paddingVertical: 16, marginTop: 4, backgroundColor: C.primary } as const,
    actionBtnTxt: { ...Typ.h3, fontSize: 16, color: C.textInverse } as const,
    input: { borderWidth: 1.5, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, ...Typ.body, color: C.text, fontSize: 16, textAlign: "center" as const } as const,
  };
}

function ProfileScreenInner() {
  const insets = useSafeAreaInsets();
  const { user, logout, updateUser, token } = useAuth();
  const { showToast } = useToast();
  const { colors: C } = useTheme();
  const lvl = getLvlStyles(C);
  const kycSt = getKycStyles(C);
  const pi = getPiStyles(C);
  const rc = getRcStyles(C);
  const sec = getSecStyles(C);
  const row = getRowStyles(C);
  const appInfo = getAppInfoStyles(C);
  const signOut = getSignOutStyles(C);
  const dynBtnStyles = getBtnStyles(C);
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const TAB_H  = Platform.OS === "web" ? 72 : 49;

  const { section } = useLocalSearchParams<{ section?: string }>();

  const [showEdit,    setShowEdit]    = useState(false);
  const [showKyc,     setShowKyc]     = useState(false);
  const [showNotifs,  setShowNotifs]  = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showAddrs,   setShowAddrs]   = useState(false);
  const [lastRefreshed,  setLastRefreshed]  = useState<Date | null>(null);
  const [unread,      setUnread]      = useState(0);
  const [stats,       setStats]       = useState({ orders: 0, rides: 0, spent: 0 });
  const [statsLoading,setStatsLoading]= useState(true);
  const [statsError,  setStatsError]  = useState(false);
  const [signingOut,        setSigningOut]        = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showMpinChange,  setShowMpinChange]  = useState(false);
  const [showMpinForgot,  setShowMpinForgot]  = useState(false);
  const [pinSetup,        setPinSetup]        = useState(false);
  const [redeemingLoyalty, setRedeemingLoyalty] = useState(false);
  const [loyaltyPoints, setLoyaltyPoints] = useState<number | null>(null);

  useEffect(() => {
    if (token) {
      fetch(`${API}/wallet`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(unwrapApiResponse)
        .then((d: { pinSetup?: boolean }) => { if (typeof d.pinSetup === "boolean") setPinSetup(d.pinSetup); })
        .catch(() => {});
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetch(`${API}/users/loyalty/balance`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(unwrapApiResponse)
        .then((d: { available?: number; totalEarned?: number }) => {
          const pts = d.available ?? d.totalEarned;
          if (typeof pts === "number") setLoyaltyPoints(pts);
        })
        .catch(() => {});
    }
  }, [token]);

  useEffect(() => {
    if (section === "addresses") {
      setTimeout(() => setShowAddrs(true), 300);
    }
  }, [section]);

  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);

  const { fontSizeLevel, setFontSizeLevel } = useFontSize();
  const { isDark, toggleDarkMode } = useTheme();

  const { config: platformConfig } = usePlatformConfig();
  const { symbol: currencySymbol } = useCurrency();
  const platformCfg = {
    tncUrl:          platformConfig.content.tncUrl,
    privacyUrl:      platformConfig.content.privacyUrl,
    refundPolicyUrl: platformConfig.content.refundPolicyUrl,
    faqUrl:          platformConfig.content.faqUrl,
    aboutUrl:        platformConfig.content.aboutUrl,
    supportMsg:      platformConfig.content.supportMsg,
    supportPhone:    platformConfig.platform.supportPhone,
    supportEmail:    platformConfig.platform.supportEmail,
    supportHours:    platformConfig.platform.supportHours,
    appName:         platformConfig.platform.appName,
    appTagline:      platformConfig.platform.appTagline,
    appVersion:      platformConfig.platform.appVersion,
    businessAddress: platformConfig.platform.businessAddress,
    socialFacebook:  platformConfig.platform.socialFacebook,
    socialInstagram: platformConfig.platform.socialInstagram,
    chat:            platformConfig.features.chat,
    profile:         platformConfig.profile,
  };

  const fetchAll = useCallback(async () => {
    if (!user?.id) return;
    const hdrs: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const [oR, rR, nR, phR, parR] = await Promise.all([
          fetch(`${API}/orders`,            { headers: hdrs }),
          fetch(`${API}/rides`,             { headers: hdrs }),
          fetch(`${API}/notifications`,     { headers: hdrs }),
          fetch(`${API}/pharmacy-orders`,   { headers: hdrs }),
          fetch(`${API}/parcel-bookings`,   { headers: hdrs }),
        ]);
        type ProfileOrderRow = { status?: string; total?: number | string; fare?: number | string; price?: number | string };
        const [oD, rD, nD, phD, parD] = await Promise.all([
          oR.json().then(j => unwrapApiResponse<{ orders?: ProfileOrderRow[] }>(j)),
          rR.json().then(j => unwrapApiResponse<{ rides?: ProfileOrderRow[] }>(j)),
          nR.json().then(j => unwrapApiResponse<{ unreadCount?: number }>(j)),
          phR.json().then(j => unwrapApiResponse<{ orders?: ProfileOrderRow[]; pharmacyOrders?: ProfileOrderRow[] }>(j)).catch(() => ({} as { orders?: ProfileOrderRow[]; pharmacyOrders?: ProfileOrderRow[] })),
          parR.json().then(j => unwrapApiResponse<{ bookings?: ProfileOrderRow[]; parcelBookings?: ProfileOrderRow[] }>(j)).catch(() => ({} as { bookings?: ProfileOrderRow[]; parcelBookings?: ProfileOrderRow[] })),
        ]);
        const orders   = oD.orders   || [];
        const rides    = rD.rides    || [];
        const pharmacy = phD.orders  || phD.pharmacyOrders  || [];
        const parcels  = parD.bookings || parD.parcelBookings || [];

        const CANCELLED = "cancelled";
        const activeOrders   = orders.filter(o   => o.status   !== CANCELLED);
        const activeRides    = rides.filter(r    => r.status   !== CANCELLED);
        const activePharmacy = pharmacy.filter(p => p.status   !== CANCELLED);
        const activeParcels  = parcels.filter(p  => p.status   !== CANCELLED);

        const spent = activeOrders.reduce((s, o)   => s + (parseFloat(String(o.total ?? "")) || 0), 0)
                    + activeRides.reduce((s,  r)   => s + (parseFloat(String(r.fare  ?? "")) || 0), 0)
                    + activePharmacy.reduce((s, p) => s + (parseFloat(String(p.total ?? "")) || 0), 0)
                    + activeParcels.reduce((s,  p) => s + (parseFloat(String(p.price ?? p.fare ?? p.total ?? "")) || 0), 0);

        setStats({ orders: activeOrders.length + activePharmacy.length + activeParcels.length, rides: activeRides.length, spent: Math.round(spent) });
        setUnread(nD.unreadCount || 0);
        setStatsError(false);
        break;
      } catch (err) {
        if (__DEV__) console.warn(`[Profile] fetchAll attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
        if (attempt < maxAttempts) {
          await new Promise<void>((res) => setTimeout(res, 1500 * attempt));
        } else {
          setStatsError(true);
        }
      }
    }
    setStatsLoading(false);
  }, [user?.id, token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setStatsLoading(true);
    await fetchAll();
    setLastRefreshed(new Date());
  }, [fetchAll]);

  const doSignOut = async () => {
    setSigningOut(true);
    setShowSignOutConfirm(false);
    try { await logout(); } catch { setSigningOut(false); }
  };

  const roleMap: Record<string, { label: string; colors: [string, string] }> = {
    customer: { label: "Customer",        colors: [C.primaryDark, C.primary] },
    rider:    { label: "Delivery Rider",  colors: [C.primaryDark, C.primary] },
    vendor:   { label: "Store Vendor",    colors: [C.primaryDark, C.primary] },
  };
  const role = roleMap[(user?.roles ?? [])[0] || "customer"] || roleMap.customer!;
  const initials = user?.name
    ? user.name.split(" ").map(w => w?.[0] ?? "").slice(0, 2).join("").toUpperCase()
    : user?.phone?.slice(-2) || "U";

  const LEVEL_CONFIG: Record<string, { color: string; bg: string; icon: keyof typeof Ionicons.glyphMap; label: string }> = {
    bronze: { color: C.bronzeAccent, bg: C.peachBg, icon: "shield-outline", label: "Bronze" },
    silver: { color: C.neutralGray, bg: C.silverGray, icon: "shield-half-outline", label: "Silver" },
    gold:   { color: C.goldBright, bg: C.yellowWarm, icon: "shield-checkmark-outline", label: "Gold" },
  };
  const accountLevel = user?.accountLevel || "bronze";
  const levelInfo = LEVEL_CONFIG[accountLevel] || LEVEL_CONFIG.bronze!;

  const profileFields = [
    { filled: !!user?.name, label: "Name" },
    { filled: !!user?.email, label: "Email" },
    { filled: !!user?.city, label: "City" },
    { filled: !!user?.address, label: "Address" },
    { filled: !!user?.cnic, label: "CNIC" },
    { filled: !!user?.hasPassword, label: "Password" },
  ];
  const filledCount = profileFields.filter(f => f.filled).length;
  const completionPct = Math.round((filledCount / profileFields.length) * 100);

  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={sec.wrap}>
      <Text style={sec.title}>{title}</Text>
      <View style={sec.card}>{children}</View>
    </View>
  );

  const Row = ({ icon, label, sub, onPress, iconColor = C.primary, iconBg = C.primarySoft, right, danger, badge }: {
    icon: keyof typeof Ionicons.glyphMap; label: string; sub?: string; onPress: () => void;
    iconColor?: string; iconBg?: string; right?: React.ReactNode; danger?: boolean; badge?: number;
  }) => (
    <TouchableOpacity activeOpacity={0.65} onPress={onPress} style={row.wrap} accessibilityRole="button" accessibilityLabel={`${label}${sub ? `, ${sub}` : ""}${badge && badge > 0 ? `, ${badge} new` : ""}`}>
      <View style={[row.icon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[row.label, danger && { color: C.danger }]}>{label}</Text>
        {sub ? <Text style={row.sub}>{sub}</Text> : null}
      </View>
      {badge && badge > 0 ? <View style={row.badge}><Text style={row.badgeTxt}>{badge > 99 ? "99+" : badge}</Text></View> : null}
      {right ?? <Ionicons name="chevron-forward" size={15} color={C.textMuted} />}
    </TouchableOpacity>
  );

  if (!user?.id) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingTop: topPad }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <Ionicons name="person-outline" size={32} color={C.primary} />
        </View>
        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 20, color: C.text, textAlign: "center", marginBottom: 8 }}>{T("signInToContinue")}</Text>
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22, marginBottom: 28 }}>
          {T("signInProfileSub")}
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={async () => {
            await AsyncStorage.setItem("@ajkmart_auth_return_to", "/(tabs)/profile");
            router.push("/auth");
          }}
          style={{ backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32, width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Sign In or Register"
        >
          <Ionicons name="person-circle-outline" size={18} color="#fff" />
          <Text style={{ fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff" }}>{T("signInRegister")}</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} onPress={() => router.back()} style={{ paddingVertical: 12 }} accessibilityRole="button">
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: C.textMuted }}>{T("continueBrowsing")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <SmartRefresh
        onRefresh={onRefresh}
        lastUpdated={lastRefreshed}
        showsVerticalScrollIndicator={false}
      >
        <LinearGradient colors={[C.primaryDark, C.primary, C.primaryLight]} start={{ x:0,y:0 }} end={{ x:1,y:1 }} style={[ph.card, { paddingTop: topPad + spacing.xl }]}>
          <View style={[ph.blob, { width: 220, height: 220, top: -80, right: -60, opacity: 0.12 }]} />
          <View style={[ph.blob, { width: 120, height: 120, top: 20, left: -40, opacity: 0.08 }]} />
          <View style={[ph.blob, { width: 80,  height: 80,  bottom: 20, right: 40, opacity: 0.1 }]} />

          <TouchableOpacity activeOpacity={0.7} onPress={() => setShowEdit(true)} style={ph.editBtn} accessibilityRole="button" accessibilityLabel="Edit profile">
            <Ionicons name="pencil" size={16} color="#fff" />
          </TouchableOpacity>

          <View style={{ alignItems: "center", marginBottom: spacing.lg }}>
            <View style={ph.avatarRing}>
              <View style={ph.avatar}>
                {user?.avatar
                  ? <Image
                      source={{ uri: user?.avatar?.startsWith("/") ? `${API.replace(/\/api$/, "")}${user?.avatar}` : user?.avatar }}
                      style={{ width: 80, height: 80, borderRadius: 40 }}
                    />
                  : <Text style={ph.avatarTxt}>{initials}</Text>}
              </View>
            </View>
            <Text style={ph.name}>{user?.name || "AJKMart User"}</Text>
            <Text style={ph.phone}>{user?.phone ? `+92 ${stripPkCode(user.phone)}` : user?.email || "—"}</Text>
            {user?.username ? (
              <Text style={ph.handle}>@{user?.username}</Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: spacing.sm }}>
              <View style={[ph.roleBadge, { backgroundColor: levelInfo.bg + "33", borderColor: levelInfo.color + "55" }]}>
                <Ionicons name={levelInfo.icon} size={11} color={levelInfo.color} />
                <Text style={[ph.roleTxt, { color: levelInfo.color }]}>{levelInfo.label} Member</Text>
              </View>
              {user?.kycStatus === "verified" ? (
                <View style={[ph.roleBadge, { backgroundColor: C.success + "22", borderColor: C.success + "44" }]}>
                  <Ionicons name="checkmark-circle" size={11} color={C.success} />
                  <Text style={[ph.roleTxt, { color: C.success }]}>Verified</Text>
                </View>
              ) : (
                <View style={[ph.roleBadge, { backgroundColor: "rgba(255,255,255,0.15)", borderColor: "rgba(255,255,255,0.25)" }]}>
                  <Ionicons name="shield-outline" size={11} color="rgba(255,255,255,0.8)" />
                  <Text style={[ph.roleTxt, { color: "rgba(255,255,255,0.8)" }]}>Member</Text>
                </View>
              )}
            </View>
          </View>

          <View style={ph.statsStrip}>
            {statsLoading ? (
              <ActivityIndicator color="rgba(255,255,255,0.8)" style={{ paddingVertical: 4 }} />
            ) : statsError ? (
              <TouchableOpacity activeOpacity={0.7} onPress={() => { setStatsLoading(true); setStatsError(false); fetchAll(); }} style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Could not load stats, tap to retry">
                <Ionicons name="refresh-outline" size={16} color="rgba(255,255,255,0.8)" />
                <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.8)" }}>Tap to retry</Text>
              </TouchableOpacity>
            ) : (
              <>
                <View style={ph.stat}>
                  <Text style={ph.statVal}>{stats.orders}</Text>
                  <Text style={ph.statLbl}>{T("orders")}</Text>
                </View>
                <View style={ph.statDiv} />
                <View style={ph.stat}>
                  <Text style={ph.statVal}>{stats.rides}</Text>
                  <Text style={ph.statLbl}>{T("rides")}</Text>
                </View>
                <View style={ph.statDiv} />
                <View style={ph.stat}>
                  <Text style={ph.statVal}>{currencySymbol}{stats.spent.toLocaleString()}</Text>
                  <Text style={ph.statLbl}>{T("spentLabel")}</Text>
                </View>
              </>
            )}
          </View>
        </LinearGradient>

        <View style={lvl.strip}>
          <View style={[lvl.badge, { backgroundColor: levelInfo.bg, borderColor: levelInfo.color }]}>
            <Ionicons name={levelInfo.icon} size={16} color={levelInfo.color} />
            <Text style={[lvl.badgeTxt, { color: levelInfo.color }]}>{levelInfo.label}</Text>
          </View>
          <View style={lvl.progressWrap}>
            <View style={lvl.progressRow}>
              <Text style={lvl.progressLabel}>Profile {completionPct}%</Text>
              <Text style={lvl.progressCount}>{filledCount}/{profileFields.length}</Text>
            </View>
            <View style={lvl.progressBar}>
              <View style={[lvl.progressFill, { width: `${completionPct}%`, backgroundColor: completionPct === 100 ? C.success : C.primary }]} />
            </View>
            {completionPct < 100 && (
              <Text style={lvl.progressHint}>
                Add {profileFields.filter(f => !f.filled).map(f => f.label).join(", ")} to level up
              </Text>
            )}
          </View>
        </View>

        {user?.kycStatus !== "verified" && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setShowKyc(true)} style={kycSt.wrap} accessibilityRole="button" accessibilityLabel="Complete KYC verification">
            <View style={kycSt.iconWrap}>
              <Ionicons name="document-text-outline" size={20} color={user?.kycStatus === "pending" ? C.accent : C.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={kycSt.title}>
                {user?.kycStatus === "pending" ? "KYC Under Review" : "Complete KYC Verification"}
              </Text>
              <Text style={kycSt.sub}>
                {user?.kycStatus === "pending"
                  ? "Your CNIC is being verified — you'll be notified"
                  : "Add your CNIC to unlock Gold account & higher limits"}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
          </TouchableOpacity>
        )}

        {(user?.username || user?.city || user?.area || user?.address || user?.latitude) && (
          <View style={pi.wrap}>
            <Text style={sec.title}>PERSONAL INFO</Text>
            <View style={pi.card}>
              {user?.username && (
                <View style={pi.row}>
                  <View style={[pi.iconWrap, { backgroundColor: C.primarySoft }]}><Ionicons name="at-outline" size={16} color={C.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>Username</Text>
                    <Text style={pi.value}>@{user?.username}</Text>
                  </View>
                </View>
              )}
              {user?.city && (
                <View style={pi.row}>
                  <View style={[pi.iconWrap, { backgroundColor: C.successSoft }]}><Ionicons name="business-outline" size={16} color={C.success} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>City</Text>
                    <Text style={pi.value}>{user?.city}</Text>
                  </View>
                </View>
              )}
              {user?.area && (
                <View style={pi.row}>
                  <View style={[pi.iconWrap, { backgroundColor: C.infoSoft }]}><Ionicons name="map-outline" size={16} color={C.info} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>Area / Locality</Text>
                    <Text style={pi.value}>{user?.area}</Text>
                  </View>
                </View>
              )}
              {user?.address && (
                <View style={pi.row}>
                  <View style={[pi.iconWrap, { backgroundColor: C.accentSoft }]}><Ionicons name="home-outline" size={16} color={C.accent} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>Address</Text>
                    <Text style={pi.value}>{user?.address}</Text>
                  </View>
                </View>
              )}
              {user?.latitude && user?.longitude && (
                <View style={pi.row}>
                  <View style={[pi.iconWrap, { backgroundColor: C.successSoft }]}><Ionicons name="navigate-outline" size={16} color={C.success} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>GPS Location</Text>
                    <Text style={pi.value}>{user?.latitude}, {user?.longitude}</Text>
                  </View>
                </View>
              )}
              {user?.cnic && (
                <View style={[pi.row, { borderBottomWidth: 0 }]}>
                  <View style={[pi.iconWrap, { backgroundColor: C.amberSoft }]}><Ionicons name="card-outline" size={16} color={C.accent} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={pi.label}>CNIC</Text>
                    <Text style={pi.value}>{user?.cnic?.replace(/(\d{5})(\d{7})(\d{1})/, "$1-$2-$3")}</Text>
                  </View>
                  {user?.kycStatus === "verified" && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: C.successSoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.full }}>
                      <Ionicons name="checkmark-circle" size={12} color={C.success} />
                      <Text style={{ ...typography.smallMedium, color: C.success }}>Verified</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
          </View>
        )}

        {platformConfig.features.referral && platformConfig.customer.referralEnabled && (
          <View style={rc.wrap}>
            <View style={rc.left}>
              <View style={rc.iconBox}>
                <Ionicons name="gift-outline" size={22} color={C.info} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={rc.title}>{T("referAndEarn")}</Text>
                <Text style={rc.sub}>Invite a friend — both of you get {currencySymbol} {platformConfig.customer.referralBonus.toLocaleString()}</Text>
                <View style={rc.codeRow}>
                  <Text style={rc.codeLabel}>Your Code:</Text>
                  <View style={rc.codePill}>
                    <Text style={rc.code}>{user?.id?.slice(-8).toUpperCase() ?? "AJKXXXX"}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                  <TouchableOpacity
                    activeOpacity={0.75}
                    style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: C.primarySoft, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: C.primary + "44" }}
                    onPress={async () => {
                      const code = user?.id?.slice(-8).toUpperCase() ?? "AJKXXXX";
                      await Clipboard.setStringAsync(code);
                      showToast("Referral code copied!", "success");
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Copy referral code"
                  >
                    <Ionicons name="copy-outline" size={14} color={C.primary} />
                    <Text style={{ fontFamily: Font.semiBold, fontSize: 12, color: C.primary }}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.75}
                    style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: C.infoSoft, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: C.info + "44" }}
                    onPress={async () => {
                      const code = user?.id?.slice(-8).toUpperCase() ?? "AJKXXXX";
                      const appName = platformConfig.platform.appName || "AJKMart";
                      const bonus = platformConfig.customer.referralBonus;
                      try {
                        await Share.share({
                          message: `Join ${appName} using my referral code ${code} and we both get ${currencySymbol} ${bonus} bonus! Download the app now.`,
                          title: `Join ${appName}`,
                        });
                      } catch {}
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Share referral code"
                  >
                    <Ionicons name="share-social-outline" size={14} color={C.info} />
                    <Text style={{ fontFamily: Font.semiBold, fontSize: 12, color: C.info }}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        )}

        {platformConfig.customer.loyaltyEnabled && (
          <View style={[rc.wrap, { borderColor: C.goldAlpha, backgroundColor: C.accentSoft }]}>
            <View style={rc.left}>
              <View style={[rc.iconBox, { backgroundColor: C.amberSoft }]}>
                <Ionicons name="star-outline" size={22} color={C.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={rc.title}>{T("loyaltyPointsLabel")}</Text>
                <Text style={rc.sub}>Earn {platformConfig.customer.loyaltyPtsPerRs100} points for every {currencySymbol} 100 spent</Text>
                <View style={rc.codeRow}>
                  <Text style={rc.codeLabel}>Available:</Text>
                  <View style={[rc.codePill, { backgroundColor: C.amberBorder }]}>
                    <Text style={[rc.code, { color: C.amberDark }]}>{loyaltyPoints ?? "—"} pts</Text>
                  </View>
                </View>
                <TouchableOpacity
                  activeOpacity={0.75}
                  disabled={redeemingLoyalty || (loyaltyPoints ?? 0) < platformConfig.customer.loyaltyMin}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: (loyaltyPoints ?? 0) >= platformConfig.customer.loyaltyMin ? C.amberBorder : C.surfaceSecondary, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 7, marginTop: 10, borderWidth: 1, borderColor: (loyaltyPoints ?? 0) >= platformConfig.customer.loyaltyMin ? C.accent + "44" : C.border }}
                  onPress={async () => {
                    if (!token) { showToast("Please sign in to redeem points", "error"); return; }
                    setRedeemingLoyalty(true);
                    try {
                      const res = await fetch(`${API}/users/loyalty/redeem`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                      });
                      const data = await res.json();
                      if (!res.ok) { showToast(data?.error || "Could not redeem points. Try again.", "error"); return; }
                      const redeemed = data?.data?.redeemed ?? data?.redeemed ?? 0;
                      showToast(`${currencySymbol} ${redeemed} added to your wallet from loyalty points!`, "success");
                      if (updateUser && data?.data?.newBalance !== undefined) {
                        updateUser({ walletBalance: data.data.newBalance });
                      }
                      setLoyaltyPoints(0);
                    } catch { showToast("Network error. Please try again.", "error"); }
                    finally { setRedeemingLoyalty(false); }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Redeem loyalty points"
                >
                  {redeemingLoyalty ? (
                    <ActivityIndicator size="small" color={C.amberDark} />
                  ) : (
                    <Ionicons name="gift-outline" size={14} color={(loyaltyPoints ?? 0) >= platformConfig.customer.loyaltyMin ? C.amberDark : C.textMuted} />
                  )}
                  <Text style={{ fontFamily: Font.semiBold, fontSize: 12, color: (loyaltyPoints ?? 0) >= platformConfig.customer.loyaltyMin ? C.amberDark : C.textMuted }}>
                    {(loyaltyPoints ?? 0) >= platformConfig.customer.loyaltyMin ? `Redeem ${loyaltyPoints} pts` : `Need ${platformConfig.customer.loyaltyMin}+ pts to redeem`}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        <SectionCard title={T("account")}>
          <Row icon="person-outline"          label={T("editProfile")}       sub={T("editProfileSub")}            onPress={() => setShowEdit(true)} />
          <Row icon="notifications-outline"   label={T("notifications")}      sub={unread > 0 ? `${unread} ${T("notificationsSub")}` : T("noNewNotifs")} badge={unread} onPress={() => setShowNotifs(true)} iconColor={C.accent} iconBg={C.accentSoft} />
          <Row icon="shield-checkmark-outline" label={T("privacySecurity")} sub="Toggles, biometric, location"       onPress={() => setShowPrivacy(true)} iconColor={C.success} iconBg={C.successSoft}
            right={<View style={{ flexDirection:"row", alignItems:"center", gap:4 }}><View style={sec.secureBadge}><Text style={sec.secureTxt}>Secure</Text></View><Ionicons name="chevron-forward" size={15} color={C.textMuted} /></View>}
          />
        </SectionCard>

        <View style={[sec.wrap]}>
          <Text style={sec.title}>DISPLAY & ACCESSIBILITY</Text>
          <View style={sec.card}>
            <View style={[row.wrap, { borderBottomWidth: 1, borderBottomColor: C.borderLight }]} accessible accessibilityLabel="Dark Mode">
              <View style={[row.icon, { backgroundColor: isDark ? C.infoSoft : C.surfaceSecondary }]}>
                <Ionicons name={isDark ? "moon" : "moon-outline"} size={18} color={isDark ? C.info : C.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={row.label}>Dark Mode</Text>
                <Text style={row.sub}>{isDark ? "Dark theme active" : "Light theme active"}</Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={toggleDarkMode}
                trackColor={{ false: C.border, true: C.primary + "88" }}
                thumbColor={isDark ? C.primary : C.textMuted}
                accessibilityLabel="Toggle dark mode"
                accessibilityRole="switch"
              />
            </View>
            <View style={[row.wrap, { borderBottomWidth: 0 }]} accessible accessibilityLabel="Font Size">
              <View style={[row.icon, { backgroundColor: C.primarySoft }]}>
                <Ionicons name="text-outline" size={18} color={C.primary} />
              </View>
              <View style={{ flex: 1, gap: 8 }}>
                <Text style={row.label}>Font Size</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["small", "medium", "large"] as FontSizeLevel[]).map((level) => (
                    <TouchableOpacity
                      key={level}
                      onPress={() => setFontSizeLevel(level)}
                      style={{
                        flex: 1,
                        paddingVertical: 7,
                        borderRadius: radii.md,
                        borderWidth: 1.5,
                        borderColor: fontSizeLevel === level ? C.primary : C.border,
                        backgroundColor: fontSizeLevel === level ? C.primarySoft : C.surfaceSecondary,
                        alignItems: "center",
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Font size ${level}`}
                      accessibilityState={{ selected: fontSizeLevel === level }}
                    >
                      <Text style={{ fontFamily: Font.semiBold, fontSize: 12, color: fontSizeLevel === level ? C.primary : C.textSecondary, textTransform: "capitalize" }}>
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </View>
        </View>

        {hasRole(user ?? null, "customer") && (
          <SectionCard title="Wallet">
            <Row icon="wallet-outline" label="My Wallet" sub="View balance & transactions" onPress={() => router.push("/(tabs)/wallet")} iconColor={C.primary} iconBg={C.primarySoft} />
            {pinSetup ? (
              <Row icon="key-outline" label="Change MPIN" sub="Update your wallet PIN" onPress={() => setShowMpinChange(true)} iconColor={C.accent} iconBg={C.accentSoft} />
            ) : (
              <Row icon="lock-closed-outline" label="Set Up MPIN" sub="Secure your wallet transactions" onPress={() => router.push("/(tabs)/wallet")} iconColor={C.accent} iconBg={C.accentSoft} />
            )}
            <Row icon="refresh-outline" label="Forgot MPIN" sub="Reset via OTP verification" onPress={() => setShowMpinForgot(true)} iconColor={C.danger} iconBg={C.dangerSoft} />
          </SectionCard>
        )}

        <SectionCard title={T("myActivity")}>
          <Row icon="bag-outline"      label={T("myOrders")}        sub={`${stats.orders} ${T("ordersCount")}`}       onPress={() => router.push("/(tabs)/orders")}  iconColor={C.primary} iconBg={C.primarySoft} />
          <Row icon="bicycle-outline"  label={T("rides")}         sub={`${stats.rides} ${T("ridesCount")}`}          onPress={() => router.push("/ride")}            iconColor={C.info}   iconBg={C.infoSoft} />
          <Row icon="medkit-outline"   label={T("pharmacy")}         sub={T("medicineOrderHistory")}               onPress={() => router.push("/pharmacy")}        iconColor={C.pharmacy}   iconBg={C.pharmacyLight} />
          <Row icon="cube-outline"     label={T("parcelBookings")}  sub={T("courierHistory")}             onPress={() => router.push("/parcel")}          iconColor={C.parcel}   iconBg={C.parcelLight} />
          <Row icon="heart-outline"    label="My Wishlist"          sub="Saved favorites"                 onPress={() => router.push("/wishlist")}         iconColor={C.danger}  iconBg={C.dangerSoft} />
          <Row icon="star-outline"     label={T("myReviews")}       sub={T("customerFeedback")}           onPress={() => router.push("/my-reviews")}      iconColor={C.gold}    iconBg={C.amberBg} />
          <Row icon="time-outline"     label="Recently Viewed"      sub="Products you browsed"            onPress={() => router.push("/recently-viewed")}   iconColor={C.info}    iconBg={C.infoSoft} />
          {platformCfg.profile?.showSavedAddresses !== false && (
            <Row icon="location-outline" label={T("savedAddresses")}  sub={T("savedAddressesSub")}    onPress={() => setShowAddrs(true)}              iconColor={C.mart}    iconBg={C.martLight} />
          )}
        </SectionCard>

        {(user?.roles ?? []).includes("vendor") && (
          <SectionCard title="VENDOR DASHBOARD">
            <Row icon="storefront-outline" label="My Products"     sub="Manage products"       onPress={() => Linking.openURL(`https://${process.env.EXPO_PUBLIC_DOMAIN}/vendor/products`)} iconColor={C.mart} iconBg={C.martLight} />
            <Row icon="analytics-outline"  label="Sales Analytics" sub="Revenue & sales"     onPress={() => Linking.openURL(`https://${process.env.EXPO_PUBLIC_DOMAIN}/vendor/analytics`)}           iconColor={C.primary} iconBg={C.primarySoft} />
            <Row icon="receipt-outline"    label="Incoming Orders" sub="View new orders"     onPress={() => Linking.openURL(`https://${process.env.EXPO_PUBLIC_DOMAIN}/vendor/orders`)}    iconColor={C.accent} iconBg={C.accentSoft} />
          </SectionCard>
        )}

        <View style={[sec.wrap, { overflow: "hidden" }]}>
          <Accordion
            title={T("helpSupport")}
            icon="help-buoy-outline"
            iconColor={C.info}
            iconBg={C.infoSoft}
            headerStyle={{ paddingHorizontal: spacing.lg }}
          >
            <Row icon="call-outline"
                 label={T("contactSupport")}
                 sub={platformCfg.supportHours || `Call: ${platformCfg.supportPhone}`}
                 onPress={() => Linking.openURL(`tel:${platformCfg.supportPhone}`).catch(() => showToast(`📞 ${platformCfg.supportPhone}`, "info"))}
                 iconColor={C.textSecondary} iconBg={C.surfaceSecondary} />
            {platformCfg.supportEmail ? (
              <Row icon="mail-outline"
                   label={T("emailSupport")}
                   sub={platformCfg.supportEmail}
                   onPress={() => Linking.openURL(`mailto:${platformCfg.supportEmail}`).catch(() => showToast(platformCfg.supportEmail, "info"))}
                   iconColor={C.info} iconBg={C.infoSoft} />
            ) : null}
            {platformCfg.chat && (
              <Row icon="chatbubble-ellipses-outline"
                   label={T("liveChatLabel")}
                   sub={platformCfg.supportMsg}
                   onPress={() => router.push("/chat/support")}
                   iconColor={C.primary} iconBg={C.primarySoft} />
            )}
            {(platformCfg.socialFacebook || platformCfg.socialInstagram) && (
              <Row icon="share-social-outline"
                   label={T("followUsLabel")}
                   sub={[platformCfg.socialFacebook && "Facebook", platformCfg.socialInstagram && "Instagram"].filter(Boolean).join(" • ")}
                   onPress={() => Linking.openURL(platformCfg.socialFacebook || platformCfg.socialInstagram).catch(() => showToast("Could not open link", "error"))}
                   iconColor={C.facebookBlue} iconBg={C.primarySoft} />
            )}
            {platformCfg.tncUrl ? (
              <Row icon="document-text-outline"
                   label={T("termsOfService")}
                   sub={T("termsSubLabel")}
                   onPress={() => Linking.openURL(platformCfg.tncUrl).catch(() => showToast("Could not open link", "error"))}
                   iconColor={C.textSecondary} iconBg={C.surfaceSecondary} />
            ) : null}
            {platformCfg.privacyUrl && (
              <Row icon="shield-checkmark-outline"
                   label={T("privacyPolicy")}
                   sub={T("privacySubLabel")}
                   onPress={() => Linking.openURL(platformCfg.privacyUrl).catch(() => {})}
                   iconColor={C.primary} iconBg={C.primarySoft} />
            )}
            {platformCfg.refundPolicyUrl && (
              <Row icon="return-down-back-outline"
                   label={T("refundPolicy")}
                   sub={T("refundSubLabel")}
                   onPress={() => Linking.openURL(platformCfg.refundPolicyUrl).catch(() => {})}
                   iconColor={C.success} iconBg={C.successSoft} />
            )}
            <Row icon="help-circle-outline"
                 label={T("helpFaqsLabel")}
                 sub={T("faqSubLabel")}
                 onPress={() => router.push("/help/faq")}
                 iconColor={C.info} iconBg={C.infoSoft} />
            <Row icon="star-outline"
                 label="Rate the App"
                 sub="Love us? Share your feedback!"
                 onPress={async () => {
                   try {
                     const available = await StoreReview.isAvailableAsync();
                     if (available && Platform.OS !== "web") {
                       await StoreReview.requestReview();
                       return;
                     }
                   } catch {}
                   router.push("/rate-app");
                 }}
                 iconColor={C.gold} iconBg={C.amberBg} />
            {platformCfg.aboutUrl && (
              <Row icon="information-circle-outline"
                   label={T("aboutUsLabel")}
                   sub={`${platformCfg.appName} ${T("aboutSubLabel")}`}
                   onPress={() => Linking.openURL(platformCfg.aboutUrl).catch(() => {})}
                   iconColor={C.parcel} iconBg={C.parcelLight} />
            )}
          </Accordion>
        </View>

        <View style={appInfo.wrap}>
          <View style={appInfo.logo}><Ionicons name="storefront" size={26} color={C.primary} /></View>
          <Text style={appInfo.name}>{platformCfg.appName}</Text>
          <Text style={appInfo.version}>v{platformCfg.appVersion} • {platformCfg.businessAddress}</Text>
        </View>

        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: 40 }}>
          {showSignOutConfirm ? (
            <View style={signOut.confirmBox}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: spacing.md }}>
                <View style={{ width: 38, height: 38, borderRadius: radii.md, backgroundColor: C.dangerSoft, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="log-out-outline" size={18} color={C.danger} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={signOut.confirmTitle}>{T("signOutConfirm")}</Text>
                  <Text style={signOut.confirmSub}>{T("signOutMsg")}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowSignOutConfirm(false)} style={dynBtnStyles.cancel} accessibilityRole="button" accessibilityLabel={T("cancelNo")}>
                  <Text style={dynBtnStyles.cancelTxt}>{T("cancelNo")}</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} onPress={doSignOut} disabled={signingOut} style={[dynBtnStyles.save, { backgroundColor: C.danger }, signingOut && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={T("signOutYes")}>
                  {signingOut ? <ActivityIndicator color={C.textInverse} size="small" /> : <Text style={dynBtnStyles.saveTxt}>{T("signOutYes")}</Text>}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity activeOpacity={0.7} onPress={() => setShowSignOutConfirm(true)} style={signOut.btn} accessibilityRole="button" accessibilityLabel={T("signOutLabel")}>
              <Ionicons name="log-out-outline" size={20} color={C.danger} />
              <Text style={signOut.txt}>{T("signOutLabel")}</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={{ height: TAB_H + insets.bottom + 20 }} />
      </SmartRefresh>

      <EditProfileModal visible={showEdit} onClose={() => setShowEdit(false)} />
      <KycModal         visible={showKyc}  onClose={() => setShowKyc(false)} />
      <NotificationsModal visible={showNotifs} userId={user?.id || ""} token={token ?? undefined} onClose={count => { setUnread(count); setShowNotifs(false); }} />
      <PrivacyModal       visible={showPrivacy} userId={user?.id || ""} token={token ?? undefined} onClose={() => setShowPrivacy(false)} />
      <AddressesModal     visible={showAddrs}  userId={user?.id || ""} token={token ?? undefined} onClose={() => setShowAddrs(false)} />

      {showMpinChange && (
        <ProfileMpinChangeModal
          token={token}
          onClose={() => setShowMpinChange(false)}
          onSuccess={() => { setShowMpinChange(false); showToast("MPIN changed successfully!", "success"); }}
        />
      )}

      {showMpinForgot && (
        <ProfileMpinForgotModal
          token={token}
          onClose={() => setShowMpinForgot(false)}
          onReset={() => { setShowMpinForgot(false); setPinSetup(true); showToast("MPIN reset successfully!", "success"); }}
        />
      )}

    </View>
  );
}

export default withErrorBoundary(ProfileScreenInner);

const ph = StyleSheet.create({
  card: { paddingHorizontal: spacing.lg, paddingBottom: 0, overflow: "hidden" },
  blob: { position: "absolute", borderRadius: 999, backgroundColor: "#fff" },
  avatarRing: { width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(255,255,255,0.25)", alignItems: "center", justifyContent: "center", marginBottom: spacing.md, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", ...shadows.lg },
  avatar: { width: 84, height: 84, borderRadius: 42, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  avatarTxt: { fontFamily: Font.bold, fontSize: 30, color: "#fff" },
  name: { fontFamily: Font.bold, fontSize: 20, color: "#fff", marginBottom: 3, textAlign: "center" },
  phone: { ...typography.captionMedium, color: "rgba(255,255,255,0.85)", textAlign: "center" },
  handle: { ...typography.caption, color: "rgba(255,255,255,0.7)", marginTop: 2, textAlign: "center" },
  roleBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.2)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.full, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  roleTxt: { ...typography.smallMedium, color: "#fff", fontSize: 11 },
  editBtn: { position: "absolute", top: 0, right: 0, width: 38, height: 38, borderRadius: radii.md, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  statsStrip: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(0,0,0,0.15)", borderRadius: radii.xl, marginTop: spacing.sm, marginBottom: spacing.lg, paddingVertical: spacing.md },
  stat: { flex: 1, alignItems: "center" },
  statVal: { fontFamily: Font.bold, fontSize: 17, color: "#fff" },
  statLbl: { ...typography.small, color: "rgba(255,255,255,0.75)", marginTop: 2 },
  statDiv: { width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.25)" },
});

const wb = StyleSheet.create({
  wrap: { marginHorizontal: spacing.lg, marginTop: spacing.lg, borderRadius: radii.xl, overflow: "hidden", ...shadows.md },
  grad: { flexDirection: "row", alignItems: "center", padding: spacing.lg, paddingVertical: 20 },
  iconBox: { width: 48, height: 48, borderRadius: radii.lg, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginRight: spacing.md, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  lbl: { ...typography.caption, color: "rgba(255,255,255,0.8)", marginBottom: 2 },
  amt: { fontFamily: Font.bold, fontSize: 22, color: "#fff" },
  btn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.2)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.full, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  btnTxt: { ...typography.captionMedium, color: "#fff" },
});

type ProfileColors = ReturnType<typeof useTheme>["colors"];

function getLvlStyles(C: ProfileColors) {
  return {
    strip: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.md, backgroundColor: C.surface, borderRadius: radii.xl, padding: spacing.md, borderWidth: 1, borderColor: C.borderLight, ...shadows.sm },
    badge: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.full, borderWidth: 1.5 },
    badgeTxt: { ...Typ.captionBold },
    progressWrap: { flex: 1 },
    progressRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginBottom: 5 },
    progressLabel: { ...typography.captionMedium, color: C.text },
    progressCount: { fontFamily: Font.bold, fontSize: 12, color: C.primary },
    progressBar: { height: 7, backgroundColor: C.surfaceSecondary, borderRadius: 4, overflow: "hidden" as const },
    progressFill: { height: 7, borderRadius: 4 },
    progressHint: { ...typography.small, color: C.textMuted, marginTop: 4 },
  };
}

function getKycStyles(C: ProfileColors) {
  return {
    wrap: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.sm, backgroundColor: C.primarySoft, borderRadius: radii.xl, padding: spacing.lg, borderWidth: 1, borderColor: `${C.primary}30` },
    iconWrap: { width: 40, height: 40, borderRadius: radii.md, backgroundColor: C.surface, alignItems: "center" as const, justifyContent: "center" as const },
    title: { ...typography.subtitle, color: C.text, marginBottom: 2 },
    sub: { ...typography.caption, color: C.textSecondary, lineHeight: 17 },
  };
}

function getPiStyles(C: ProfileColors) {
  return {
    wrap: { paddingHorizontal: spacing.lg, marginTop: spacing.md },
    card: { backgroundColor: C.surface, borderRadius: radii.xl, borderWidth: 1, borderColor: C.borderLight, overflow: "hidden" as const, ...shadows.sm },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.borderLight },
    iconWrap: { width: 34, height: 34, borderRadius: radii.md, alignItems: "center" as const, justifyContent: "center" as const },
    label: { ...typography.small, color: C.textMuted, marginBottom: 1 },
    value: { ...typography.bodyMedium, color: C.text },
  };
}

function getRcStyles(C: ProfileColors) {
  return {
    wrap: { flexDirection: "row" as const, alignItems: "center" as const, backgroundColor: C.infoSoft, marginHorizontal: spacing.lg, marginTop: spacing.md, borderRadius: radii.xl, padding: spacing.lg, borderWidth: 1, borderColor: C.indigoBorder },
    left: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: spacing.md, flex: 1 },
    iconBox: { width: 44, height: 44, borderRadius: radii.lg, backgroundColor: C.indigoSoft, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
    title: { ...typography.subtitle, color: C.text, marginBottom: 3 },
    sub: { ...typography.caption, color: C.textSecondary, lineHeight: 17, marginBottom: spacing.sm },
    codeRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.sm },
    codeLabel: { ...typography.smallMedium, color: C.textMuted },
    codePill: { backgroundColor: C.indigoBorder, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.full },
    code: { ...Typ.captionBold, color: C.info, letterSpacing: 1 },
  };
}

function getSecStyles(C: ProfileColors) {
  return {
    wrap: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
    title: { ...Typ.tiny, color: C.textMuted, letterSpacing: 1, marginBottom: 6 },
    card: { backgroundColor: C.surface, borderRadius: radii.xl, borderWidth: 1, borderColor: C.borderLight, overflow: "hidden" as const, ...shadows.sm },
    secureBadge: { backgroundColor: C.successSoft, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radii.full },
    secureTxt: { ...typography.smallMedium, color: C.success },
  };
}

function getRowStyles(C: ProfileColors) {
  return {
    wrap: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: C.borderLight },
    icon: { width: 36, height: 36, borderRadius: radii.md, alignItems: "center" as const, justifyContent: "center" as const },
    label: { ...typography.bodyMedium, color: C.text },
    sub: { ...typography.small, color: C.textMuted, marginTop: 1 },
    badge: { backgroundColor: C.danger, borderRadius: 10, minWidth: 20, height: 20, alignItems: "center" as const, justifyContent: "center" as const, paddingHorizontal: 5, marginRight: 4 },
    badgeTxt: { ...Typ.tiny, color: C.textInverse },
  };
}

function getAppInfoStyles(C: ProfileColors) {
  return {
    wrap: { alignItems: "center" as const, marginTop: spacing.xxxl, marginBottom: spacing.lg, gap: 6 },
    logo: { width: 56, height: 56, borderRadius: radii.xl, backgroundColor: C.primarySoft, alignItems: "center" as const, justifyContent: "center" as const },
    name: { ...typography.subtitle, color: C.text },
    version: { ...typography.caption, color: C.textMuted },
  };
}

function getSignOutStyles(C: ProfileColors) {
  return {
    btn: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 10, paddingVertical: 15, backgroundColor: C.dangerSoft, borderRadius: radii.xl },
    txt: { ...typography.bodySemiBold, color: C.danger },
    confirmBox: { backgroundColor: C.surface, borderRadius: radii.xl, padding: spacing.lg, borderWidth: 1.5, borderColor: C.dangerSoft },
    confirmTitle: { ...typography.subtitle, color: C.text },
    confirmSub: { ...typography.caption, color: C.textMuted, marginTop: 2 },
  };
}

function getBtnStyles(C: ProfileColors) {
  return {
    cancel: { flex: 1, borderWidth: 1.5, borderColor: C.border, borderRadius: radii.lg, paddingVertical: 14, alignItems: "center" as const },
    cancelTxt: { ...typography.bodySemiBold, color: C.textSecondary },
    save: { flex: 2, backgroundColor: C.primary, borderRadius: radii.lg, paddingVertical: 14, alignItems: "center" as const },
    saveTxt: { ...typography.button, color: C.textInverse },
  };
}
