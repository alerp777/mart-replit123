import { Ionicons } from "@expo/vector-icons";
import { withErrorBoundary } from "@/utils/withErrorBoundary";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, type RelativePathString } from "expo-router";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { Socket } from "socket.io-client";
import {
  ActivityIndicator,
  Animated,
  Linking,
  Modal,
  Platform,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";

import Colors, { spacing, radii } from "@/constants/colors";
import { T as Typ, Font } from "@/constants/typography";
import { useAuth, hasRole } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";
import { useToast } from "@/context/ToastContext";
import { usePlatformConfig } from "@/context/PlatformConfigContext";
import { useLanguage } from "@/context/LanguageContext";
import { tDual, type TranslationKey, type Language } from "@workspace/i18n";
import { useGetOrders, getGetOrdersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { SmartRefresh } from "@/components/ui/SmartRefresh";
import { useCollapsibleHeader } from "@/hooks/useCollapsibleHeader";
import { CancelModal } from "@/components/CancelModal";
import type { CancelTarget } from "@/components/CancelModal";
import { API_BASE, unwrapApiResponse } from "@/utils/api";
import { AuthGateSheet } from "@/components/AuthGateSheet";
import {
  SkeletonBlock,
  SkeletonRows,
  EmptyState,
  FilterChip,
} from "@/components/user-shared";
import {
  ORDER_STATUS_MAP,
  RIDE_STATUS_MAP,
  PARCEL_STATUS_MAP,
  RIDE_STEPS,
} from "@/lib/orderUtils";

const C = Colors.light;

interface OrderItemShape {
  productId?: string;
  name: string;
  quantity: number;
  price: number;
  image?: string;
}

interface OrderShape {
  id: string;
  type?: string;
  status: string;
  total?: number;
  items?: OrderItemShape[];
  paymentMethod?: string;
  estimatedTime?: string;
  createdAt?: string;
  updatedAt?: string;
  refundStatus?: string;
  prescriptionNote?: string;
  pickupAddress?: string;
  dropAddress?: string;
  fare?: number;
  estimatedFare?: number;
  distance?: number;
  _reviewed?: boolean;
  _type?: string;
  vendorId?: string;
  riderId?: string;
}

interface RideShape {
  id: string;
  status: string;
  type?: string;
  fare?: number;
  distance?: number;
  pickupAddress?: string;
  dropAddress?: string;
  riderName?: string;
  riderPhone?: string;
  riderId?: string;
  vendorId?: string;
  createdAt?: string;
  updatedAt?: string;
  paymentMethod?: string;
  estimatedTime?: string;
  fareBreakdown?: { baseFare?: number; gstAmount?: number; [key: string]: number | string | undefined };
  items?: OrderItemShape[];
  total?: number;
  estimatedFare?: number;
  _reviewed?: boolean;
  _type?: string;
}

/* Single source of truth: all status maps imported from @/lib/orderUtils */
const ORDER_STATUS = ORDER_STATUS_MAP;
const RIDE_STATUS  = RIDE_STATUS_MAP;
const PARCEL_STATUS = PARCEL_STATUS_MAP;

const TABS = [
  { key: "all",      labelKey: "all" as TranslationKey,       icon: "layers-outline" },
  { key: "mart",     labelKey: "mart" as TranslationKey,      icon: "storefront-outline" },
  { key: "food",     labelKey: "food" as TranslationKey,      icon: "restaurant-outline" },
  { key: "rides",    labelKey: "ride" as TranslationKey,      icon: "car-outline" },
  { key: "pharmacy", labelKey: "pharmacy" as TranslationKey,  icon: "medical-outline" },
  { key: "parcel",   labelKey: "parcel" as TranslationKey,    icon: "cube-outline" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function OrderCard({ order, liveTracking, reviews, cancelWindowMin, refundDays, ratingWindowHours, serverNow, onRate, onCancel, onReorder, onCardPress }: {
  order: OrderShape;
  liveTracking: boolean;
  reviews: boolean;
  cancelWindowMin: number;
  refundDays: number;
  ratingWindowHours: number;
  serverNow?: number;
  onRate: (o: OrderShape) => void;
  onCancel: (o: OrderShape) => void;
  onReorder?: (o: OrderShape) => void;
  onCardPress?: () => void;
}) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { config } = usePlatformConfig();
  const [itemsExpanded, setItemsExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const cfg = ORDER_STATUS[order.status] || ORDER_STATUS["pending"]!;
  const isFood = order.type === "food";
  const isPharmacy = order.type === "pharmacy";
  const isParcel = order.type === "parcel";
  const b = config.branding;
  const brandBg = (hex: string) => hex + "26";
  const orderChip = isFood
    ? { bg: b?.colorFood ? brandBg(b.colorFood) : C.amberSoft, color: b?.colorFood ?? C.amber, icon: "restaurant-outline" as keyof typeof Ionicons.glyphMap, label: T("food") }
    : isPharmacy
    ? { bg: b?.colorPharmacy ? brandBg(b.colorPharmacy) : C.emeraldSoft, color: b?.colorPharmacy ?? C.emerald, icon: "medical-outline" as keyof typeof Ionicons.glyphMap, label: T("pharmacy") }
    : isParcel
    ? { bg: b?.colorParcel ? brandBg(b.colorParcel) : C.orangeSoft, color: b?.colorParcel ?? C.gold, icon: "cube-outline" as keyof typeof Ionicons.glyphMap, label: T("parcel") }
    : { bg: b?.colorMart ? brandBg(b.colorMart) : C.blueSoft, color: b?.colorMart ?? C.brandBlue, icon: "storefront-outline" as keyof typeof Ionicons.glyphMap, label: T("mart") };
  const isDelivered = order.status === "delivered";
  const isCancelled = order.status === "cancelled";
  const isActive = !["delivered", "cancelled"].includes(order.status);

  const nowMs = serverNow ?? Date.now();
  const minutesSincePlaced = order.createdAt
    ? (nowMs - new Date(order.createdAt).getTime()) / 60000
    : 999;
  const canCancel = ["pending", "confirmed"].includes(order.status) && minutesSincePlaced <= cancelWindowMin;
  const cancelMinsLeft = Math.max(0, Math.ceil(cancelWindowMin - minutesSincePlaced));

  const hourssinceDelivery = order.updatedAt
    ? (nowMs - new Date(order.updatedAt).getTime()) / 3600000
    : 0;
  const canRate = reviews && isDelivered && !order._reviewed && hourssinceDelivery <= ratingWindowHours;

  const handleCardPress = () => {
    if (onCardPress) { onCardPress(); return; }
    router.push({ pathname: "/orders/[id]", params: { id: order.id } });
  };

  const hoverProps = Platform.OS === "web"
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {};

  return (
    <TouchableOpacity activeOpacity={0.7}
      onPress={handleCardPress}
      {...(hoverProps as object)}
      style={[styles.card, webPointer, hovered && { opacity: 0.88 }]}
      accessibilityLabel={`${orderChip.label} order ${order.id.slice(-8).toUpperCase()}, ${T(cfg.labelKey)}, Rs. ${order.total?.toLocaleString()}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.chip, { backgroundColor: orderChip.bg }]}>
          <Ionicons name={orderChip.icon} size={13} color={orderChip.color} />
          <Text style={[styles.chipText, { color: orderChip.color }]}>{orderChip.label}</Text>
        </View>
        <Text style={styles.cardId}>#{order.id.slice(-8).toUpperCase()}</Text>
      </View>

      <View style={styles.cardItems}>
        {(order.items || []).slice(0, itemsExpanded ? undefined : 2).map((item: OrderItemShape, i: number) => (
          <View key={i} style={styles.itemRow}>
            <View style={styles.itemDot} />
            <Text style={styles.itemText} numberOfLines={1}>{item.quantity}× {item.name}</Text>
            <Text style={styles.itemPrice}>Rs. {item.price * item.quantity}</Text>
          </View>
        ))}
        {(order.items || []).length > 2 && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setItemsExpanded(prev => !prev)} style={styles.expandRow}>
            <Text style={styles.moreItems}>
              {itemsExpanded ? T("showLess") : `+${(order.items?.length ?? 0) - 2} ${T("moreItems")}`}
            </Text>
            <Ionicons
              name={itemsExpanded ? "chevron-up" : "chevron-down"}
              size={13}
              color={C.primary}
            />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.cardFooter}>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as keyof typeof Ionicons.glyphMap} size={13} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{T(cfg.labelKey)}</Text>
        </View>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>{T("total")}</Text>
          <Text style={styles.totalAmount}>Rs. {order.total?.toLocaleString()}</Text>
        </View>
      </View>

      {liveTracking && order.estimatedTime && isActive && (
        <View style={styles.etaBar}>
          <Ionicons name="time-outline" size={12} color={C.primary} />
          <Text style={styles.etaText}>ETA: {order.estimatedTime}</Text>
          <View style={styles.payBadge}>
            <Ionicons
              name={order.paymentMethod === "wallet" ? "wallet-outline" : "cash-outline"}
              size={11} color={C.textMuted}
            />
            <Text style={styles.payText}>{order.paymentMethod === "wallet" ? T("wallet") : T("cash")}</Text>
          </View>
        </View>
      )}

      {!liveTracking && isActive && (
        <View style={[styles.etaBar, { backgroundColor: C.amberSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 0, marginTop: 12 }]}>
          <Ionicons name="navigate-circle-outline" size={13} color={C.amber} />
          <Text style={[styles.etaText, { color: C.amberDark }]}>{T("liveTrackingUnavailable")}</Text>
        </View>
      )}

      {canCancel ? (
        <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={() => onCancel(order)} accessibilityRole="button" accessibilityLabel={`${T("cancelOrder")}, ${cancelMinsLeft} minutes left`}>
          <Ionicons name="close-circle-outline" size={14} color={C.red} />
          <Text style={styles.cancelBtnText}>{T("cancelOrder")} ({cancelMinsLeft}m left)</Text>
        </TouchableOpacity>
      ) : isActive && (
        <View style={styles.cancelDisabledBar}>
          <Ionicons name="close-circle-outline" size={14} color={C.textMuted} />
          <Text style={styles.cancelDisabledText}>
            {["preparing", "ready", "picked_up"].includes(order.status)
              ? T("cancelOrder") + " — " + T("orderPreparing")
              : order.status === "out_for_delivery"
              ? T("cancelOrder") + " — " + T("deliveryOnWay")
              : T("cancelOrder") + " — " + T("cancelWindowPassed")}
          </Text>
        </View>
      )}

      {canRate && (
        <TouchableOpacity activeOpacity={0.7} style={styles.rateBtn} onPress={() => onRate(order)} accessibilityRole="button" accessibilityLabel={T("rateOrder")}>
          <Ionicons name="star-outline" size={14} color={C.gold} />
          <Text style={styles.rateBtnText}>{T("rateOrder")}</Text>
        </TouchableOpacity>
      )}

      {order._reviewed && (
        <View style={styles.reviewedBadge}>
          <Ionicons name="star" size={13} color={C.gold} />
          <Text style={styles.reviewedText}>{T("reviewedThanks")}</Text>
        </View>
      )}

      {isDelivered && order.paymentMethod !== "cash" && order.paymentMethod !== "cod" && !order.refundStatus && (
        <TouchableOpacity activeOpacity={0.7} style={styles.refundRequestBtn} onPress={() => router.push({ pathname: "/orders/[id]", params: { id: order.id, action: "refund" } })} accessibilityRole="button" accessibilityLabel="Request refund for this order">
          <Ionicons name="return-down-back-outline" size={14} color={C.purple} />
          <Text style={styles.refundRequestBtnText}>{T("requestRefund") || "Request Refund"}</Text>
        </TouchableOpacity>
      )}

      {(isDelivered || isCancelled) && onReorder && (order.items?.length ?? 0) > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.reorderBtn} onPress={() => onReorder(order)} accessibilityRole="button" accessibilityLabel="Reorder these items">
          <Ionicons name="refresh-outline" size={14} color={C.primary} />
          <Text style={styles.reorderBtnText}>{T("reorder")}</Text>
        </TouchableOpacity>
      )}

      {isCancelled && order.paymentMethod !== "cash" && order.paymentMethod !== "cod" && refundDays > 0 && (
        <View style={styles.refundBar}>
          <Ionicons name="return-down-back-outline" size={12} color={C.emerald} />
          <Text style={styles.refundText}>{T("refundInfo").replace("{n}", String(refundDays))}</Text>
        </View>
      )}

      <View style={styles.tapHint}>
        <Ionicons name="open-outline" size={11} color={C.textMuted} />
        <Text style={styles.tapHintText}>{T("tapForDetails")}</Text>
      </View>
    </TouchableOpacity>
  );
}


function RideCard({ ride, liveTracking, reviews, ratingWindowHours, serverNow, onRate, onCancel, onCardPress }: {
  ride: RideShape;
  liveTracking: boolean;
  reviews: boolean;
  ratingWindowHours: number;
  serverNow?: number;
  onRate: (o: OrderShape | RideShape | ParcelShape) => void;
  onCancel: (o: RideShape) => void;
  onCardPress?: () => void;
}) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const { config: rideConfig } = usePlatformConfig();
  const [hovered, setHovered] = useState(false);
  const cfg = RIDE_STATUS[ride.status] || RIDE_STATUS["searching"]!;
  const isActive    = !["completed", "cancelled"].includes(ride.status);
  const isCompleted = ride.status === "completed";
  const canCancel   = ["searching", "bargaining", "accepted", "arrived"].includes(ride.status);

  const nowMs = serverNow ?? Date.now();
  const hoursSinceCompleted = ride.updatedAt
    ? (nowMs - new Date(ride.updatedAt).getTime()) / 3600000
    : 0;
  const canRate = reviews && isCompleted && !ride._reviewed && hoursSinceCompleted <= ratingWindowHours;
  const hasRider    = ["accepted", "arrived", "in_transit", "ongoing"].includes(ride.status);
  const rideStepIdx = RIDE_STEPS.indexOf(ride.status);
  const showStepper = isActive && rideStepIdx >= 0;

  const handleCardPress = () => {
    if (onCardPress) { onCardPress(); return; }
    if (isActive) {
      router.push(`/ride?rideId=${ride.id}`);
    } else {
      router.push({ pathname: "/orders/[id]", params: { id: ride.id, type: "ride" } });
    }
  };

  const hoverProps = Platform.OS === "web"
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {};

  return (
    <TouchableOpacity activeOpacity={0.7}
      onPress={handleCardPress}
      {...(hoverProps as object)}
      style={[styles.card, webPointer, hovered && { opacity: 0.88 }]}
      accessibilityLabel={`${ride.type || "car"} ride ${ride.id.slice(-8).toUpperCase()}, ${T(cfg.labelKey)}, Rs. ${(ride.fare != null ? Number(ride.fare) : 0).toLocaleString()}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.chip, { backgroundColor: C.emeraldSoft }]}>
          <Ionicons
            name={
              ride.type === "bike" ? "bicycle-outline" :
              ride.type === "rickshaw" ? "car-sport-outline" :
              ride.type === "daba" ? "bus-outline" :
              ride.type === "school_shift" ? "school-outline" :
              "car-outline"
            }
            size={13} color={C.emerald}
          />
          <Text style={[styles.chipText, { color: C.emerald }]}>
            {ride.type === "bike" ? T("bikeRide") :
             ride.type === "rickshaw" ? T("rickshaw") :
             ride.type === "daba" ? T("daba") :
             ride.type === "school_shift" ? T("schoolShift") :
             T("carRide")}
          </Text>
        </View>
        <Text style={styles.cardId}>#{ride.id.slice(-8).toUpperCase()}</Text>
      </View>

      <View style={styles.rideRoute}>
        <View style={styles.ridePoint}>
          <View style={[styles.routeDot, { backgroundColor: C.emeraldDot }]} />
          <Text style={styles.rideAddr} numberOfLines={1}>{ride.pickupAddress || T("pickup")}</Text>
        </View>
        <View style={styles.routeLine} />
        <View style={styles.ridePoint}>
          <View style={[styles.routeDot, { backgroundColor: C.red }]} />
          <Text style={styles.rideAddr} numberOfLines={1}>{ride.dropAddress || T("drop")}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as keyof typeof Ionicons.glyphMap} size={13} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{T(cfg.labelKey)}</Text>
        </View>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>{ride.distance && Number.isFinite(parseFloat(String(ride.distance))) ? `${parseFloat(String(ride.distance)).toFixed(1)} km` : T("fare")}</Text>
          <Text style={styles.totalAmount}>Rs. {(ride.fare != null && Number.isFinite(Number(ride.fare)) ? Number(ride.fare) : 0).toLocaleString()}</Text>
        </View>
      </View>

      {hasRider && ride.riderName && (
        <View style={styles.riderBar}>
          <View style={styles.riderIconWrap}>
            <Ionicons name="person-outline" size={14} color={C.brandBlue} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.riderName}>{ride.riderName}</Text>
            {ride.riderPhone && <Text style={styles.riderPhone}>{ride.riderPhone}</Text>}
          </View>
          {ride.riderPhone && (
            <TouchableOpacity activeOpacity={0.7} onPress={() => Linking.openURL(`tel:${ride.riderPhone}`)} style={styles.callBtn} accessibilityRole="button" accessibilityLabel={`Call rider ${ride.riderName}`}>
              <Ionicons name="call-outline" size={16} color={C.textInverse} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {isCompleted && (ride.distance ?? 0) > 0 && (() => {
        const totalFare = ride.fare != null ? Number(ride.fare) : 0;
        const gstPct = rideConfig.finance.gstEnabled ? (rideConfig.finance.gstPct / 100) : 0;
        const gst = ride.fareBreakdown?.gstAmount ?? Math.round(totalFare * gstPct);
        const perKm = ride.type === "car" ? rideConfig.rides.carPerKm : rideConfig.rides.bikePerKm;
        const baseFare = ride.fareBreakdown?.baseFare ?? Math.round(parseFloat(String(ride.distance ?? 0)) * perKm);
        return (
          <View style={styles.fareBreakdownBar}>
            <View style={styles.fareRow}>
              <Text style={styles.fareLabel}>{T("baseFareLabel")}</Text>
              <Text style={styles.fareValue}>Rs. {baseFare.toLocaleString()}</Text>
            </View>
            <View style={styles.fareRow}>
              <Text style={styles.fareLabel}>{T("distance") || "Distance"}</Text>
              <Text style={styles.fareValue}>{parseFloat(String(ride.distance)).toFixed(1)} km</Text>
            </View>
            <View style={styles.fareRow}>
              <Text style={styles.fareLabel}>{T("gstLabel")}</Text>
              <Text style={styles.fareValue}>Rs. {gst.toLocaleString()}</Text>
            </View>
            <View style={[styles.fareRow, { borderTopWidth: 1, borderTopColor: C.borderLight, paddingTop: 6, marginTop: 2 }]}>
              <Text style={[styles.fareLabel, { fontFamily: Font.bold, color: C.text }]}>{T("fare")}</Text>
              <Text style={[styles.fareValue, { fontFamily: Font.bold }]}>Rs. {totalFare.toLocaleString()}</Text>
            </View>
            <View style={styles.fareRow}>
              <Text style={styles.fareLabel}>{T("paymentMethod") || "Payment"}</Text>
              <Text style={styles.fareValue}>{ride.paymentMethod === "wallet" ? T("wallet") : ride.paymentMethod === "jazzcash" ? T("jazzcash") : ride.paymentMethod === "easypaisa" ? T("easypaisa") : T("cash")}</Text>
            </View>
          </View>
        );
      })()}

      {isActive && (
        <View style={styles.etaBar}>
          <Ionicons name={ride.paymentMethod === "wallet" ? "wallet-outline" : "cash-outline"} size={12} color={C.primary} />
          <Text style={styles.etaText}>
            {ride.paymentMethod === "wallet" ? T("paidViaWallet") : T("cashPayment")}
          </Text>
        </View>
      )}

      {canCancel && (
        <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={() => onCancel(ride)} accessibilityRole="button" accessibilityLabel={["accepted", "arrived"].includes(ride.status) ? T("cancelRideFee") : T("cancelRide")}>
          <Ionicons name="close-circle-outline" size={14} color={C.red} />
          <Text style={styles.cancelBtnText}>
            {["accepted", "arrived"].includes(ride.status) ? T("cancelRideFee") : T("cancelRide")}
          </Text>
        </TouchableOpacity>
      )}

      {canRate && (
        <TouchableOpacity activeOpacity={0.7} style={styles.rateBtn} onPress={() => onRate({ ...ride, _type: "ride" })} accessibilityRole="button" accessibilityLabel={T("rateThisRide")}>
          <Ionicons name="star-outline" size={14} color={C.gold} />
          <Text style={styles.rateBtnText}>{T("rateThisRide")}</Text>
        </TouchableOpacity>
      )}

      {ride._reviewed && (
        <View style={styles.reviewedBadge}>
          <Ionicons name="star" size={13} color={C.gold} />
          <Text style={styles.reviewedText}>{T("reviewedThanks")}</Text>
        </View>
      )}

      {(isCompleted || ride.status === "cancelled") && (
        <TouchableOpacity activeOpacity={0.7}
          style={styles.bookAgainBtn}
          onPress={() => router.push({
            pathname: "/ride",
            params: {
              prefillPickup: ride.pickupAddress || "",
              prefillDrop: ride.dropAddress || "",
              prefillType: ride.type || "car",
            },
          })}
          accessibilityRole="button"
          accessibilityLabel="Book this ride again"
        >
          <Ionicons name="repeat-outline" size={14} color={C.primary} />
          <Text style={styles.bookAgainBtnText}>{T("bookAgain")}</Text>
        </TouchableOpacity>
      )}

      {showStepper && (
        <View style={styles.rideStepperWrap}>
          <View style={styles.rideStepperRow}>
            {RIDE_STEPS.map((step, i) => {
              const done = rideStepIdx >= i;
              const active = rideStepIdx === i;
              const isLast = i === RIDE_STEPS.length - 1;
              return (
                <React.Fragment key={step}>
                  <View style={styles.rideStepItem}>
                    <View style={[
                      styles.rideStepDot,
                      done && { backgroundColor: active ? cfg.color : C.emeraldDot },
                      active && { shadowColor: cfg.color, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3 },
                    ]}>
                      {done
                        ? <Ionicons name="checkmark" size={10} color={C.textInverse} />
                        : <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: C.slate }} />}
                    </View>
                    <Text style={[styles.rideStepLabel, done && { color: C.text }, active && { fontFamily: Font.bold }]}>
                      {[T("stepSearching"), T("stepAccepted"), T("stepArrived"), T("stepOnRoute"), T("stepDone")][i]}
                    </Text>
                  </View>
                  {!isLast && (
                    <View style={[styles.rideStepLine, rideStepIdx > i && { backgroundColor: C.emeraldDot }]} />
                  )}
                </React.Fragment>
              );
            })}
          </View>
        </View>
      )}

      <View style={styles.tapHint}>
        <Ionicons name="open-outline" size={11} color={C.textMuted} />
        <Text style={styles.tapHintText}>{isActive ? T("tapToTrack") : T("tapForDetails")}</Text>
      </View>
    </TouchableOpacity>
  );
}

function PharmacyCard({ order, reviews, cancelWindowMin, serverNow, onRate, onCancel, onCardPress }: {
  order: OrderShape;
  reviews: boolean;
  cancelWindowMin: number;
  serverNow?: number;
  onRate: (o: OrderShape) => void;
  onCancel: (o: OrderShape) => void;
  onCardPress?: () => void;
}) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const [itemsExpanded, setItemsExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const cfg = ORDER_STATUS[order.status] || ORDER_STATUS["pending"]!;
  const isDelivered = order.status === "delivered";

  const nowMs = serverNow ?? Date.now();
  const minutesSincePlaced = order.createdAt
    ? (nowMs - new Date(order.createdAt).getTime()) / 60000
    : 999;
  const canCancel = ["pending", "confirmed"].includes(order.status) && minutesSincePlaced <= cancelWindowMin;
  const cancelMinsLeft = Math.max(0, Math.ceil(cancelWindowMin - minutesSincePlaced));

  const hoverProps = Platform.OS === "web"
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {};

  return (
    <TouchableOpacity activeOpacity={0.7}
      {...(hoverProps as object)}
      style={[styles.card, webPointer, hovered && { opacity: 0.88 }]}
      onPress={() => { if (onCardPress) { onCardPress(); return; } router.push({ pathname: "/orders/[id]", params: { id: order.id, type: "pharmacy" } }); }}
      accessibilityRole="button"
      accessibilityLabel={`Pharmacy order ${order.id.slice(-8).toUpperCase()}, ${T(cfg.labelKey)}, Rs. ${(order.total != null ? Number(order.total) : 0).toLocaleString()}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.chip, { backgroundColor: C.purpleLight }]}>
          <Ionicons name="medical-outline" size={13} color={C.purple} />
          <Text style={[styles.chipText, { color: C.purple }]}>{T("pharmacy")}</Text>
        </View>
        <Text style={styles.cardId}>#{order.id.slice(-8).toUpperCase()}</Text>
      </View>

      {order.prescriptionNote && (
        <View style={styles.noteRow}>
          <Ionicons name="document-text-outline" size={14} color={C.purple} />
          <Text style={styles.noteText} numberOfLines={2}>{order.prescriptionNote}</Text>
        </View>
      )}

      <View style={styles.cardItems}>
        {(order.items || []).slice(0, itemsExpanded ? undefined : 2).map((item: OrderItemShape, i: number) => (
          <View key={i} style={styles.itemRow}>
            <View style={styles.itemDot} />
            <Text style={styles.itemText} numberOfLines={1}>{item.quantity}× {item.name}</Text>
            <Text style={styles.itemPrice}>Rs. {item.price * item.quantity}</Text>
          </View>
        ))}
        {(order.items || []).length > 2 && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setItemsExpanded(prev => !prev)} style={styles.expandRow}>
            <Text style={styles.moreItems}>
              {itemsExpanded ? T("showLess") : `+${(order.items?.length ?? 0) - 2} ${T("moreItems")}`}
            </Text>
            <Ionicons
              name={itemsExpanded ? "chevron-up" : "chevron-down"}
              size={13}
              color={C.primary}
            />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.cardFooter}>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as keyof typeof Ionicons.glyphMap} size={13} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{T(cfg.labelKey)}</Text>
        </View>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>{T("total")}</Text>
          <Text style={styles.totalAmount}>Rs. {(order.total != null && Number.isFinite(Number(order.total)) ? Number(order.total) : 0).toLocaleString()}</Text>
        </View>
      </View>

      {canCancel && (
        <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={() => onCancel(order)} accessibilityRole="button" accessibilityLabel={`${T("cancelOrder")}, ${cancelMinsLeft} minutes left`}>
          <Ionicons name="close-circle-outline" size={14} color={C.red} />
          <Text style={styles.cancelBtnText}>{T("cancelOrder")} ({cancelMinsLeft}m left)</Text>
        </TouchableOpacity>
      )}

      {reviews && isDelivered && !order._reviewed && (
        <TouchableOpacity activeOpacity={0.7} style={styles.rateBtn} onPress={() => onRate({ ...order, _type: "pharmacy" })} accessibilityRole="button" accessibilityLabel={T("rateOrder")}>
          <Ionicons name="star-outline" size={14} color={C.gold} />
          <Text style={styles.rateBtnText}>{T("rateOrder")}</Text>
        </TouchableOpacity>
      )}

      {order._reviewed && (
        <View style={styles.reviewedBadge}>
          <Ionicons name="star" size={13} color={C.gold} />
          <Text style={styles.reviewedText}>{T("reviewedThanks")}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

interface ParcelShape {
  id: string;
  status: string;
  parcelType?: string;
  pickupAddress?: string;
  dropAddress?: string;
  fare?: number;
  estimatedFare?: number;
  estimatedTime?: string;
  receiverName?: string;
  receiverPhone?: string;
  paymentMethod?: string;
  vendorId?: string;
  riderId?: string;
  createdAt?: string;
  updatedAt?: string;
  items?: OrderItemShape[];
  total?: number;
  distance?: number;
  type?: string;
  _reviewed?: boolean;
  _type?: string;
}

function ParcelCard({ booking, onCardPress }: { booking: ParcelShape; onCardPress?: () => void }) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const [hovered, setHovered] = useState(false);
  const cfg = PARCEL_STATUS[booking.status] || PARCEL_STATUS["pending"]!;
  const isActive = !["completed", "cancelled"].includes(booking.status);
  const parcelLabel = booking.parcelType
    ? booking.parcelType.charAt(0).toUpperCase() + booking.parcelType.slice(1)
    : T("parcel");

  const handleCardPress = () => {
    if (onCardPress) { onCardPress(); return; }
    router.push({ pathname: "/orders/[id]", params: { id: booking.id, type: "parcel" } });
  };

  const hoverProps = Platform.OS === "web"
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {};

  return (
    <TouchableOpacity activeOpacity={0.7}
      onPress={handleCardPress}
      {...(hoverProps as object)}
      style={[styles.card, webPointer, hovered && { opacity: 0.88 }]}
      accessibilityRole="button"
      accessibilityLabel={`Parcel ${parcelLabel} ${booking.id.slice(-8).toUpperCase()}, ${T(cfg.labelKey)}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.chip, { backgroundColor: C.amberSoft }]}>
          <Ionicons name="cube-outline" size={13} color={C.amber} />
          <Text style={[styles.chipText, { color: C.amber }]}>{T("parcel")} · {parcelLabel}</Text>
        </View>
        <Text style={styles.cardId}>#{booking.id.slice(-8).toUpperCase()}</Text>
      </View>

      <View style={styles.rideRoute}>
        <View style={styles.ridePoint}>
          <View style={[styles.routeDot, { backgroundColor: C.emeraldDot }]} />
          <Text style={styles.rideAddr} numberOfLines={1}>{booking.pickupAddress || T("pickup")}</Text>
        </View>
        <View style={styles.routeLine} />
        <View style={styles.ridePoint}>
          <View style={[styles.routeDot, { backgroundColor: C.red }]} />
          <Text style={styles.rideAddr} numberOfLines={1}>{booking.dropAddress || T("drop")}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as keyof typeof Ionicons.glyphMap} size={13} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{T(cfg.labelKey)}</Text>
        </View>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>{T("fare")}</Text>
          <Text style={styles.totalAmount}>Rs. {((booking.fare || booking.estimatedFare) != null && Number.isFinite(Number(booking.fare || booking.estimatedFare)) ? Number(booking.fare || booking.estimatedFare) : 0).toLocaleString()}</Text>
        </View>
      </View>

      {booking.receiverName && (
        <View style={styles.etaBar}>
          <Ionicons name="person-outline" size={12} color={C.primary} />
          <Text style={styles.etaText} numberOfLines={1}>To: {booking.receiverName} · {booking.receiverPhone}</Text>
        </View>
      )}

      {isActive && booking.estimatedTime && (
        <View style={styles.etaBar}>
          <Ionicons name="time-outline" size={12} color={C.amber} />
          <Text style={[styles.etaText, { color: C.amberDark }]}>ETA: {booking.estimatedTime}</Text>
          <View style={styles.payBadge}>
            <Ionicons
              name={booking.paymentMethod === "wallet" ? "wallet-outline" : "cash-outline"}
              size={11} color={C.textMuted}
            />
            <Text style={styles.payText}>
              {booking.paymentMethod === "wallet" ? T("wallet") : booking.paymentMethod === "jazzcash" ? T("jazzcash") : booking.paymentMethod === "easypaisa" ? T("easypaisa") : T("cash")}
            </Text>
          </View>
        </View>
      )}

      {(booking.status === "completed" || booking.status === "cancelled") && (
        <TouchableOpacity activeOpacity={0.7}
          style={styles.bookAgainBtn}
          onPress={() => router.push({
            pathname: "/parcel",
            params: {
              prefillPickup: booking.pickupAddress || "",
              prefillDrop: booking.dropAddress || "",
              prefillType: booking.parcelType || "",
            },
          })}
          accessibilityRole="button"
          accessibilityLabel="Send parcel again"
        >
          <Ionicons name="repeat-outline" size={14} color={C.primary} />
          <Text style={styles.bookAgainBtnText}>Send Again</Text>
        </TouchableOpacity>
      )}

      <View style={styles.tapHint}>
        <Ionicons name="open-outline" size={11} color={C.textMuted} />
        <Text style={styles.tapHintText}>{isActive ? T("tapToTrack") : T("tapForDetails")}</Text>
      </View>
    </TouchableOpacity>
  );
}

function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 12, marginVertical: 8 }} accessibilityRole="adjustable" accessibilityLabel={`Rating: ${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map(s => (
        <TouchableOpacity activeOpacity={0.7} key={s} onPress={() => onChange(s)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${s} star${s > 1 ? "s" : ""}`} accessibilityState={{ selected: s <= value }}>
          <Ionicons
            name={s <= value ? "star" : "star-outline"}
            size={36}
            color={s <= value ? C.gold : C.slateBorder}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const RATING_LABELS = ["", "Poor", "Fair", "Good", "Great", "Excellent"];

