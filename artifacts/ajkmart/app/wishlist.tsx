import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSmartBack } from "@/hooks/useSmartBack";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Image,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import Colors from "@/constants/colors";
import { Font } from "@/constants/typography";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { tDual, type TranslationKey } from "@workspace/i18n";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { getWishlist, removeFromWishlist, type WishlistItem } from "@workspace/api-client-react";

const C = Colors.light;
const { width } = Dimensions.get("window");
const CARD_W = (width - 16 * 2 - 12) / 2;
const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}/api`;

function WishlistCard({ item, onRemove }: { item: WishlistItem; onRemove: (productId: string) => void }) {
  const p = item.product;
  const origPrice = p.originalPrice || 0;
  const discount = origPrice > p.price ? Math.round(((origPrice - p.price) / origPrice) * 100) : 0;
  const removeScale = useRef(new Animated.Value(1)).current;

  const handleRemove = () => {
    Animated.timing(removeScale, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      onRemove(p.id);
    });
  };

  return (
    <Animated.View style={{ transform: [{ scale: removeScale }] }}>
      <TouchableOpacity activeOpacity={0.7}
        onPress={() => router.push({ pathname: "/product/[id]", params: { id: p.id } })}
        style={styles.card}
      >
        <View style={styles.cardImg}>
          {p.image ? (
            <Image source={{ uri: p.image }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <Ionicons name="basket-outline" size={28} color={C.textMuted} />
          )}
          {discount > 0 && (
            <View style={styles.discBadge}>
              <Text style={styles.discTxt}>{discount}% OFF</Text>
            </View>
          )}
          <TouchableOpacity activeOpacity={0.7}
            onPress={(e) => { e?.stopPropagation?.(); handleRemove(); }}
            style={styles.removeBtn}
          >
            <Ionicons name="heart" size={18} color={C.danger} />
          </TouchableOpacity>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardName} numberOfLines={2}>{p.name}</Text>
          {p.unit && <Text style={styles.cardUnit}>{p.unit}</Text>}
          <View style={styles.cardFooter}>
            <View>
              <Text style={styles.cardPrice}>Rs. {p.price.toLocaleString()}</Text>
              {origPrice > p.price && (
                <Text style={styles.cardOrigPrice}>Rs. {origPrice.toLocaleString()}</Text>
              )}
            </View>
            {p.rating != null && (
              <View style={styles.ratingBadge}>
                <Ionicons name="star" size={10} color={C.gold} />
                <Text style={styles.ratingTxt}>{p.rating.toFixed(1)}</Text>
              </View>
            )}
          </View>
          {!p.inStock && (
            <View style={styles.oosBadge}>
              <Text style={styles.oosTxt}>Out of Stock</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function WishlistScreen() {
  const { goBack } = useSmartBack();
  const { user, token, isCustomer, updateUser, isLoading: authLoading } = useAuth();
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  const isLoggedIn = !!user && !!token;
  const queryClient = useQueryClient();

  const [addingRole, setAddingRole] = useState(false);
  const [addRoleError, setAddRoleError] = useState<string | null>(null);

  const { data: items, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["wishlist"],
    queryFn: () => getWishlist(),
    enabled: isLoggedIn && isCustomer,
    staleTime: 60 * 1000,
    retry: (failureCount, err: unknown) => {
      const code = (err as any)?.code ?? (err as any)?.data?.code;
      if (code === "ROLE_DENIED") return false;
      return failureCount < 2;
    },
  });

  const isRoleDenied = (() => {
    if (!error) return false;
    const code = (error as any)?.code ?? (error as any)?.data?.code;
    return code === "ROLE_DENIED";
  })();

  const isError = !!error && !isRoleDenied;

  const handleAddCustomerRole = async () => {
    if (!token) return;
    setAddingRole(true);
    setAddRoleError(null);
    try {
      const res = await fetch(`${API_BASE}/users/add-role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: "customer" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddRoleError(data.error || "Failed to add customer access. Please try again.");
        return;
      }
      updateUser({ roles: data.data?.roles ?? data.roles ?? [] });
      queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    } catch {
      setAddRoleError("Network error. Please check your connection and try again.");
    } finally {
      setAddingRole(false);
    }
  };

  const handleRemove = useCallback(async (productId: string) => {
    try {
      await removeFromWishlist(productId);
      queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    } catch (err: unknown) {
      const code = (err as any)?.code ?? (err as any)?.data?.code;
      if (code !== "ROLE_DENIED") {
        Alert.alert("Wishlist Error", "Could not remove item from wishlist. Please try again.");
      }
    }
  }, [queryClient]);

  if (!isLoggedIn) {
    return (
      <ScreenContainer scroll={false}>
        <View style={styles.header}>
          <TouchableOpacity activeOpacity={0.7} onPress={goBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={C.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{T("myWishlist")}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.emptyCenter}>
          <View style={styles.emptyIcon}>
            <Ionicons name="heart-outline" size={48} color={C.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>{T("signInForWishlist")}</Text>
          <Text style={styles.emptySub}>{T("saveFavoritesLater")}</Text>
          <TouchableOpacity activeOpacity={0.7} onPress={() => router.push("/auth")} style={styles.signInBtn}>
            <Text style={styles.signInBtnTxt}>{T("signIn")}</Text>
          </TouchableOpacity>
        </View>
      </ScreenContainer>
    );
  }

  if (!authLoading && !isCustomer) {
    return (
      <ScreenContainer scroll={false}>
        <View style={styles.header}>
          <TouchableOpacity activeOpacity={0.7} onPress={goBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={C.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{T("myWishlist")}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.emptyCenter}>
          <View style={styles.emptyIcon}>
            <Ionicons name="lock-closed-outline" size={48} color={C.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>Customer Account Required</Text>
          <Text style={styles.emptySub}>
            This feature requires a customer account. Add customer access to your existing account to use the wishlist.
          </Text>
          {addRoleError ? (
            <Text style={styles.roleErrorTxt}>{addRoleError}</Text>
          ) : null}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={handleAddCustomerRole}
            style={styles.addRoleBtn}
            disabled={addingRole}
          >
            {addingRole ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="person-add-outline" size={16} color="#fff" />
                <Text style={styles.addRoleBtnTxt}>Add Customer Access</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={styles.addRoleHint}>
            This will add customer access to your existing account — you can still use the Rider/Vendor app.
          </Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scroll={false}>
      <View style={styles.header}>
        <TouchableOpacity activeOpacity={0.7} onPress={goBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{T("myWishlist")}</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countTxt}>{items?.length || 0}</Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={C.primary} />}
        contentContainerStyle={{ paddingBottom: 20 }}
      >
        {isLoading ? (
          <View style={styles.grid}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={{ width: CARD_W }}>
                <SkeletonBlock w="100%" h={120} r={16} />
                <View style={{ padding: 10, gap: 6 }}>
                  <SkeletonBlock w="70%" h={12} r={6} />
                  <SkeletonBlock w="50%" h={16} r={8} />
                </View>
              </View>
            ))}
          </View>
        ) : isRoleDenied ? (
          <View style={styles.emptyCenter}>
            <View style={styles.emptyIcon}>
              <Ionicons name="lock-closed-outline" size={48} color={C.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>Customer Account Required</Text>
            <Text style={styles.emptySub}>
              This feature requires a customer account. Add customer access to your existing account to use the wishlist.
            </Text>
            {addRoleError ? (
              <Text style={styles.roleErrorTxt}>{addRoleError}</Text>
            ) : null}
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleAddCustomerRole}
              style={styles.addRoleBtn}
              disabled={addingRole}
            >
              {addingRole ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="person-add-outline" size={16} color="#fff" />
                  <Text style={styles.addRoleBtnTxt}>Add Customer Access</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.addRoleHint}>
              This will add customer access to your existing account — you can still use the Rider/Vendor app.
            </Text>
          </View>
        ) : isError ? (
          <View style={styles.emptyCenter}>
            <View style={styles.emptyIcon}>
              <Ionicons name="cloud-offline-outline" size={48} color={C.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>{T("couldNotLoadWishlist")}</Text>
            <TouchableOpacity activeOpacity={0.7} onPress={() => refetch()} style={styles.retryBtn}>
              <Ionicons name="refresh-outline" size={16} color={C.textInverse} />
              <Text style={styles.retryBtnTxt}>{T("retry")}</Text>
            </TouchableOpacity>
          </View>
        ) : items && items.length === 0 ? (
          <View style={styles.emptyCenter}>
            <View style={styles.emptyIcon}>
              <Ionicons name="heart-outline" size={48} color={C.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>{T("wishlistEmpty")}</Text>
            <Text style={styles.emptySub}>{T("tapHeartToSave")}</Text>
            <TouchableOpacity activeOpacity={0.7} onPress={() => router.push("/(tabs)")} style={styles.browseBtn}>
              <Ionicons name="basket-outline" size={16} color={C.textInverse} />
              <Text style={styles.browseBtnTxt}>{T("browseProducts")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.grid}>
            {(items || []).map(item => (
              <WishlistCard key={item.id} item={item} onRemove={handleRemove} />
            ))}
          </View>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: Font.bold, fontSize: 18, color: C.text },
  countBadge: { minWidth: 28, height: 28, borderRadius: 14, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  countTxt: { fontFamily: Font.bold, fontSize: 12, color: C.textInverse },

  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  card: { width: CARD_W, backgroundColor: C.surface, borderRadius: 18, overflow: "hidden", shadowColor: C.text, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  cardImg: { height: 120, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  discBadge: { position: "absolute", top: 8, left: 8, backgroundColor: C.danger, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  discTxt: { fontFamily: Font.bold, fontSize: 9, color: C.textInverse },
  removeBtn: { position: "absolute", top: 8, right: 8, width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.9)", alignItems: "center", justifyContent: "center" },
  cardBody: { padding: 12 },
  cardName: { fontFamily: Font.semiBold, fontSize: 13, color: C.text, marginBottom: 3, minHeight: 34 },
  cardUnit: { fontFamily: Font.regular, fontSize: 11, color: C.textMuted, marginBottom: 6 },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  cardPrice: { fontFamily: Font.bold, fontSize: 16, color: C.text },
  cardOrigPrice: { fontFamily: Font.regular, fontSize: 11, color: C.textMuted, textDecorationLine: "line-through" },
  ratingBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: C.surfaceSecondary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
  ratingTxt: { fontFamily: Font.semiBold, fontSize: 10, color: C.text },
  oosBadge: { marginTop: 6, backgroundColor: C.dangerSoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, alignSelf: "flex-start" },
  oosTxt: { fontFamily: Font.semiBold, fontSize: 10, color: C.danger },

  emptyCenter: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 100, gap: 10 },
  emptyIcon: { width: 80, height: 80, borderRadius: 24, backgroundColor: C.surfaceSecondary, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  emptyTitle: { fontFamily: Font.bold, fontSize: 17, color: C.text },
  emptySub: { fontFamily: Font.regular, fontSize: 13, color: C.textMuted, textAlign: "center", paddingHorizontal: 40 },
  signInBtn: { marginTop: 12, backgroundColor: C.primary, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  signInBtnTxt: { fontFamily: Font.bold, fontSize: 14, color: C.textInverse },
  browseBtn: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 14 },
  browseBtnTxt: { fontFamily: Font.bold, fontSize: 14, color: C.textInverse },
  retryBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14 },
  retryBtnTxt: { fontFamily: Font.bold, fontSize: 14, color: C.textInverse },

  addRoleBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#16A34A", paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, minWidth: 200, justifyContent: "center" },
  addRoleBtnTxt: { fontFamily: Font.bold, fontSize: 14, color: "#fff" },
  addRoleHint: { fontFamily: Font.regular, fontSize: 12, color: C.textMuted, textAlign: "center", paddingHorizontal: 40, lineHeight: 18 },
  roleErrorTxt: { fontFamily: Font.regular, fontSize: 13, color: "#DC2626", textAlign: "center" },
});