type ReviewTarget = OrderShape | RideShape | ParcelShape;

function ReviewModal({ target, userId, apiBase, token, language, onClose, onDone }: {
  target: ReviewTarget;
  userId: string;
  apiBase: string;
  token: string | null;
  language: Language;
  onClose: () => void;
  onDone: (orderId: string) => void;
}) {
  const t = (k: TranslationKey) => tDual(k, language);
  const orderType: string = String(target._type ?? target.type ?? "order");
  const isRideOrder = orderType === "ride";
  /* Ride orders: rated via the general /reviews endpoint, rider is the subject.
     Delivery orders with a rider AND a vendor: dual-rating (vendor + rider separately).
     Delivery orders with only a vendor (no rider yet): vendor-only rating. */
  const hasVendor    = !!target.vendorId;
  const hasRider     = !!target.riderId;   // include ride orders
  const isDualRating = hasVendor && hasRider && !isRideOrder;

  const [vendorRating, setVendorRating] = useState(0);
  const [riderRating,  setRiderRating]  = useState(0);
  const [comment, setComment]           = useState("");
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState("");

  const primaryRating   = isRideOrder ? riderRating : vendorRating;
  const primaryLabel    = isRideOrder ? "Please rate your rider." : "Please rate the vendor.";
  const secondaryError  = "Please rate the delivery rider too.";

  const submit = async () => {
    if (primaryRating === 0) { setError(primaryLabel); return; }
    if (isDualRating && riderRating === 0) { setError(secondaryError); return; }
    setLoading(true);
    setError("");
    try {
      const hdrs: Record<string, string> = { "Content-Type": "application/json" };
      if (token) hdrs["Authorization"] = `Bearer ${token}`;

      /* Single-request: primary rating (vendor for delivery, rider for rides)
         + optional separate rider rating stored in riderRating column */
      const res = await fetch(`${apiBase}/reviews`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          orderId: String(target.id),
          vendorId: hasVendor && !isRideOrder ? target.vendorId : null,
          riderId: hasRider ? target.riderId : null,
          orderType,
          rating: primaryRating,
          riderRating: isDualRating && riderRating > 0 ? riderRating : null,
          comment: comment.trim() || null,
        }),
      });

      if (res.status === 409) {
        /* Already reviewed — treat as success */
        onDone(String(target.id));
        onClose();
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const errStr = String(body["error"] || "");
        const msgStr = String(body["message"] || "");
        if (body["expired"]) {
          setError(tDual("reviewWindowExpired", language));
        } else if (res.status === 403 && (errStr.includes("delivered") || errStr.includes("completed") || msgStr.includes("ڈیلیور"))) {
          setError(language === "ur" ? "صرف ڈیلیور شدہ آرڈرز کا جائزہ لیا جا سکتا ہے۔" : "You can only review orders that have been delivered.");
        } else {
          setError(tDual("reviewSubmitError", language));
        }
        return;
      }

      onDone(String(target.id));
      onClose();
    } catch {
      setError(tDual("reviewSubmitError", language));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={0.7} style={rm.backdrop} onPress={onClose}>
        <TouchableOpacity activeOpacity={0.7} style={rm.sheet} onPress={() => {}}>
          <View style={rm.handle} />

          <View style={rm.headerIconWrap}>
            <LinearGradient colors={[C.gold, C.goldSoft]} style={rm.headerIcon}>
              <Ionicons name="star" size={24} color={C.textInverse} />
            </LinearGradient>
          </View>

          <Text style={rm.title}>Rate your experience</Text>
          <Text style={rm.sub}>
            {orderType === "ride"
              ? `Ride #${String(target.id)?.slice(-8).toUpperCase()}`
              : orderType === "pharmacy"
              ? `Pharmacy #${String(target.id)?.slice(-8).toUpperCase()}`
              : `Order #${String(target.id)?.slice(-8).toUpperCase()}`}
          </Text>

          {/* Primary star picker:
              - Ride orders    → rate the rider
              - Delivery orders → rate the vendor */}
          <Text style={rm.sectionLabel}>
            {isRideOrder ? t("rateYourRider") : isDualRating ? t("rateTheVendor") : t("rateYourExperience")}
          </Text>
          <StarPicker
            value={isRideOrder ? riderRating : vendorRating}
            onChange={isRideOrder ? setRiderRating : setVendorRating}
          />
          {(isRideOrder ? riderRating : vendorRating) > 0 && (
            <Text style={rm.ratingLabel}>{RATING_LABELS[isRideOrder ? riderRating : vendorRating]}</Text>
          )}

          {/* Secondary: separate rider rating on delivery orders that also have a rider */}
          {isDualRating && (
            <>
              <View style={rm.divider} />
              <Text style={rm.sectionLabel}>{t("rateDeliveryRider")}</Text>
              <StarPicker value={riderRating} onChange={setRiderRating} />
              {riderRating > 0 && (
                <Text style={rm.ratingLabel}>{RATING_LABELS[riderRating]}</Text>
              )}
            </>
          )}

          <TextInput
            style={rm.input}
            placeholder={t("shareExperiencePlaceholder")}
            placeholderTextColor={C.textMuted}
            value={comment}
            onChangeText={setComment}
            multiline
            numberOfLines={3}
            maxLength={300}
          />

          {error ? <Text style={rm.error}>{error}</Text> : null}

          <View style={rm.btns}>
            <TouchableOpacity activeOpacity={0.7} style={rm.cancelBtn} onPress={onClose}>
              <Text style={rm.cancelText}>{t("back")}</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[rm.submitBtn, primaryRating === 0 && { opacity: 0.5 }]}
              onPress={submit}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator size="small" color={C.textInverse} />
                : <Text style={rm.submitText}>{t("submitReview")}</Text>}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const rm = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: C.overlayDark50, justifyContent: "flex-end" },
  sheet:    { backgroundColor: C.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 40, maxHeight: "90%" },
  handle:   { width: 40, height: 4, backgroundColor: C.border, borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  headerIconWrap: { alignItems: "center", marginBottom: 14 },
  headerIcon: { width: 52, height: 52, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  title:    { ...Typ.h2, color: C.text, textAlign: "center", marginBottom: 4 },
  sub:      { ...Typ.body, fontSize: 13, color: C.textSecondary, textAlign: "center", marginBottom: 16 },
  sectionLabel: { ...Typ.buttonSmall, color: C.textSecondary, textAlign: "center", marginTop: 4, marginBottom: 2 },
  divider:  { height: 1, backgroundColor: C.border, marginVertical: 12 },
  ratingLabel: { ...Typ.bodySemiBold, color: C.amberBrown, textAlign: "center", marginBottom: 4, marginTop: 2 },
  input: {
    borderWidth: 1.5, borderColor: C.border, borderRadius: 16,
    padding: 14, ...Typ.body, color: C.text,
    minHeight: 72, textAlignVertical: "top", marginTop: 8, marginBottom: 8, backgroundColor: C.surfaceSecondary,
  },
  error:    { ...Typ.body, fontSize: 13, color: C.red, textAlign: "center", marginBottom: 8 },
  btns:     { flexDirection: "row", gap: 12, marginTop: 8 },
  cancelBtn: { flex: 1, borderWidth: 1.5, borderColor: C.border, borderRadius: 16, paddingVertical: 15, alignItems: "center" },
  cancelText:{ ...Typ.bodySemiBold, color: C.textSecondary },
  submitBtn: { flex: 2, backgroundColor: C.primary, borderRadius: 16, paddingVertical: 15, alignItems: "center", justifyContent: "center", shadowColor: C.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3 },
  submitText:{ ...Typ.body, fontFamily: Font.bold, color: C.textInverse },
});


function EmptyDetailPanel() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, backgroundColor: C.background }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
        <Ionicons name="receipt-outline" size={32} color={C.primary} />
      </View>
      <Text style={{ ...Typ.bodySemiBold, color: C.textSecondary, textAlign: "center" }}>Select an order to view details</Text>
    </View>
  );
}

function OrderDetailPanel({ id, type, orders, rides, pharmOrders, parcels, onClose }: {
  id: string; type: string;
  orders: OrderShape[]; rides: RideShape[]; pharmOrders: OrderShape[]; parcels: ParcelShape[];
  onClose: () => void;
}) {
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);

  const order = (() => {
    if (type === "ride") return rides.find(r => r.id === id) ?? null;
    if (type === "pharmacy") return pharmOrders.find(o => o.id === id) ?? null;
    if (type === "parcel") return parcels.find(b => b.id === id) ?? null;
    return orders.find(o => o.id === id) ?? null;
  })();

  const cfg = (() => {
    if (type === "ride") return RIDE_STATUS[order?.status ?? ""] || RIDE_STATUS["searching"]!;
    if (type === "parcel") return PARCEL_STATUS[order?.status ?? ""] || PARCEL_STATUS["pending"]!;
    return ORDER_STATUS[order?.status ?? ""] || ORDER_STATUS["pending"]!;
  })();

  const items: OrderItemShape[] = order?.items || [];
  const total = order?.total ?? order?.fare ?? order?.estimatedFare ?? 0;

  if (!order) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="alert-circle-outline" size={40} color={C.textMuted} />
        <Text style={{ ...Typ.body, color: C.textMuted, marginTop: 12 }}>Order not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.background }} contentContainerStyle={{ padding: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <Text style={{ ...Typ.h2, fontSize: 18, color: C.text }}>#{id.slice(-8).toUpperCase()}</Text>
        <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={{ padding: 6 }} accessibilityRole="button" accessibilityLabel="Close detail panel">
          <Ionicons name="close" size={22} color={C.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: cfg.bg, borderRadius: 14, padding: 14, marginBottom: 20 }}>
        <Ionicons name={cfg.icon as keyof typeof Ionicons.glyphMap} size={22} color={cfg.color} />
        <View>
          <Text style={{ ...Typ.h3, color: cfg.color, fontSize: 16 }}>{T(cfg.labelKey)}</Text>
          {order.createdAt && (
            <Text style={{ ...Typ.caption, color: C.textMuted, marginTop: 2 }}>
              {new Date(order.createdAt).toLocaleDateString()}
            </Text>
          )}
        </View>
      </View>

      {items.length > 0 && (
        <View style={{ backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 16 }}>
          {items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: i < items.length - 1 ? 1 : 0, borderBottomColor: C.borderLight }}>
              <Text style={{ ...Typ.body, color: C.text, flex: 1 }} numberOfLines={2}>{item.quantity}× {item.name}</Text>
              <Text style={{ ...Typ.bodySemiBold, color: C.text }}>Rs. {item.price * item.quantity}</Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 10, marginTop: 4, borderTopWidth: 1, borderTopColor: C.borderLight }}>
            <Text style={{ ...Typ.bodySemiBold, color: C.text }}>Total</Text>
            <Text style={{ ...Typ.h3, color: C.primary, fontSize: 16 }}>Rs. {Number(total).toLocaleString()}</Text>
          </View>
        </View>
      )}

      {(type === "ride" || type === "parcel") && (order.pickupAddress || order.dropAddress) && (
        <View style={{ backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 16 }}>
          {order.pickupAddress && (
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.emerald }} />
              <Text style={{ ...Typ.body, color: C.text, flex: 1 }} numberOfLines={2}>{order.pickupAddress}</Text>
            </View>
          )}
          {order.dropAddress && (
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.red }} />
              <Text style={{ ...Typ.body, color: C.text, flex: 1 }} numberOfLines={2}>{order.dropAddress}</Text>
            </View>
          )}
          {Number(total) > 0 && (
            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 10, marginTop: 8, borderTopWidth: 1, borderTopColor: C.borderLight }}>
              <Text style={{ ...Typ.bodySemiBold, color: C.text }}>Fare</Text>
              <Text style={{ ...Typ.h3, color: C.primary, fontSize: 16 }}>Rs. {Number(total).toLocaleString()}</Text>
            </View>
          )}
        </View>
      )}

      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => router.push({ pathname: "/orders/[id]", params: { id, type } })}
        style={{ backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Open full order detail page"
      >
        <Ionicons name="open-outline" size={16} color={C.textInverse} />
        <Text style={{ ...Typ.bodySemiBold, color: C.textInverse }}>Open Full Details</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function SectionHeader({ title, count, active }: { title: string; count: number; active?: boolean }) {
  return (
    <View style={styles.secRow}>
      {active && <View style={styles.activeDot} />}
      <Text style={[styles.secTitle, !active && { color: C.textSecondary }]}>{title}</Text>
      <View style={[styles.countBadge, active ? { backgroundColor: C.primary } : { backgroundColor: C.textMuted }]}>
        <Text style={styles.countText}>{count}</Text>
      </View>
    </View>
  );
}

function OrdersScreenInner() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { user, token } = useAuth();
  const queryClient = useQueryClient();
  const { addItem } = useCart();
  const { showToast } = useToast();
  const { config } = usePlatformConfig();
  const { language } = useLanguage();
  const T = (key: Parameters<typeof tDual>[0]) => tDual(key, language);
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [reviewTarget, setReviewTarget] = useState<OrderShape | RideShape | ParcelShape | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [selectedOrder, setSelectedOrder] = useState<{ id: string; type: string } | null>(null);
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const TAB_H  = Platform.OS === "web" ? 84 : 49;
  const { statsOpacity, statsMaxHeight, subtitleOpacity, subtitleMaxHeight, scrollHandler, scrollEventThrottle } = useCollapsibleHeader({ expandedHeight: 140, collapsedHeight: 60, scrollThreshold: 80, statsRowHeight: 40 });

  /* Responsive breakpoints: ≥768 = tablet, ≥1080 = desktop wide */
  const isTablet = Platform.OS === "web" && screenWidth >= 768;
  const isWide   = Platform.OS === "web" && screenWidth >= 1080;

  const orderRules = config.orderRules;

  const svcFeatures = config.features;
  const martActive = svcFeatures.mart;
  const foodActive = svcFeatures.food;
  const ridesActive = svcFeatures.rides;
  const pharmActive = svcFeatures.pharmacy;
  const parcelActive = svcFeatures.parcel;
  const anyMartFood = martActive || foodActive;

  const visibleTabs = TABS.filter(tab => {
    if (tab.key === "all") return true;
    if (tab.key === "mart") return martActive;
    if (tab.key === "food") return foodActive;
    if (tab.key === "rides") return ridesActive;
    if (tab.key === "pharmacy") return pharmActive;
    if (tab.key === "parcel") return parcelActive;
    return true;
  });

  React.useEffect(() => {
    if (!visibleTabs.some(t => t.key === activeTab)) {
      setActiveTab("all");
    }
  }, [martActive, foodActive, ridesActive, pharmActive, parcelActive]);

  const handleReorder = useCallback(async (order: OrderShape) => {
    if (!order.items || order.items.length === 0) return;
    const validItems = order.items.filter((i: OrderItemShape) => i.name && Number(i.price) > 0);
    if (validItems.length === 0) {
      showToast("Items from this order are no longer available", "error");
      return;
    }
    try {
      const productsRes = await fetch(`${API_BASE}/products`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (productsRes.ok) {
        interface LiveProduct { id: string; price: number; stock?: number; }
        const productsData = unwrapApiResponse<{ products?: LiveProduct[] } | LiveProduct[]>(await productsRes.json());
        const productList: LiveProduct[] = Array.isArray(productsData) ? productsData : (productsData.products || []);
        const productMap = new Map<string, LiveProduct>(productList.map((p: LiveProduct) => [p.id, p]));
        const priceChangedItems: string[] = [];
        let skippedCount = 0;
        let addedCount = 0;
        for (const item of validItems) {
          const liveProduct = item.productId ? productMap.get(item.productId) : undefined;
          if (liveProduct && liveProduct.stock === 0) { skippedCount++; continue; }
          const livePrice = liveProduct ? liveProduct.price : item.price;
          if (liveProduct && Number(liveProduct.price) !== Number(item.price)) {
            priceChangedItems.push(item.name);
          }
          addItem({ productId: item.productId ?? "", name: item.name, price: livePrice, quantity: item.quantity || 1, image: item.image, type: ((order.type as "mart" | "food" | "pharmacy") || "mart") });
          addedCount++;
        }
        if (skippedCount > 0 && priceChangedItems.length > 0) {
          showToast(`${addedCount} items added. ${skippedCount} out of stock skipped. Prices updated for: ${priceChangedItems.slice(0,2).join(", ")}`, "info");
        } else if (skippedCount > 0) {
          showToast(`${addedCount} items added — ${skippedCount} out of stock items skipped`, "info");
        } else if (priceChangedItems.length > 0) {
          showToast(`${addedCount} items added. Note: prices have changed for ${priceChangedItems.length} item(s)`, "info");
        } else {
          showToast(`${addedCount} items added to cart`, "success");
        }
        if (addedCount > 0) router.push("/cart");
        return;
      }
    } catch (err) {
      if (__DEV__) console.warn("[Orders] Reorder live-price fetch failed:", err instanceof Error ? err.message : String(err));
    }
    let count = 0;
    for (const item of validItems) {
      addItem({ productId: item.productId ?? "", name: item.name, price: item.price, quantity: item.quantity || 1, image: item.image, type: ((order.type as "mart" | "food" | "pharmacy") || "mart") });
      count++;
    }
    showToast(`${count} items added to cart — stock and prices may have changed since your last order`, "info");
    router.push("/cart");
  }, [addItem, showToast, token]);

  const handleRate = useCallback((order: OrderShape) => {
    if (!reviewedIds.has(order.id)) setReviewTarget(order);
  }, [reviewedIds]);

  const handleReviewDone = useCallback((orderId: string) => {
    setReviewedIds(prev => new Set([...prev, orderId]));
    AsyncStorage.getItem("review_prompted_ids")
      .then(raw => {
        let ids: string[] = [];
        try { ids = raw ? JSON.parse(raw) : []; } catch (parseErr) {
          console.warn("[Orders] Failed to parse review_prompted_ids:", parseErr);
        }
        if (!ids.includes(orderId)) {
          ids = [...ids, orderId];
          AsyncStorage.setItem("review_prompted_ids", JSON.stringify(ids)).catch((err) => {
            console.warn("[Orders] Failed to save review prompted ids:", err);
          });
        }
      })
      .catch((err) => {
        console.warn("[Orders] Failed to read review prompted ids:", err);
      });
  }, []);

  const autoPromptedIdsRef = React.useRef<Set<string>>(new Set());

  const [hasActiveItems, setHasActiveItems] = useState(false);
  const pollInterval = hasActiveItems ? 10000 : 30000;
  const [historyLimit, setHistoryLimit] = useState(5);

  const { data: ordersData, isLoading: ordersLoading, refetch: refetchOrders } = useGetOrders(
    { userId: user?.id || "" },
    { query: { queryKey: ["orders", user?.id, pollInterval] as const, enabled: !!user?.id && anyMartFood, refetchInterval: pollInterval } }
  );

  const [ridesData, setRidesData] = useState<{ rides?: RideShape[] } | null>(null);
  const [ridesLoading, setRidesLoading] = useState(false);
  const [ridesError, setRidesError] = useState(false);
  const isFetchingRidesRef = useRef(false);

  const [pharmData, setPharmData] = useState<{ orders?: OrderShape[] } | null>(null);
  const [pharmLoading, setPharmLoading] = useState(false);
  const [pharmError, setPharmError] = useState(false);
  const isFetchingPharmRef = useRef(false);

  const [parcelData, setParcelData] = useState<{ bookings?: ParcelShape[]; parcelBookings?: ParcelShape[] } | null>(null);
  const [parcelLoading, setParcelLoading] = useState(false);
  const [parcelError, setParcelError] = useState(false);
  const isFetchingParcelRef = useRef(false);
  const [serverNow, setServerNow] = useState<number>(Date.now());

  const listSocketRef = useRef<Socket | null>(null);
  useEffect(() => {
    if (!user?.id || !token) return;
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    if (!domain) return;

    let socket: Socket | null = null;
    let unmounted = false;

    import("socket.io-client").then(({ io }) => {
      if (unmounted) return;
      socket = io(`https://${domain}`, {
        path: "/api/socket.io",
        auth: { token },
        extraHeaders: { Authorization: `Bearer ${token}` },
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 16000,
      });
      listSocketRef.current = socket;

      type OrderUpdate = { id: string; status?: string; [key: string]: unknown };
      socket.on("order:update", (updated: OrderUpdate) => {
        if (!updated?.id) return;
        /* Mart/food: patch React Query cache in-place to avoid full network round-trip */
        queryClient.setQueryData(
          getGetOrdersQueryKey({ userId: user?.id || "" }),
          (old: { orders?: OrderShape[] } | undefined) => {
            if (!old?.orders) return old;
            const idx = old.orders.findIndex((o) => o.id === updated.id);
            if (idx === -1) return old;
            const next = [...old.orders];
            next[idx] = { ...next[idx], ...updated } as OrderShape;
            return { ...old, orders: next };
          }
        );
        /* Rides: patch in-place */
        setRidesData((prev: { rides?: RideShape[] } | null) => {
          if (!prev?.rides) return prev;
          const idx = prev.rides.findIndex((r) => r.id === updated.id);
          if (idx === -1) return prev;
          const next = [...prev.rides];
          next[idx] = { ...next[idx], ...updated } as RideShape;
          return { ...prev, rides: next };
        });
        /* Pharmacy: patch in-place */
        setPharmData((prev: { orders?: OrderShape[] } | null) => {
          if (!prev?.orders) return prev;
          const idx = prev.orders.findIndex((o) => o.id === updated.id);
          if (idx === -1) return prev;
          const next = [...prev.orders];
          next[idx] = { ...next[idx], ...updated } as OrderShape;
          return { ...prev, orders: next };
        });
        /* Parcels: patch in-place */
        setParcelData((prev: { bookings?: ParcelShape[] } | null) => {
          if (!prev?.bookings) return prev;
          const idx = prev.bookings.findIndex((b) => b.id === updated.id);
          if (idx === -1) return prev;
          const next = [...prev.bookings];
          next[idx] = { ...next[idx], ...updated } as ParcelShape;
          return { ...prev, bookings: next };
        });
      });
    });

    return () => {
      unmounted = true;
      socket?.disconnect();
      listSocketRef.current = null;
    };
  }, [user?.id, token]);


  const fetchServerTime = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/platform-config`, { method: "HEAD" });
      const serverDate = res.headers.get("Date");
      if (serverDate) setServerNow(new Date(serverDate).getTime());
    } catch (err) {
      if (__DEV__) console.warn("[Orders] Server time sync failed:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const handleCancel = useCallback((order: OrderShape) => {
    const nowMs = serverNow ?? Date.now();
    const minutesSincePlaced = order.createdAt
      ? (nowMs - new Date(order.createdAt).getTime()) / 60000
      : 999;
    const cancelMinsLeft = Math.max(0, Math.ceil(orderRules.cancelWindowMin - minutesSincePlaced));
    setCancelTarget({
      id: order.id,
      type: "order",
      status: order.status,
      total: order.total,
      paymentMethod: order.paymentMethod,
      cancelMinsLeft,
    });
  }, [orderRules.cancelWindowMin, serverNow]);

  const handleCancelPharmacy = useCallback((order: OrderShape) => {
    const nowMs = serverNow ?? Date.now();
    const minutesSincePlaced = order.createdAt
      ? (nowMs - new Date(order.createdAt).getTime()) / 60000
      : 999;
    const cancelMinsLeft = Math.max(0, Math.ceil(orderRules.cancelWindowMin - minutesSincePlaced));
    setCancelTarget({
      id: order.id,
      type: "pharmacy",
      status: order.status,
      total: order.total,
      paymentMethod: order.paymentMethod,
      cancelMinsLeft,
    });
  }, [orderRules.cancelWindowMin, serverNow]);

  const fetchRides = useCallback(async () => {
    if (!user?.id || !ridesActive || isFetchingRidesRef.current) return;
    isFetchingRidesRef.current = true;
    setRidesLoading(true);
    try {
      const res = await fetch(`${API_BASE}/rides`, { headers: authHeaders });
      const serverDate = res.headers.get("Date");
      if (serverDate) setServerNow(new Date(serverDate).getTime());
      const d = unwrapApiResponse(await res.json());
      setRidesData(d);
      setRidesError(false);
    } catch (err) {
      if (__DEV__) console.warn("[Orders] Rides fetch failed:", err instanceof Error ? err.message : String(err));
      setRidesError(true);
    } finally {
      setRidesLoading(false);
      isFetchingRidesRef.current = false;
    }
  }, [user?.id, token, ridesActive]);

  const fetchPharmacy = useCallback(async () => {
    if (!user?.id || !pharmActive || isFetchingPharmRef.current) return;
    isFetchingPharmRef.current = true;
    setPharmLoading(true);
    try {
      const res = await fetch(`${API_BASE}/pharmacy-orders`, { headers: authHeaders });
      const serverDate = res.headers.get("Date");
      if (serverDate) setServerNow(new Date(serverDate).getTime());
      const d = unwrapApiResponse(await res.json());
      setPharmData(d);
      setPharmError(false);
    } catch (err) {
      if (__DEV__) console.warn("[Orders] Pharmacy fetch failed:", err instanceof Error ? err.message : String(err));
      setPharmError(true);
    } finally {
      setPharmLoading(false);
      isFetchingPharmRef.current = false;
    }
  }, [user?.id, token, pharmActive]);

  const fetchParcel = useCallback(async () => {
    if (!user?.id || !parcelActive || isFetchingParcelRef.current) return;
    isFetchingParcelRef.current = true;
    setParcelLoading(true);
    try {
      const res = await fetch(`${API_BASE}/parcel-bookings`, { headers: authHeaders });
      const serverDate = res.headers.get("Date");
      if (serverDate) setServerNow(new Date(serverDate).getTime());
      const d = unwrapApiResponse(await res.json());
      setParcelData(d);
      setParcelError(false);
    } catch (err) {
      if (__DEV__) console.warn("[Orders] Parcel fetch failed:", err instanceof Error ? err.message : String(err));
      setParcelError(true);
    } finally {
      setParcelLoading(false);
      isFetchingParcelRef.current = false;
    }
  }, [user?.id, token, parcelActive]);

  const handleCancelRide = useCallback((ride: RideShape) => {
    const riderAssigned = ["accepted", "arrived", "in_transit", "ongoing"].includes(ride.status);
    setCancelTarget({
      id: ride.id,
      type: "ride",
      status: ride.status,
      fare: ride.fare,
      paymentMethod: ride.paymentMethod,
      riderAssigned,
    });
  }, []);

  React.useEffect(() => {
    fetchServerTime();
    if (user?.id) {
      fetchRides();
      fetchPharmacy();
      fetchParcel();
    }
  }, [user?.id, ridesActive, pharmActive, parcelActive]);

  React.useEffect(() => {
    if (!user?.id) return;
    const interval = setInterval(() => {
      fetchRides();
      fetchPharmacy();
      fetchParcel();
    }, pollInterval);
    return () => clearInterval(interval);
  }, [user?.id, fetchRides, fetchPharmacy, fetchParcel, pollInterval]);

  const onRefresh = useCallback(async () => {
    await Promise.all([fetchServerTime(), refetchOrders(), fetchRides(), fetchPharmacy(), fetchParcel()]);
    setLastRefreshed(new Date());
  }, [fetchServerTime, refetchOrders, fetchRides, fetchPharmacy, fetchParcel]);

  /* API already returns orders newest-first (ORDER BY createdAt DESC).
     Do NOT reverse — that would flip to oldest-first. */
  const rawOrders: OrderShape[] = [...((ordersData?.orders as OrderShape[] | undefined) || [])];
  const allOrders = rawOrders.filter((o: OrderShape) =>
    (o.type === "mart" && martActive) || (o.type === "food" && foodActive)
  );
  const martOrders = martActive ? allOrders.filter((o: OrderShape) => o.type === "mart") : [];
  const foodOrders = foodActive ? allOrders.filter((o: OrderShape) => o.type === "food") : [];
  const rides = ridesActive ? (ridesData?.rides || []) : [];
  const pharmOrders = pharmActive ? (pharmData?.orders || (pharmData as { pharmacyOrders?: OrderShape[] })?.pharmacyOrders || []) : [];
  const parcels = parcelActive ? (parcelData?.bookings || parcelData?.parcelBookings || []) : [];

  const totalCount = allOrders.length + rides.length + pharmOrders.length + parcels.length;

  const globalActiveCount =
    allOrders.filter(o => !["delivered", "cancelled"].includes(o.status)).length +
    rides.filter((r) => !["completed", "cancelled"].includes(r.status)).length +
    pharmOrders.filter((o) => !["delivered", "cancelled"].includes(o.status)).length +
    parcels.filter((b) => !["completed", "cancelled"].includes(b.status)).length;

  React.useEffect(() => {
    setHasActiveItems(globalActiveCount > 0);
  }, [globalActiveCount]);

  const deliveredOrderIds = React.useMemo(
    () => allOrders.filter(o => o.status === "delivered").map(o => o.id).join(","),
    [allOrders]
  );

  React.useEffect(() => {
    if (!config.features.reviews) return;
    const deliveredOrders = allOrders.filter(o => o.status === "delivered");
    if (deliveredOrders.length === 0) return;
    AsyncStorage.getItem("review_prompted_ids")
      .then(raw => {
        let persistedIds: string[] = [];
        try { persistedIds = raw ? JSON.parse(raw) : []; } catch (parseErr) {
          console.warn("[Orders] Failed to parse review_prompted_ids for auto-prompt:", parseErr);
        }
        const toPrompt = deliveredOrders.find(o =>
          !persistedIds.includes(o.id) &&
          !reviewedIds.has(o.id) &&
          !autoPromptedIdsRef.current.has(o.id)
        );
        if (toPrompt) {
          autoPromptedIdsRef.current.add(toPrompt.id);
          const nextIds = [...persistedIds, toPrompt.id];
          AsyncStorage.setItem("review_prompted_ids", JSON.stringify(nextIds)).catch((err) => {
            console.warn("[Orders] Failed to persist auto-prompted review ids:", err);
          });
          setTimeout(() => { setReviewTarget(toPrompt); }, 800);
        }
      })
      .catch((err) => {
        console.warn("[Orders] Failed to read review prompted ids for auto-prompt:", err);
      });
  }, [deliveredOrderIds, config.features.reviews]);

  const isLoading = ordersLoading || ridesLoading || pharmLoading || parcelLoading;

  const renderContent = () => {
    if (isLoading && totalCount === 0) {
      return (
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ backgroundColor: C.surface, borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <SkeletonBlock w={120} h={14} r={6} />
                <SkeletonBlock w={60} h={14} r={6} />
              </View>
              <SkeletonBlock w="80%" h={12} r={6} />
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs }}>
                <SkeletonBlock w={90} h={12} r={6} />
                <SkeletonBlock w={70} h={24} r={radii.sm} />
              </View>
            </View>
          ))}
        </View>
      );
    }

    if (totalCount === 0) {
      const quickServices = [
        martActive    && { route: "/mart",     icon: "storefront-outline",  label: "Mart",      color: C.brandBlue,  bg: C.brandBlueSoft },
        foodActive    && { route: "/food",     icon: "restaurant-outline",  label: "Food",      color: C.amber,      bg: C.amberSoft },
        ridesActive   && { route: "/ride",     icon: "car-outline",         label: "Ride",      color: C.emerald,    bg: C.emeraldSoft },
        pharmActive   && { route: "/pharmacy", icon: "medical-outline",     label: "Pharmacy",  color: C.purple,     bg: C.purpleSoft },
        parcelActive  && { route: "/parcel",   icon: "cube-outline",        label: "Parcel",    color: C.amberBrown, bg: C.amberBg },
      ].filter(Boolean) as { route: string; icon: string; label: string; color: string; bg: string }[];

      return (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIllustration}>
            <LinearGradient colors={[C.brandBlueSoft, C.blueSoft]} style={styles.emptyIllustrationBg}>
              <View style={styles.emptyIllustrationInner}>
                <Ionicons name="receipt-outline" size={52} color={C.primary} />
              </View>
            </LinearGradient>
            <View style={styles.emptyBadge}>
              <Ionicons name="sparkles" size={14} color={C.amber} />
            </View>
          </View>

          <Text style={styles.emptyHeading}>No orders yet</Text>
          <Text style={styles.emptySubtext}>Start exploring and your orders,{"\n"}rides & bookings will appear here</Text>

          {quickServices.length > 0 && (
            <>
              <Text style={styles.emptyServicesLabel}>Quick Start</Text>
              <View style={styles.emptyServicesGrid}>
                {quickServices.map(svc => (
                  <TouchableOpacity activeOpacity={0.7}
                    key={svc.route}
                    onPress={() => router.push(svc.route as RelativePathString)}
                    style={[styles.emptyServiceCard, { backgroundColor: svc.bg, borderColor: svc.color + "30" }]}
                    accessibilityRole="button"
                  >
                    <View style={[styles.emptyServiceIconWrap, { backgroundColor: svc.color + "20" }]}>
                      <Ionicons name={svc.icon as keyof typeof Ionicons.glyphMap} size={22} color={svc.color} />
                    </View>
                    <Text style={[styles.emptyServiceLabel, { color: svc.color }]}>{svc.label}</Text>
                    <Ionicons name="arrow-forward" size={12} color={svc.color + "99"} />
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </View>
      );
    }

    let showOrders: OrderShape[] = [];
    let showMart: OrderShape[] = [];
    let showFood: OrderShape[] = [];
    let showRides: RideShape[] = rides;
    let showPharm: OrderShape[] = pharmOrders;
    let showParcel: ParcelShape[] = parcels;

    switch (activeTab) {
      case "all":
        showOrders = allOrders;
        break;
      case "mart":
        showMart = martOrders;
        showOrders = [];
        break;
      case "food":
        showFood = foodOrders;
        showOrders = [];
        break;
      case "rides":
        showOrders = [];
        showPharm = [];
        showParcel = [];
        break;
      case "pharmacy":
        showOrders = [];
        showRides = [];
        showParcel = [];
        break;
      case "parcel":
        showOrders = [];
        showRides = [];
        showPharm = [];
        break;
    }

    const displayOrders = activeTab === "all" ? allOrders : activeTab === "mart" ? showMart : activeTab === "food" ? showFood : [];
    const displayRides  = ["all", "rides"].includes(activeTab) ? showRides : [];
    const displayPharm  = ["all", "pharmacy"].includes(activeTab) ? showPharm : [];
    const displayParcel = ["all", "parcel"].includes(activeTab) ? showParcel : [];

    const activeOrders   = displayOrders.filter(o => !["delivered","cancelled"].includes(o.status));
    const pastOrders     = displayOrders.filter(o => ["delivered","cancelled"].includes(o.status));
    const activeRides    = displayRides.filter(r => !["completed","cancelled"].includes(r.status));
    const pastRides      = displayRides.filter(r => ["completed","cancelled"].includes(r.status));
    const activePharm    = displayPharm.filter(o => !["delivered","cancelled"].includes(o.status));
    const pastPharm      = displayPharm.filter(o => ["delivered","cancelled"].includes(o.status));
    const activeParcel   = displayParcel.filter(b => !["completed","cancelled"].includes(b.status));
    const pastParcel     = displayParcel.filter(b => ["completed","cancelled"].includes(b.status));

    const anyActive = activeOrders.length + activeRides.length + activePharm.length + activeParcel.length;
    const anyPast   = pastOrders.length + pastRides.length + pastPharm.length + pastParcel.length;

    if (anyActive + anyPast === 0) {
      const tabMeta: Record<string, { icon: string; label: string; msg: string; route?: string; color: string; bg: string }> = {
        all:      { icon: "receipt-outline",     label: "No orders yet",             msg: "Your order history will appear here once you place an order.",   color: C.primary,     bg: C.blueSoft },
        mart:     { icon: "storefront-outline",  label: "No mart orders yet",        msg: "Browse the mart and add items to start shopping.",               route: "/mart",       color: C.brandBlue,  bg: C.brandBlueSoft },
        food:     { icon: "restaurant-outline",  label: "No food orders yet",        msg: "Order delicious food from nearby restaurants.",                  route: "/food",       color: C.amber,      bg: C.amberSoft },
        rides:    { icon: "car-outline",         label: "No rides yet",              msg: "Book your first ride — safe, fast and affordable.",              route: "/ride",       color: C.emerald,    bg: C.emeraldSoft },
        pharmacy: { icon: "medical-outline",     label: "No pharmacy orders yet",    msg: "Order medicines and healthcare products with ease.",              route: "/pharmacy",   color: C.purple,     bg: C.purpleSoft },
        parcel:   { icon: "cube-outline",        label: "No parcel bookings yet",    msg: "Send parcels across the city quickly and safely.",               route: "/parcel",     color: C.amberBrown, bg: C.amberBg },
      };
      const meta = tabMeta[activeTab] ?? tabMeta["all"]!;
      return (
        <View style={styles.emptyFilterWrap}>
          <View style={[styles.emptyFilterIconBox, { backgroundColor: meta.bg }]}>
            <Ionicons name={meta.icon as keyof typeof Ionicons.glyphMap} size={38} color={meta.color} />
          </View>
          <Text style={styles.emptyFilterTitle}>{meta.label}</Text>
          <Text style={styles.emptyFilterSub}>{meta.msg}</Text>
          {meta.route && (
            <TouchableOpacity activeOpacity={0.7}
              onPress={() => router.push(meta.route as RelativePathString)}
              style={[styles.emptyFilterBtn, { backgroundColor: meta.color }]}
              accessibilityRole="button"
            >
              <Ionicons name="arrow-forward-circle-outline" size={16} color={C.textInverse} />
              <Text style={styles.emptyFilterBtnText}>Explore {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    const showRidesErr  = ridesError  && ridesData  === null && ["all", "rides"].includes(activeTab);
    const showPharmErr  = pharmError  && pharmData  === null && ["all", "pharmacy"].includes(activeTab);
    const showParcelErr = parcelError && parcelData === null && ["all", "parcel"].includes(activeTab);

    return (
      <SmartRefresh
        onRefresh={onRefresh}
        lastUpdated={lastRefreshed}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        onScroll={scrollHandler}
        scrollEventThrottle={scrollEventThrottle}
      >
        {showRidesErr && (
          <TouchableOpacity activeOpacity={0.7} onPress={fetchRides} style={styles.sectionErrBanner} accessibilityRole="button" accessibilityLabel="Could not load ride orders, tap to retry">
            <Ionicons name="car-outline" size={15} color={C.redDark} />
            <Text style={styles.sectionErrTxt}>Could not load ride orders</Text>
            <Text style={styles.sectionErrRetry}>Tap to retry</Text>
          </TouchableOpacity>
        )}
        {showPharmErr && (
          <TouchableOpacity activeOpacity={0.7} onPress={fetchPharmacy} style={styles.sectionErrBanner} accessibilityRole="button" accessibilityLabel="Could not load pharmacy orders, tap to retry">
            <Ionicons name="medical-outline" size={15} color={C.redDark} />
            <Text style={styles.sectionErrTxt}>Could not load pharmacy orders</Text>
            <Text style={styles.sectionErrRetry}>Tap to retry</Text>
          </TouchableOpacity>
        )}
        {showParcelErr && (
          <TouchableOpacity activeOpacity={0.7} onPress={fetchParcel} style={styles.sectionErrBanner} accessibilityRole="button" accessibilityLabel="Could not load parcel bookings, tap to retry">
            <Ionicons name="cube-outline" size={15} color={C.redDark} />
            <Text style={styles.sectionErrTxt}>Could not load parcel bookings</Text>
            <Text style={styles.sectionErrRetry}>Tap to retry</Text>
          </TouchableOpacity>
        )}
        {anyActive > 0 && (
          <>
            <SectionHeader title={T("activeLabel")} count={anyActive} active />
            <View style={isWide ? styles.cardGrid : undefined}>
              {activeOrders.map(o => <View key={`order-${o.id}`} style={isWide ? styles.cardGridItem : undefined}><OrderCard order={{ ...o, _reviewed: reviewedIds.has(o.id) }} liveTracking={config.features.liveTracking} reviews={config.features.reviews} cancelWindowMin={orderRules.cancelWindowMin} refundDays={orderRules.refundDays} ratingWindowHours={orderRules.ratingWindowHours} serverNow={serverNow} onRate={handleRate} onCancel={handleCancel} onReorder={handleReorder} onCardPress={isWide ? () => setSelectedOrder({ id: o.id, type: o.type || "mart" }) : undefined} /></View>)}
              {activeRides.map(r => <View key={`ride-${r.id}`} style={isWide ? styles.cardGridItem : undefined}><RideCard ride={{ ...r, _reviewed: reviewedIds.has(r.id) }} liveTracking={config.features.liveTracking} reviews={config.features.reviews} ratingWindowHours={orderRules.ratingWindowHours} serverNow={serverNow} onRate={handleRate} onCancel={handleCancelRide} onCardPress={isWide ? () => setSelectedOrder({ id: r.id, type: "ride" }) : undefined} /></View>)}
              {activePharm.map(o => <View key={`pharm-${o.id}`} style={isWide ? styles.cardGridItem : undefined}><PharmacyCard order={{ ...o, _reviewed: reviewedIds.has(o.id) }} reviews={config.features.reviews} cancelWindowMin={orderRules.cancelWindowMin} serverNow={serverNow} onRate={handleRate} onCancel={handleCancelPharmacy} onCardPress={isWide ? () => setSelectedOrder({ id: o.id, type: "pharmacy" }) : undefined} /></View>)}
              {activeParcel.map(b => <View key={`parcel-${b.id}`} style={isWide ? styles.cardGridItem : undefined}><ParcelCard booking={b} onCardPress={isWide ? () => setSelectedOrder({ id: b.id, type: "parcel" }) : undefined} /></View>)}
            </View>
          </>
        )}

        {anyPast > 0 && (
          <>
            <SectionHeader title={T("historyLabel")} count={anyPast} />
            <View style={isWide ? styles.cardGrid : undefined}>
              {pastOrders.slice(0, historyLimit).map(o => <View key={`order-${o.id}`} style={isWide ? styles.cardGridItem : undefined}><OrderCard order={{ ...o, _reviewed: reviewedIds.has(o.id) }} liveTracking={config.features.liveTracking} reviews={config.features.reviews} cancelWindowMin={orderRules.cancelWindowMin} refundDays={orderRules.refundDays} ratingWindowHours={orderRules.ratingWindowHours} serverNow={serverNow} onRate={handleRate} onCancel={handleCancel} onReorder={handleReorder} onCardPress={isWide ? () => setSelectedOrder({ id: o.id, type: o.type || "mart" }) : undefined} /></View>)}
              {pastRides.slice(0, historyLimit).map(r => <View key={`ride-${r.id}`} style={isWide ? styles.cardGridItem : undefined}><RideCard ride={{ ...r, _reviewed: reviewedIds.has(r.id) }} liveTracking={config.features.liveTracking} reviews={config.features.reviews} ratingWindowHours={orderRules.ratingWindowHours} serverNow={serverNow} onRate={handleRate} onCancel={handleCancelRide} onCardPress={isWide ? () => setSelectedOrder({ id: r.id, type: "ride" }) : undefined} /></View>)}
              {pastPharm.slice(0, historyLimit).map(o => <View key={`pharm-${o.id}`} style={isWide ? styles.cardGridItem : undefined}><PharmacyCard order={{ ...o, _reviewed: reviewedIds.has(o.id) }} reviews={config.features.reviews} cancelWindowMin={orderRules.cancelWindowMin} serverNow={serverNow} onRate={handleRate} onCancel={handleCancelPharmacy} onCardPress={isWide ? () => setSelectedOrder({ id: o.id, type: "pharmacy" }) : undefined} /></View>)}
              {pastParcel.slice(0, historyLimit).map(b => <View key={`parcel-${b.id}`} style={isWide ? styles.cardGridItem : undefined}><ParcelCard booking={b} onCardPress={isWide ? () => setSelectedOrder({ id: b.id, type: "parcel" }) : undefined} /></View>)}
            </View>
            {anyPast > historyLimit && (
              <TouchableOpacity activeOpacity={0.7}
                onPress={() => setHistoryLimit(l => l + 5)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, backgroundColor: C.background, borderRadius: 16, marginTop: 4, borderWidth: 1, borderColor: C.border }}
                accessibilityRole="button"
                accessibilityLabel={`Load more, ${anyPast - historyLimit} remaining`}
              >
                <Ionicons name="chevron-down" size={16} color={C.primary} />
                <Text style={{ ...Typ.bodySemiBold, color: C.primary }}>
                  Load More ({anyPast - historyLimit} remaining)
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <View style={{ height: TAB_H + insets.bottom + 20 }} />
      </SmartRefresh>
    );
  };

  if (!user?.id) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingTop: topPad }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
          <Ionicons name="receipt-outline" size={32} color={C.primary} />
        </View>
        <Text style={{ fontFamily: Font.bold, fontSize: 20, color: C.text, textAlign: "center", marginBottom: 8 }}>{T("signInToContinue")}</Text>
        <Text style={{ fontFamily: Font.regular, fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22, marginBottom: 28 }}>
          {T("signInOrdersSub")}
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={async () => {
            await AsyncStorage.setItem("@ajkmart_auth_return_to", "/(tabs)/orders");
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
          {`You're signed in as a ${(user.roles ?? []).join(", ")} account. Orders and bookings are only available for customer accounts.`}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: C.background }]}>
      <LinearGradient
        colors={["#0047B3", "#0066FF", "#4D94FF"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.header, { paddingTop: topPad + 14 }]}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>{T("myOrders")}</Text>
            <Animated.Text style={[styles.headerSub, { opacity: subtitleOpacity, maxHeight: subtitleMaxHeight }]}>
              {totalCount > 0 ? `${totalCount} total bookings` : "Track all your activity"}
            </Animated.Text>
          </View>
          {globalActiveCount > 0 && (
            <View style={styles.headerActivePill}>
              <View style={styles.headerActiveDot} />
              <Text style={styles.headerActiveText}>{globalActiveCount} Active</Text>
            </View>
          )}
        </View>

        {totalCount > 0 && (
          <Animated.View style={[styles.headerStats, { opacity: statsOpacity, maxHeight: statsMaxHeight, overflow: "hidden" }]}>
            {martOrders.length > 0 && (
              <View style={styles.headerStat}>
                <Ionicons name="storefront-outline" size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.headerStatText}>{martOrders.length} Mart</Text>
              </View>
            )}
            {foodOrders.length > 0 && (
              <View style={styles.headerStat}>
                <Ionicons name="restaurant-outline" size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.headerStatText}>{foodOrders.length} Food</Text>
              </View>
            )}
            {rides.length > 0 && (
              <View style={styles.headerStat}>
                <Ionicons name="car-outline" size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.headerStatText}>{rides.length} Rides</Text>
              </View>
            )}
            {pharmOrders.length > 0 && (
              <View style={styles.headerStat}>
                <Ionicons name="medical-outline" size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.headerStatText}>{pharmOrders.length} Pharmacy</Text>
              </View>
            )}
            {parcels.length > 0 && (
              <View style={styles.headerStat}>
                <Ionicons name="cube-outline" size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.headerStatText}>{parcels.length} Parcels</Text>
              </View>
            )}
          </Animated.View>
        )}
      </LinearGradient>

      {visibleTabs.length > 1 && (
        <View style={styles.tabsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
            {visibleTabs.map(tab => {
              const count =
                tab.key === "all"      ? totalCount :
                tab.key === "mart"     ? martOrders.length :
                tab.key === "food"     ? foodOrders.length :
                tab.key === "rides"    ? rides.length :
                tab.key === "pharmacy" ? pharmOrders.length :
                parcels.length;

              const isActive = activeTab === tab.key;
              return (
                <TouchableOpacity activeOpacity={0.7}
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  style={[styles.tab, isActive && styles.tabActive]}
                  accessibilityRole="tab"
                  accessibilityLabel={`${T(tab.labelKey)}${count > 0 ? `, ${count}` : ""}`}
                  accessibilityState={{ selected: isActive }}
                >
                  <Ionicons
                    name={tab.icon as keyof typeof Ionicons.glyphMap}
                    size={13}
                    color={isActive ? C.textInverse : C.textSecondary}
                  />
                  <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{T(tab.labelKey)}</Text>
                  {count > 0 && (
                    <View style={[styles.tabBadge, isActive && { backgroundColor: "rgba(255,255,255,0.25)" }]}>
                      <Text style={[styles.tabBadgeText, isActive && { color: C.textInverse }]}>{count}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={{ flex: 1, flexDirection: isWide ? "row" : "column" }}>
        <View style={isWide
          ? { width: 420, borderRightWidth: 1, borderRightColor: C.border, overflow: "hidden" }
          : isTablet ? { flex: 1, alignSelf: "center", width: "100%", maxWidth: 720 } : { flex: 1 }
        }>
          {renderContent()}
        </View>
        {isWide && (
          <View style={{ flex: 1 }}>
            {selectedOrder
              ? <OrderDetailPanel id={selectedOrder.id} type={selectedOrder.type} orders={allOrders} rides={rides} pharmOrders={pharmOrders} parcels={parcels} onClose={() => setSelectedOrder(null)} />
              : <EmptyDetailPanel />}
          </View>
        )}
      </View>

      {reviewTarget && user && (
        <ReviewModal
          target={reviewTarget}
          userId={user.id}
          apiBase={API_BASE}
          token={token}
          language={language}
          onClose={() => setReviewTarget(null)}
          onDone={handleReviewDone}
        />
      )}

      {cancelTarget && (
        <CancelModal
          target={cancelTarget}
          cancellationFee={config.rides?.cancellationFee ?? 30}
          apiBase={API_BASE}
          token={token}
          onClose={() => setCancelTarget(null)}
          onDone={(result) => {
            if (cancelTarget.type === "ride") {
              const fee = result?.cancellationFee;
              const msg = fee > 0
                ? `Ride cancelled. Rs. ${fee} fee applied.`
                : "Ride cancelled successfully.";
              showToast(msg, "success");
              fetchRides();
            } else if (cancelTarget.type === "pharmacy") {
              showToast("Pharmacy order cancelled successfully.", "success");
              fetchPharmacy();
            } else {
              const refund = result?.refundAmount;
              const msg = refund > 0
                ? `Order cancelled. Rs. ${Math.round(refund)} will be refunded.`
                : "Order cancelled successfully.";
              showToast(msg, "success");
              refetchOrders();
            }
          }}
        />
      )}
    </View>
  );
}

export default withErrorBoundary(OrdersScreenInner);

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 12 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  headerTitle: { ...Typ.h2, fontSize: 22, color: C.textInverse, marginBottom: 2 },
  headerSub: { ...Typ.body, fontSize: 13, color: "rgba(255,255,255,0.7)" },
  headerActivePill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
  },
  headerActiveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#4ADE80" },
  headerActiveText: { ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.textInverse, fontSize: 12 },
  headerStats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  headerStat: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  headerStatText: { ...Typ.small, color: "rgba(255,255,255,0.9)", fontSize: 11 },

  tabsWrap: { backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border },
  tabs: { paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: C.background, borderWidth: 1.5, borderColor: C.border,
  },
  tabActive: { backgroundColor: C.primary, borderColor: C.primary },
  tabLabel: { ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.textSecondary, fontSize: 12 },
  tabLabelActive: { color: C.textInverse },
  tabBadge: {
    backgroundColor: C.border, borderRadius: 9,
    minWidth: 18, height: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 4,
  },
  tabBadgeText: { ...Typ.tiny, color: C.textMuted, fontSize: 10 },

  scroll: { paddingBottom: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  loadingText: { ...Typ.body, color: C.textMuted },

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingVertical: 32 },
  emptyIllustration: { position: "relative", marginBottom: 24 },
  emptyIllustrationBg: { width: 120, height: 120, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  emptyIllustrationInner: { width: 88, height: 88, borderRadius: 26, backgroundColor: "rgba(255,255,255,0.7)", alignItems: "center", justifyContent: "center" },
  emptyBadge: {
    position: "absolute", top: -6, right: -6,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: C.amberBg, borderWidth: 2, borderColor: C.surface,
    alignItems: "center", justifyContent: "center",
  },
  emptyHeading: { ...Typ.h2, fontSize: 22, color: C.text, textAlign: "center", marginBottom: 8 },
  emptySubtext: { ...Typ.body, fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22, marginBottom: 28 },
  emptyServicesLabel: { ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.textMuted, letterSpacing: 0.8, marginBottom: 14, textTransform: "uppercase", fontSize: 11 },
  emptyServicesGrid: { width: "100%", gap: 10 },
  emptyServiceCard: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 16, paddingVertical: 14, borderRadius: 16,
    borderWidth: 1,
  },
  emptyServiceIconWrap: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  emptyServiceLabel: { flex: 1, ...Typ.bodySemiBold, fontSize: 15 },

  emptyFilterWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 12 },
  emptyFilterIconBox: { width: 88, height: 88, borderRadius: 26, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  emptyFilterTitle: { ...Typ.h3, fontSize: 18, color: C.text, textAlign: "center" },
  emptyFilterSub: { ...Typ.body, fontSize: 13, color: C.textSecondary, textAlign: "center", lineHeight: 21 },
  emptyFilterBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 22, paddingVertical: 13, borderRadius: 16, marginTop: 8,
  },
  emptyFilterBtnText: { ...Typ.buttonSmall, color: C.textInverse, fontFamily: Font.semiBold },

  emptyIcon: { width: 96, height: 96, borderRadius: 28, backgroundColor: C.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  emptyFilterIcon: { width: 72, height: 72, borderRadius: 22, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  emptyTitle: { ...Typ.title, color: C.text, textAlign: "center" },
  emptyText: { ...Typ.body, fontSize: 13, color: C.textSecondary, textAlign: "center" },
  emptyBtns: { flexDirection: "row", gap: 10, marginTop: 8 },
  emptyBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.primary, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14 },
  emptyBtnText: { ...Typ.buttonSmall, color: C.textInverse },

  secRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 12 },
  activeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.emeraldDot },
  secTitle: { ...Typ.h3, fontSize: 16, color: C.text, flex: 1 },
  countBadge: { borderRadius: 10, minWidth: 24, height: 24, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  countText: { ...Typ.smallBold, color: C.textInverse },

  card: {
    backgroundColor: C.surface, borderRadius: 20,
    marginHorizontal: 16, marginBottom: 12, padding: 16,
    borderWidth: 1, borderColor: C.borderLight,
    shadowColor: C.text, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 3,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 22 },
  chipText: { ...Typ.captionMedium, fontFamily: Font.semiBold },
  cardId: { ...Typ.captionMedium, color: C.textMuted },

  cardItems: { marginBottom: 12, gap: 6 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  itemDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.border },
  itemText: { flex: 1, ...Typ.body, fontSize: 13, color: C.textSecondary },
  itemPrice: { ...Typ.buttonSmall, color: C.text },
  moreItems: { ...Typ.captionMedium, color: C.primary },
  expandRow: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 14, paddingVertical: 4 },

  noteRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginBottom: 12, padding: 10, backgroundColor: C.purpleBg, borderRadius: 12, borderWidth: 1, borderColor: C.purpleSoft },
  noteText: { flex: 1, ...Typ.caption, color: C.purpleDeep },

  rideRoute: { marginBottom: 12, gap: 4 },
  ridePoint: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeDot: { width: 10, height: 10, borderRadius: 5 },
  routeLine: { width: 2, height: 16, backgroundColor: C.border, marginLeft: 4 },
  rideAddr: { flex: 1, ...Typ.bodyMedium, fontSize: 13, color: C.text },

  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statusChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 22 },
  statusText: { ...Typ.captionMedium, fontFamily: Font.semiBold },
  totalWrap: { alignItems: "flex-end" },
  totalLabel: { ...Typ.small, color: C.textMuted },
  totalAmount: { ...Typ.h3, color: C.text },

  etaBar: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.borderLight },
  etaText: { flex: 1, ...Typ.caption, color: C.textMuted },
  payBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  payText: { ...Typ.small, color: C.textMuted },

  fareBreakdownBar: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.borderLight, gap: 6 },
  fareRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } as const,
  fareLabel: { ...Typ.caption, color: C.textMuted },
  fareValue: { ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.text },
  riderBar: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.borderLight },
  riderIconWrap: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.brandBlueSoft, alignItems: "center", justifyContent: "center" },
  riderName: { ...Typ.buttonSmall, color: C.text },
  riderPhone: { ...Typ.caption, color: C.textMuted, marginTop: 1 },
  callBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.brandBlue, alignItems: "center", justifyContent: "center" },

  cancelBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 12, paddingVertical: 10, borderRadius: 14, backgroundColor: C.redBg,
    borderWidth: 1.5, borderColor: C.redBorder,
  },
  cancelBtnText: { ...Typ.buttonSmall, color: C.red },
  rateBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 12, paddingVertical: 10, borderRadius: 14, backgroundColor: C.amberBg,
    borderWidth: 1.5, borderColor: C.amberBorder,
  },
  rateBtnText: { ...Typ.buttonSmall, color: C.amberBrown },
  reviewedBadge: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.borderLight,
  },
  reviewedText: { ...Typ.captionMedium, color: C.amberDark },
  refundBar: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: C.emeraldSoft, borderWidth: 1, borderColor: C.emeraldBorder,
  },
  refundText: { ...Typ.caption, color: C.emeraldDark },
  refundRequestBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 10, paddingVertical: 10, borderRadius: 14, backgroundColor: C.purpleBg,
    borderWidth: 1.5, borderColor: C.purpleBorder,
  },
  refundRequestBtnText: { ...Typ.buttonSmall, color: C.purple },
  reorderBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 10, paddingVertical: 10, borderRadius: 14, backgroundColor: C.blueSoft,
    borderWidth: 1.5, borderColor: C.blueBorder,
  },
  reorderBtnText: { ...Typ.buttonSmall, color: C.primary },
  cancelDisabledBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: C.surfaceSecondary, borderWidth: 1, borderColor: C.border,
  },
  cancelDisabledText: { ...Typ.small, color: C.textMuted, flex: 1 },
  bookAgainBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 10, paddingVertical: 10, borderRadius: 14, backgroundColor: C.blueSoft,
    borderWidth: 1.5, borderColor: C.blueBorder,
  },
  bookAgainBtnText: { ...Typ.buttonSmall, color: C.primary },

  tapHint: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.borderLight,
  },
  tapHintText: { ...Typ.small, color: C.textMuted },

  rideStepperWrap: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.borderLight },
  rideStepperRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center" },
  rideStepItem: { alignItems: "center", width: 56 },
  rideStepDot: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: C.slateBorder,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  rideStepLabel: { ...Typ.smallMedium, fontSize: 9, color: C.textMuted, textAlign: "center" },
  rideStepLine: { flex: 1, height: 2, backgroundColor: C.slateBorder, marginTop: 10 },

  sectionErrBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.redBg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: C.redBorder, marginBottom: 8,
  },
  sectionErrTxt: { flex: 1, ...Typ.bodyMedium, fontSize: 13, color: C.redDark },
  sectionErrRetry: { ...Typ.captionMedium, fontFamily: Font.semiBold, color: C.red },

  cardGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  cardGridItem: { flexBasis: "48%", flexGrow: 1, minWidth: 280 },
});

export const webPointer = Platform.select<object>({ web: { cursor: "pointer" } }) ?? {};

