import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { logger as pinoLogger } from "../lib/logger.js";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  platformSettingsTable,
  authAuditLogTable,
  notificationsTable,
  userSessionsTable,
  userSettingsTable,
} from "@workspace/db";
import {
  t as i18nT,
  type Language,
  type TranslationKey as I18nKey,
  DEFAULT_LANGUAGE,
} from "@workspace/i18n";
import { verifyTotpToken as totpVerify, decryptTotpSecret } from "../services/totp.js";
import { verifyAccessToken } from "../utils/admin-jwt.js";

/* ══════════════════════════════════════════════════════════════
   admin-shared.ts — single source of cross-cutting helpers used
   by admin/auth/system routes. Real implementations only — no
   stubs. Each helper is defensive (try/catch + structured log) so
   one failure never cascades into a request crash.
══════════════════════════════════════════════════════════════ */

export interface AdminRequest extends Request {
  /** Convenience aliases populated by adminAuth */
  adminId?: string;
  adminRole?: string;
  adminName?: string;
  adminIp?: string;
  adminPermissions?: string[];
}

export interface DefaultPlatformSetting {
  key: string;
  value: string;
  label: string;
  category: string;
}
export const DEFAULT_PLATFORM_SETTINGS: DefaultPlatformSetting[] = [
  /* ── GENERAL ─────────────────────────────────────────────────────────── */
  { key: "app_name",         value: "AJKMart",                              label: "App Name",           category: "general" },
  { key: "app_tagline",      value: "Your super app for AJK",               label: "App Tagline",        category: "general" },
  { key: "app_version",      value: "1.0.0",                                label: "App Version",        category: "general" },
  { key: "app_status",       value: "active",                               label: "App Status",         category: "general" },
  { key: "support_phone",    value: "03001234567",                          label: "Support Phone",      category: "general" },
  { key: "support_email",    value: "support@ajkmart.pk",                   label: "Support Email",      category: "general" },
  { key: "support_hours",    value: "Mon–Sat, 8AM–10PM",                    label: "Support Hours",      category: "general" },
  { key: "business_address", value: "Muzaffarabad, Azad Kashmir, Pakistan", label: "Business Address",   category: "general" },
  { key: "social_facebook",  value: "",                                     label: "Facebook Page URL",  category: "general" },
  { key: "social_instagram", value: "",                                     label: "Instagram URL",      category: "general" },

  /* ── REGIONAL ────────────────────────────────────────────────────────── */
  { key: "regional_phone_format",    value: "+92XXXXXXXXXX",   label: "Phone Format",      category: "regional" },
  { key: "regional_phone_hint",      value: "03XX-XXXXXXX",    label: "Phone Hint",        category: "regional" },
  { key: "regional_timezone",        value: "Asia/Karachi",    label: "Timezone",          category: "regional" },
  { key: "regional_currency_symbol", value: "Rs.",             label: "Currency Symbol",   category: "regional" },
  { key: "regional_country_code",    value: "PK",              label: "Country Code",      category: "regional" },

  /* ── LOCALIZATION ────────────────────────────────────────────────────── */
  { key: "currency_code",   value: "PKR", label: "Currency Code",   category: "localization" },
  { key: "currency_symbol", value: "Rs.", label: "Currency Symbol", category: "localization" },

  /* ── BRANDING ────────────────────────────────────────────────────────── */
  { key: "brand_color_mart",       value: "#16a34a", label: "Mart Color",         category: "branding" },
  { key: "brand_color_food",       value: "#dc2626", label: "Food Color",         category: "branding" },
  { key: "brand_color_rides",      value: "#2563eb", label: "Rides Color",        category: "branding" },
  { key: "brand_color_pharmacy",   value: "#7c3aed", label: "Pharmacy Color",     category: "branding" },
  { key: "brand_color_parcel",     value: "#d97706", label: "Parcel Color",       category: "branding" },
  { key: "brand_color_van",        value: "#0891b2", label: "Van Color",          category: "branding" },
  { key: "brand_map_center_lat",   value: "34.3591", label: "Map Center Lat",     category: "branding" },
  { key: "brand_map_center_lng",   value: "73.4709", label: "Map Center Lng",     category: "branding" },
  { key: "brand_map_center_label", value: "Muzaffarabad", label: "Map Center Label", category: "branding" },

  /* ── FEATURES ────────────────────────────────────────────────────────── */
  { key: "feature_mart",          value: "on",  label: "Mart / Grocery",           category: "features" },
  { key: "feature_food",          value: "on",  label: "Food Delivery",            category: "features" },
  { key: "feature_rides",         value: "on",  label: "Taxi & Bike Rides",        category: "features" },
  { key: "feature_pharmacy",      value: "on",  label: "Pharmacy",                 category: "features" },
  { key: "feature_parcel",        value: "on",  label: "Parcel Delivery",          category: "features" },
  { key: "feature_wallet",        value: "on",  label: "Digital Wallet",           category: "features" },
  { key: "feature_referral",      value: "on",  label: "Referral Program",         category: "features" },
  { key: "feature_new_users",     value: "on",  label: "New User Registration",    category: "features" },
  { key: "user_require_approval", value: "off", label: "Require Account Approval", category: "features" },
  { key: "wallet_mpin_enabled",   value: "on",  label: "MPIN Enforcement",         category: "features" },
  { key: "feature_chat",          value: "on",  label: "In-App Chat / WhatsApp",   category: "features" },
  { key: "feature_live_tracking", value: "on",  label: "Live GPS Order Tracking",  category: "features" },
  { key: "feature_reviews",       value: "on",  label: "Reviews & Star Ratings",   category: "features" },
  { key: "feature_sos",           value: "on",  label: "SOS Emergency Alerts",     category: "features" },
  { key: "feature_weather",       value: "on",  label: "Weather Widget",           category: "features" },

  /* ── DISPATCH ────────────────────────────────────────────────────────── */
  { key: "dispatch_min_radius_km",       value: "1",    label: "Min Dispatch Radius (km)",  category: "dispatch" },
  { key: "dispatch_max_radius_km",       value: "10",   label: "Max Dispatch Radius (km)",  category: "dispatch" },
  { key: "dispatch_avg_speed_kmh",       value: "30",   label: "Avg Speed (km/h)",           category: "dispatch" },
  { key: "dispatch_broadcast_timeout_sec", value: "30", label: "Broadcast Timeout (sec)",   category: "dispatch" },

  /* ── ORDERS ──────────────────────────────────────────────────────────── */
  { key: "min_order_amount",           value: "100",  label: "Min Order Amount (Rs.)",     category: "orders" },
  { key: "order_max_cart_value",       value: "50000", label: "Max Cart Value (Rs.)",      category: "orders" },
  { key: "order_cancel_window_min",    value: "10",   label: "Cancel Window (min)",        category: "orders" },
  { key: "order_auto_cancel_min",      value: "15",   label: "Auto Cancel (min)",          category: "orders" },
  { key: "order_refund_days",          value: "3",    label: "Refund Window (days)",       category: "orders" },
  { key: "order_preptime_min",         value: "20",   label: "Prep Time (min)",            category: "orders" },
  { key: "order_rating_window_hours",  value: "48",   label: "Rating Window (hrs)",        category: "orders" },
  { key: "order_max_item_quantity",    value: "20",   label: "Max Item Quantity",          category: "orders" },
  { key: "order_gps_capture_enabled",  value: "on",   label: "GPS Capture on Order",      category: "orders" },
  { key: "order_schedule_enabled",     value: "on",   label: "Schedule Future Orders",    category: "orders" },

  /* ── DELIVERY ────────────────────────────────────────────────────────── */
  { key: "delivery_free_enabled", value: "on",   label: "Free Delivery Toggle",         category: "delivery" },
  { key: "delivery_free_above",   value: "1000", label: "Free Delivery Above (Rs.)",    category: "delivery" },
  { key: "delivery_fee_mart",     value: "50",   label: "Mart Delivery Fee (Rs.)",      category: "delivery" },
  { key: "delivery_fee_food",     value: "60",   label: "Food Delivery Fee (Rs.)",      category: "delivery" },
  { key: "delivery_fee_pharmacy", value: "40",   label: "Pharmacy Delivery Fee (Rs.)",  category: "delivery" },
  { key: "delivery_base_km",      value: "2",    label: "Base Distance (km)",           category: "delivery" },
  { key: "delivery_per_km",       value: "15",   label: "Per Extra km (Rs.)",           category: "delivery" },
  { key: "parcel_base_fee",       value: "80",   label: "Parcel Base Fee (Rs.)",        category: "delivery" },
  { key: "parcel_per_kg",         value: "30",   label: "Parcel Per kg (Rs.)",          category: "delivery" },

  /* ── RIDES ───────────────────────────────────────────────────────────── */
  { key: "ride_bike_base_fare",         value: "15",  label: "Bike Base Fare (Rs.)",          category: "rides" },
  { key: "ride_bike_per_km",            value: "8",   label: "Bike Per km (Rs.)",             category: "rides" },
  { key: "ride_bike_min_fare",          value: "50",  label: "Bike Min Fare (Rs.)",           category: "rides" },
  { key: "ride_car_base_fare",          value: "25",  label: "Car Base Fare (Rs.)",           category: "rides" },
  { key: "ride_car_per_km",             value: "12",  label: "Car Per km (Rs.)",              category: "rides" },
  { key: "ride_car_min_fare",           value: "80",  label: "Car Min Fare (Rs.)",            category: "rides" },
  { key: "ride_rickshaw_base_fare",     value: "20",  label: "Rickshaw Base Fare (Rs.)",      category: "rides" },
  { key: "ride_rickshaw_per_km",        value: "10",  label: "Rickshaw Per km (Rs.)",         category: "rides" },
  { key: "ride_rickshaw_min_fare",      value: "60",  label: "Rickshaw Min Fare (Rs.)",       category: "rides" },
  { key: "ride_daba_base_fare",         value: "30",  label: "Daba Base Fare (Rs.)",          category: "rides" },
  { key: "ride_daba_per_km",            value: "14",  label: "Daba Per km (Rs.)",             category: "rides" },
  { key: "ride_daba_min_fare",          value: "100", label: "Daba Min Fare (Rs.)",           category: "rides" },
  { key: "ride_surge_enabled",          value: "off", label: "Surge Pricing",                 category: "rides" },
  { key: "ride_surge_multiplier",       value: "1.5", label: "Surge Multiplier",              category: "rides" },
  { key: "ride_cancellation_fee",       value: "50",  label: "Cancellation Fee (Rs.)",        category: "rides" },
  { key: "ride_cancel_grace_sec",       value: "60",  label: "Cancel Grace Period (sec)",     category: "rides" },
  { key: "ride_bargaining_enabled",     value: "on",  label: "Price Bargaining (Mol-Tol)",    category: "rides" },
  { key: "ride_bargaining_min_pct",     value: "70",  label: "Min Bargain Offer (%)",         category: "rides" },
  { key: "ride_bargaining_max_rounds",  value: "3",   label: "Max Bargain Rounds",            category: "rides" },
  { key: "ride_max_fare",               value: "5000", label: "Max Allowed Fare (Rs.)",       category: "rides" },
  { key: "ride_counter_offer_max_multiplier", value: "2", label: "Counter Offer Max (×)",    category: "rides" },
  { key: "ride_payment_cash",           value: "on",  label: "Cash Payment for Rides",        category: "rides" },
  { key: "ride_payment_wallet",         value: "on",  label: "Wallet Payment for Rides",      category: "rides" },
  { key: "ride_payment_jazzcash",       value: "on",  label: "JazzCash Payment for Rides",    category: "rides" },
  { key: "ride_payment_easypaisa",      value: "on",  label: "EasyPaisa Payment for Rides",   category: "rides" },
  { key: "rider_ignore_restrict_enabled", value: "off", label: "Ignore Rider Restrictions",  category: "rides" },

  /* ── VAN ─────────────────────────────────────────────────────────────── */
  { key: "van_auto_notify_cancel",      value: "on",    label: "Auto-Notify on Cancel",        category: "van" },
  { key: "van_require_start_trip",      value: "on",    label: "Require Start Trip",           category: "van" },
  { key: "van_min_advance_hours",       value: "2",     label: "Min Advance Booking (hrs)",    category: "van" },
  { key: "van_max_seats_per_booking",   value: "4",     label: "Max Seats Per Booking",        category: "van" },
  { key: "van_cancellation_window_hours", value: "4",   label: "Cancellation Window (hrs)",   category: "van" },
  { key: "van_refund_type",             value: "full",  label: "Refund Type",                  category: "van" },
  { key: "van_refund_partial_pct",      value: "50",    label: "Partial Refund (%)",           category: "van" },
  { key: "van_seat_hold_minutes",       value: "15",    label: "Seat Hold Duration (min)",     category: "van" },
  { key: "van_min_passengers",          value: "1",     label: "Min Passengers to Depart",     category: "van" },
  { key: "van_min_check_hours_before",  value: "1",     label: "Passenger Check Before (hrs)", category: "van" },
  { key: "van_max_driver_trips_day",    value: "4",     label: "Max Driver Trips/Day",         category: "van" },
  { key: "van_driver_rest_hours",       value: "2",     label: "Driver Rest Between Trips (hrs)", category: "van" },
  { key: "van_peak_surcharge_pct",      value: "10",    label: "Peak Hours Surcharge (%)",     category: "van" },
  { key: "van_peak_hours",              value: "7,8,9,17,18", label: "Peak Hours",             category: "van" },
  { key: "van_weekend_surcharge_pct",   value: "5",     label: "Weekend Surcharge (%)",        category: "van" },
  { key: "van_holiday_surcharge_pct",   value: "15",    label: "Holiday Surcharge (%)",        category: "van" },
  { key: "van_holiday_dates",           value: "",      label: "Holiday Dates (YYYY-MM-DD)",   category: "van" },

  /* ── ONBOARDING ──────────────────────────────────────────────────────── */
  { key: "vendor_auto_schedule_enabled", value: "off", label: "Vendor Auto-Schedule",       category: "onboarding" },
  { key: "vendor_auto_schedule_hours",   value: '{"mon":"09:00-21:00","tue":"09:00-21:00","wed":"09:00-21:00","thu":"09:00-21:00","fri":"09:00-21:00","sat":"10:00-20:00","sun":"closed"}', label: "Vendor Auto-Schedule Hours", category: "onboarding" },
  { key: "onboarding_slides",            value: "[]",  label: "Onboarding Slides JSON",     category: "onboarding" },

  /* ── CUSTOMER ────────────────────────────────────────────────────────── */
  { key: "customer_referral_enabled",   value: "on",   label: "Referral Program",             category: "customer" },
  { key: "customer_referral_bonus",     value: "50",   label: "Referral Bonus (Rs.)",         category: "customer" },
  { key: "customer_loyalty_enabled",    value: "on",   label: "Loyalty Program",              category: "customer" },
  { key: "customer_signup_bonus",       value: "0",    label: "Signup Bonus (Rs.)",           category: "customer" },
  { key: "customer_max_orders_day",     value: "10",   label: "Max Orders Per Day",           category: "customer" },
  { key: "profile_show_saved_addresses", value: "on",  label: "Show Saved Addresses",         category: "customer" },
  { key: "wallet_min_topup",            value: "100",  label: "Min Wallet Top-Up (Rs.)",      category: "customer" },
  { key: "wallet_max_balance",          value: "50000", label: "Max Wallet Balance (Rs.)",    category: "customer" },
  { key: "wallet_min_withdrawal",       value: "200",  label: "Min Wallet Transfer (Rs.)",    category: "customer" },
  { key: "wallet_p2p_enabled",          value: "on",   label: "P2P Money Transfer",           category: "customer" },
  { key: "wallet_kyc_required",         value: "off",  label: "KYC Required for Wallet",      category: "customer" },
  { key: "wallet_cashback_on_orders",   value: "on",   label: "Cashback on Mart/Food",        category: "customer" },
  { key: "wallet_cashback_on_rides",    value: "on",   label: "Cashback on Rides",            category: "customer" },
  { key: "wallet_cashback_on_pharmacy", value: "on",   label: "Cashback on Pharmacy",         category: "customer" },
  { key: "wallet_cashback_pct",         value: "2",    label: "Cashback Percentage (%)",      category: "customer" },

  /* ── RIDER ───────────────────────────────────────────────────────────── */
  { key: "rider_auto_approve",           value: "off", label: "Auto-Approve Riders",            category: "rider" },
  { key: "rider_cash_allowed",           value: "on",  label: "Allow Cash Orders",              category: "rider" },
  { key: "rider_withdrawal_enabled",     value: "on",  label: "Rider Withdrawals Enabled",      category: "rider" },
  { key: "rider_deposit_enabled",        value: "on",  label: "Rider Deposits Enabled",         category: "rider" },
  { key: "rider_keep_pct",               value: "80",  label: "Rider Earnings % (of fare)",     category: "rider" },
  { key: "rider_bonus_per_trip",         value: "0",   label: "Bonus Per Trip (Rs.)",           category: "rider" },
  { key: "rider_min_payout",             value: "500", label: "Min Payout Request (Rs.)",       category: "rider" },
  { key: "rider_max_payout",             value: "50000", label: "Max Single Payout (Rs.)",      category: "rider" },
  { key: "rider_max_deliveries",         value: "3",   label: "Max Active Deliveries",          category: "rider" },
  { key: "rider_acceptance_km",          value: "5",   label: "Acceptance Radius (km)",         category: "rider" },
  { key: "rider_module_wallet",          value: "on",  label: "Rider Module: Wallet",           category: "rider" },
  { key: "rider_module_earnings",        value: "on",  label: "Rider Module: Earnings",         category: "rider" },
  { key: "rider_module_history",         value: "on",  label: "Rider Module: History",          category: "rider" },
  { key: "rider_module_2fa_required",    value: "off", label: "Rider Module: Require 2FA",      category: "rider" },
  { key: "rider_module_gps_tracking",    value: "on",  label: "Rider Module: GPS Tracking",     category: "rider" },
  { key: "rider_module_profile_edit",    value: "on",  label: "Rider Module: Profile Edit",     category: "rider" },
  { key: "rider_module_support_chat",    value: "on",  label: "Rider Module: Support Chat",     category: "rider" },
  { key: "rider_gps_queue_max",          value: "100", label: "GPS Queue Max",                  category: "rider" },
  { key: "rider_dismissed_request_ttl_sec", value: "300", label: "Dismissed Request TTL (sec)", category: "rider" },

  /* ── VENDOR ──────────────────────────────────────────────────────────── */
  { key: "vendor_auto_approve",      value: "off",  label: "Auto-Approve Vendors",          category: "vendor" },
  { key: "vendor_promo_enabled",     value: "on",   label: "Vendor Promo Codes",            category: "vendor" },
  { key: "vendor_withdrawal_enabled", value: "on",  label: "Vendor Withdrawals Enabled",    category: "vendor" },
  { key: "vendor_commission_pct",    value: "15",   label: "Vendor Commission (%)",         category: "vendor" },
  { key: "vendor_settlement_days",   value: "7",    label: "Settlement Cycle (days)",       category: "vendor" },
  { key: "vendor_min_payout",        value: "500",  label: "Vendor Min Payout (Rs.)",       category: "vendor" },
  { key: "vendor_max_payout",        value: "100000", label: "Vendor Max Payout (Rs.)",     category: "vendor" },
  { key: "vendor_min_order",         value: "100",  label: "Default Min Order (Rs.)",       category: "vendor" },
  { key: "vendor_max_items",         value: "500",  label: "Max Menu Items Per Vendor",     category: "vendor" },
  { key: "low_stock_threshold",      value: "10",   label: "Low Stock Alert Threshold",     category: "vendor" },

  /* ── FINANCE ─────────────────────────────────────────────────────────── */
  { key: "platform_commission_pct",  value: "10",   label: "Platform Commission (%)",       category: "finance" },
  { key: "finance_gst_enabled",      value: "off",  label: "GST / Sales Tax",               category: "finance" },
  { key: "finance_gst_pct",          value: "17",   label: "GST Rate (%)",                  category: "finance" },
  { key: "finance_cashback_enabled", value: "on",   label: "Cashback Rewards",              category: "finance" },
  { key: "finance_cashback_pct",     value: "2",    label: "Cashback Percentage (%)",       category: "finance" },
  { key: "finance_cashback_max_rs",  value: "200",  label: "Max Cashback Per Order (Rs.)",  category: "finance" },
  { key: "finance_invoice_enabled",  value: "off",  label: "Auto-Generate Invoices",        category: "finance" },
  { key: "alert_high_value_threshold", value: "5000", label: "High Value Alert Threshold (Rs.)", category: "finance" },

  /* ── NOTIFICATIONS ───────────────────────────────────────────────────── */
  { key: "notif_new_order",    value: "on", label: "New Order Notification",      category: "notifications" },
  { key: "notif_order_ready",  value: "on", label: "Order Ready Notification",    category: "notifications" },
  { key: "notif_ride_request", value: "on", label: "Ride Request Notification",   category: "notifications" },
  { key: "notif_promo",        value: "on", label: "Promo Notification",          category: "notifications" },
  { key: "notif_text_ride_request", value: "New ride request near you!", label: "Ride Request Text",  category: "notifications" },
  { key: "notif_text_order_update", value: "Your order status has been updated.", label: "Order Update Text", category: "notifications" },
  { key: "email_template_verify_html", value: "<p>Hi {userName}, please verify your email: <a href='{link}'>Verify</a></p>", label: "Verification Email HTML", category: "notifications" },
  { key: "email_template_reset_html",  value: "<p>Hi {userName}, your OTP is: <strong>{otp}</strong></p>", label: "Password Reset Email HTML", category: "notifications" },
  { key: "email_template_magic_html",  value: "<p>Hi {userName}, click to login: <a href='{link}'>Login</a></p>", label: "Magic Link Email HTML", category: "notifications" },
  { key: "fraud_same_address_limit",      value: "5",    label: "Same Address Limit",            category: "notifications" },
  { key: "fraud_gps_mismatch_threshold_m", value: "500", label: "GPS Mismatch Threshold (m)",    category: "notifications" },
  { key: "fraud_new_account_order_limit", value: "3",    label: "New Account Order Limit",       category: "notifications" },
  { key: "fraud_daily_order_limit",       value: "20",   label: "Daily Order Limit",             category: "notifications" },

  /* ── CONTENT ─────────────────────────────────────────────────────────── */
  { key: "content_banner",                  value: "",     label: "Promo Banner Text",             category: "content" },
  { key: "content_announcement",            value: "",     label: "App Announcement",              category: "content" },
  { key: "content_maintenance_msg",         value: "We are performing maintenance. Please check back shortly.", label: "Maintenance Message", category: "content" },
  { key: "content_support_msg",             value: "Need help? We're here for you.", label: "Support Message",  category: "content" },
  { key: "content_vendor_notice",           value: "",     label: "Vendor Dashboard Notice",       category: "content" },
  { key: "content_rider_notice",            value: "",     label: "Rider Home Notice",             category: "content" },
  { key: "content_tnc_url",                 value: "",     label: "Terms & Conditions URL",        category: "content" },
  { key: "content_privacy_url",             value: "",     label: "Privacy Policy URL",            category: "content" },
  { key: "content_refund_policy_url",       value: "",     label: "Refund Policy URL",             category: "content" },
  { key: "content_faq_url",                 value: "",     label: "FAQ URL",                       category: "content" },
  { key: "content_about_url",               value: "",     label: "About Us URL",                  category: "content" },
  { key: "content_tracker_banner_enabled",  value: "on",   label: "Active Tracker Banner",         category: "content" },
  { key: "content_show_banner",             value: "on",   label: "Show Promotional Banner",       category: "content" },
  { key: "content_tracker_banner_position", value: "top",  label: "Tracker Banner Position",       category: "content" },

  /* ── SECURITY ────────────────────────────────────────────────────────── */
  { key: "security_phone_verify",       value: "on",  label: "Phone Verification Required",  category: "security" },
  { key: "security_otp_bypass",         value: "off", label: "OTP Bypass Mode",              category: "security" },
  { key: "security_mfa_required",       value: "off", label: "MFA Required",                 category: "security" },
  { key: "security_multi_device",       value: "on",  label: "Multi-Device Login",           category: "security" },
  { key: "security_gps_tracking",       value: "on",  label: "GPS Tracking",                 category: "security" },
  { key: "security_geo_fence",          value: "off", label: "Geo-Fencing",                  category: "security" },
  { key: "security_spoof_detection",    value: "on",  label: "GPS Spoof Detection",          category: "security" },
  { key: "security_block_tor",          value: "off", label: "Block TOR Exits",              category: "security" },
  { key: "security_block_vpn",          value: "off", label: "Block VPNs",                   category: "security" },
  { key: "security_pwd_strong",         value: "on",  label: "Strong Password Required",     category: "security" },
  { key: "security_allow_uploads",      value: "on",  label: "Allow File Uploads",           category: "security" },
  { key: "security_compress_images",    value: "on",  label: "Compress Images on Upload",    category: "security" },
  { key: "security_scan_uploads",       value: "on",  label: "Scan Uploads for Malware",     category: "security" },
  { key: "security_fake_order_detect",  value: "on",  label: "Fake Order Detection",         category: "security" },
  { key: "security_auto_block_ip",      value: "on",  label: "Auto-Block Suspicious IPs",    category: "security" },
  { key: "security_single_phone",       value: "off", label: "One Account Per Phone",        category: "security" },
  { key: "security_audit_log",          value: "on",  label: "Security Audit Log",           category: "security" },
  { key: "security_session_days",       value: "30",  label: "Session Duration (days)",      category: "security" },
  { key: "security_admin_token_hrs",    value: "24",  label: "Admin Token TTL (hrs)",        category: "security" },
  { key: "security_rider_token_days",   value: "30",  label: "Rider Token TTL (days)",       category: "security" },
  { key: "security_login_max_attempts", value: "5",   label: "Max Login Attempts",           category: "security" },
  { key: "security_lockout_minutes",    value: "15",  label: "Lockout Duration (min)",       category: "security" },
  { key: "security_otp_max_per_phone",  value: "5",   label: "Max OTP Per Phone",            category: "security" },
  { key: "security_otp_max_per_ip",     value: "10",  label: "Max OTP Per IP",               category: "security" },
  { key: "security_otp_window_min",     value: "10",  label: "OTP Window (min)",             category: "security" },
  { key: "security_rate_limit",                   value: "100", label: "Global Rate Limit (req/min)",          category: "security" },
  { key: "security_rate_admin",                   value: "60",  label: "Admin Rate Limit (req/min)",           category: "security" },
  { key: "security_rate_rider",                   value: "120", label: "Rider Rate Limit (req/min)",          category: "security" },
  { key: "security_rate_vendor",                  value: "80",  label: "Vendor Rate Limit (req/min)",         category: "security" },
  { key: "security_suspicious_pattern_threshold", value: "60",  label: "Suspicious Pattern Threshold (req/min)", category: "security" },
  { key: "security_rate_burst",         value: "20",  label: "Burst Allowance (req)",        category: "security" },
  { key: "security_gps_accuracy",       value: "50",  label: "GPS Accuracy Threshold (m)",   category: "security" },
  { key: "security_gps_interval",       value: "10",  label: "GPS Update Interval (sec)",    category: "security" },
  { key: "security_max_speed_kmh",      value: "120", label: "Max Speed Threshold (km/h)",   category: "security" },
  { key: "security_pwd_min_length",     value: "8",   label: "Min Password Length",          category: "security" },
  { key: "security_pwd_expiry_days",    value: "0",   label: "Password Expiry (days, 0=off)", category: "security" },
  { key: "security_jwt_rotation_days",  value: "7",   label: "JWT Rotation (days)",          category: "security" },
  { key: "security_max_file_mb",        value: "10",  label: "Max Upload File Size (MB)",    category: "security" },
  { key: "security_allowed_types",      value: "jpg,jpeg,png,webp,pdf", label: "Allowed Upload Types", category: "security" },
  { key: "security_img_quality",        value: "80",  label: "Image Compression Quality",    category: "security" },
  { key: "security_max_daily_orders",   value: "20",  label: "Max Daily Orders (per user)",  category: "security" },
  { key: "security_new_acct_limit",     value: "3",   label: "New Account Order Limit",      category: "security" },
  { key: "security_same_addr_limit",    value: "5",   label: "Same Address Order Limit",     category: "security" },
  { key: "gps_mismatch_threshold_m",    value: "500", label: "GPS Mismatch Threshold (m)",   category: "security" },
  { key: "security_admin_ip_whitelist", value: "",    label: "Admin IP Whitelist",           category: "security" },
  { key: "security_maintenance_key",    value: "",    label: "Maintenance Bypass Key",       category: "security" },
  { key: "auth_trusted_device_days",    value: "30",  label: "Trusted Device Duration (days)", category: "security" },
  /* Auth method toggles */
  { key: "auth_phone_otp_enabled",         value: "on",  label: "Phone OTP Login",             category: "security" },
  { key: "auth_email_otp_enabled",         value: "on",  label: "Email OTP Login",             category: "security" },
  { key: "auth_username_password_enabled", value: "on",  label: "Username/Password Login",     category: "security" },
  { key: "auth_email_register_enabled",    value: "on",  label: "Email Registration",          category: "security" },
  { key: "auth_magic_link_enabled",        value: "off", label: "Magic Link Login",            category: "security" },
  { key: "auth_2fa_enabled",               value: "off", label: "2FA (TOTP) Enabled",          category: "security" },
  { key: "auth_biometric_enabled",         value: "on",  label: "Biometric Login",             category: "security" },
  { key: "auth_captcha_enabled",           value: "off", label: "reCAPTCHA Enabled",           category: "security" },

  /* ── JWT ─────────────────────────────────────────────────────────────── */
  { key: "jwt_access_ttl_sec",       value: "900",   label: "Access Token TTL (sec)",         category: "jwt" },
  { key: "jwt_refresh_ttl_days",     value: "7",     label: "Refresh Token TTL (days)",       category: "jwt" },
  { key: "jwt_2fa_challenge_sec",    value: "300",   label: "2FA Challenge TTL (sec)",        category: "jwt" },

  /* ── MODERATION ──────────────────────────────────────────────────────── */
  { key: "comm_hide_phone",          value: "on",              label: "Mask Phone Numbers",     category: "moderation" },
  { key: "comm_hide_email",          value: "on",              label: "Mask Email Addresses",   category: "moderation" },
  { key: "comm_hide_cnic",           value: "on",              label: "Mask CNIC Numbers",      category: "moderation" },
  { key: "comm_hide_bank",           value: "on",              label: "Mask Bank Accounts",     category: "moderation" },
  { key: "comm_hide_address",        value: "off",             label: "Mask Addresses",         category: "moderation" },
  { key: "comm_flag_keywords",       value: "",                label: "Flagged Keywords",       category: "moderation" },
  { key: "comm_mask_format_phone",   value: "03XX-XXXXXXX",    label: "Phone Mask Format",      category: "moderation" },
  { key: "comm_mask_format_email",   value: "u***@***.com",    label: "Email Mask Format",      category: "moderation" },
  { key: "comm_mask_format_cnic",    value: "XXXXX-XXXXXXX-X", label: "CNIC Mask Format",      category: "moderation" },
  { key: "moderation_custom_patterns", value: "",              label: "Custom Regex Patterns",  category: "moderation" },

  /* ── RATE LIMITS ─────────────────────────────────────────────────────── */
  { key: "rate_bargain_per_min",  value: "10", label: "Bargaining Rate Limit (req/min)",   category: "ratelimit" },
  { key: "rate_booking_per_min",  value: "15", label: "Booking Rate Limit (req/min)",      category: "ratelimit" },
  { key: "rate_cancel_per_min",   value: "5",  label: "Cancellation Rate Limit (req/min)", category: "ratelimit" },
  { key: "rate_estimate_per_min", value: "30", label: "Estimate Rate Limit (req/min)",     category: "ratelimit" },

  /* ── SYSTEM LIMITS ───────────────────────────────────────────────────── */
  { key: "system_log_retention_days", value: "30",     label: "Log Retention (days)",       category: "system_limits" },
  { key: "system_cache_ttl_sec",      value: "30",     label: "Settings Cache TTL (sec)",   category: "system_limits" },
  { key: "system_json_body_limit",    value: "10mb",   label: "JSON Body Size Limit",       category: "system_limits" },
  { key: "system_upload_size_limit",  value: "10mb",   label: "Upload Size Limit",          category: "system_limits" },

  /* ── PERFORMANCE ALERT THRESHOLDS ────────────────────────────────────── */
  { key: "perf_alert_p95_ms",      value: "500",  label: "API p95 Alert Threshold (ms)",      category: "health_monitor" },
  { key: "perf_alert_db_query_ms", value: "1000", label: "DB Query Latency Alert (ms)",        category: "health_monitor" },
  { key: "perf_alert_memory_pct",  value: "80",   label: "Memory Usage Alert Threshold (%)",   category: "health_monitor" },
  { key: "perf_alert_disk_pct",    value: "80",   label: "Disk Usage Alert Threshold (%)",     category: "health_monitor" },

  /* ── CACHE TTLS ──────────────────────────────────────────────────────── */
  { key: "cache_settings_ttl_sec", value: "30",  label: "Settings Cache TTL (sec)",   category: "cache" },
  { key: "cache_vpn_ttl_min",      value: "60",  label: "VPN Detection Cache (min)",  category: "cache" },
  { key: "cache_tor_ttl_min",      value: "60",  label: "TOR Node Cache (min)",       category: "cache" },
  { key: "cache_zone_ttl_min",     value: "30",  label: "Zone Cache TTL (min)",       category: "cache" },

  /* ── NETWORK & RETRY ─────────────────────────────────────────────────── */
  { key: "api_timeout_ms",           value: "10000", label: "API Timeout (ms)",              category: "network" },
  { key: "max_retry_attempts",       value: "3",     label: "Max Retry Attempts",            category: "network" },
  { key: "retry_backoff_base_ms",    value: "500",   label: "Retry Backoff Base (ms)",       category: "network" },

  /* ── GEO & ZONES ─────────────────────────────────────────────────────── */
  { key: "geo_default_zone_radius_km", value: "15",  label: "Default Zone Radius (km)",      category: "geo" },
  { key: "geo_open_world_fallback",    value: "on",  label: "Open-World Fallback",           category: "geo" },

  /* ── UPLOADS ─────────────────────────────────────────────────────────── */
  { key: "upload_max_image_mb",            value: "5",             label: "Max Image Size (MB)",          category: "uploads" },
  { key: "upload_max_video_mb",            value: "50",            label: "Max Video Size (MB)",          category: "uploads" },
  { key: "upload_max_video_duration_sec",  value: "60",            label: "Max Video Duration (sec)",     category: "uploads" },
  { key: "upload_allowed_image_formats",   value: "jpg,jpeg,png,webp", label: "Allowed Image Formats",   category: "uploads" },
  { key: "upload_allowed_video_formats",   value: "mp4,mov",       label: "Allowed Video Formats",       category: "uploads" },
  { key: "upload_payment_proof",           value: "on",            label: "Payment Proof Upload",        category: "uploads" },
  { key: "upload_kyc_docs",               value: "on",             label: "KYC Document Upload",         category: "uploads" },
  { key: "upload_rider_docs",              value: "on",            label: "Rider Document Upload",       category: "uploads" },
  { key: "upload_vendor_docs",             value: "on",            label: "Vendor Document Upload",      category: "uploads" },
  { key: "upload_product_imgs",            value: "on",            label: "Product Image Upload",        category: "uploads" },
  { key: "upload_cod_proof",               value: "on",            label: "COD Proof Upload",            category: "uploads" },

  /* ── PAGINATION ──────────────────────────────────────────────────────── */
  { key: "pagination_products_default", value: "20",  label: "Products Per Page (Default)",  category: "pagination" },
  { key: "pagination_products_max",     value: "100", label: "Products Per Page (Max)",      category: "pagination" },
  { key: "pagination_trending_limit",   value: "10",  label: "Trending Searches Shown",      category: "pagination" },
  { key: "pagination_flash_deals",      value: "8",   label: "Flash Deals Per Page",         category: "pagination" },

  /* ── HEALTH MONITOR ──────────────────────────────────────────────────── */
  { key: "health_monitor_enabled",       value: "off", label: "Enable Health Alert Monitor",   category: "health_monitor" },
  { key: "health_monitor_interval_min",  value: "5",   label: "Check Interval (min)",          category: "health_monitor" },
  { key: "health_monitor_snooze_min",    value: "60",  label: "Re-alert Snooze (min)",         category: "health_monitor" },
  { key: "health_alert_slack_webhook",   value: "",    label: "Slack Webhook URL",             category: "health_monitor" },
  { key: "email_alert_health_critical",  value: "on",  label: "Email: Critical Health Alerts", category: "health_monitor" },
  { key: "smtp_admin_alert_email",       value: "",    label: "Admin Alert Email Recipient",   category: "health_monitor" },

  /* ── SUPER-ADMIN SECURITY ──────────────────────────────────────────────── */
  { key: "security_super_admin_mfa_required", value: "off", label: "Require 2FA for Super Admin Login", category: "security" },
  { key: "admin_master_totp_secret",          value: "",    label: "Super Admin TOTP Secret (base32)",  category: "security" },
];
export const ADMIN_TOKEN_TTL_HRS = 24;
export const ADMIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOCKOUT_TIME = 15 * 60 * 1000;
export const adminLoginAttempts = new Map<string, { count: number; lastAttempt: number }>();

export interface NotifKey { titleKey: string; bodyKey: string; icon: string }
export const ORDER_NOTIF_KEYS: Record<string, NotifKey> = {
  CREATED: { titleKey: "notifOrderCreated", bodyKey: "notifOrderCreatedBody", icon: "cart-outline" },
  UPDATED: { titleKey: "notifOrderUpdated", bodyKey: "notifOrderUpdatedBody", icon: "cart-outline" },
};
export const RIDE_NOTIF_KEYS: Record<string, NotifKey> = {
  REQUESTED:  { titleKey: "notifRideRequested",  bodyKey: "notifRideRequestedBody",  icon: "car-outline" },
  accepted:   { titleKey: "notifRideAccepted",   bodyKey: "notifRideAcceptedBody",   icon: "car-outline" },
  arrived:    { titleKey: "notifRideArrived",    bodyKey: "notifRideArrivedBody",    icon: "car-outline" },
  in_transit: { titleKey: "notifRideInTransit",  bodyKey: "notifRideInTransitBody",  icon: "car-outline" },
  completed:  { titleKey: "notifRideCompleted",  bodyKey: "notifRideCompletedBody",  icon: "checkmark-circle-outline" },
  cancelled:  { titleKey: "notifRideCancelled",  bodyKey: "notifRideCancelledBody",  icon: "close-circle-outline" },
};
export const PHARMACY_NOTIF_KEYS: Record<string, NotifKey> = {
  NEW: { titleKey: "notifPharmacyNew", bodyKey: "notifPharmacyNewBody", icon: "medkit-outline" },
};
export const PARCEL_NOTIF_KEYS: Record<string, NotifKey> = {
  BOOKED: { titleKey: "notifParcelBooked", bodyKey: "notifParcelBookedBody", icon: "cube-outline" },
};

export const logger = pinoLogger;

/* ── ID + login lockout helpers ─────────────────────────────── */
export function generateId(p?: string) {
  return (p ? `${p}_` : "") + randomBytes(8).toString("hex");
}

export function checkAdminLoginLockout(adminId: string): { locked: boolean; minutesLeft: number } {
  const a = adminLoginAttempts.get(adminId);
  if (a && a.count >= ADMIN_MAX_ATTEMPTS) {
    const remaining = ADMIN_LOCKOUT_TIME - (Date.now() - a.lastAttempt);
    if (remaining > 0) return { locked: true, minutesLeft: Math.ceil(remaining / 60000) };
  }
  return { locked: false, minutesLeft: 0 };
}
export async function recordAdminLoginFailure(id: string) {
  const a = adminLoginAttempts.get(id) || { count: 0, lastAttempt: 0 };
  adminLoginAttempts.set(id, { count: a.count + 1, lastAttempt: Date.now() });
}
export async function resetAdminLoginAttempts(id: string) { adminLoginAttempts.delete(id); }

/* ── JWT + admin secret ─────────────────────────────────────── */
export function signAdminJwt(adminId: string | null, role?: string, name?: string, ttlHours?: number) {
  return jwt.sign(
    { adminId, role, name },
    process.env["JWT_SECRET"] || "key",
    { expiresIn: `${ttlHours ?? ADMIN_TOKEN_TTL_HRS}h` },
  );
}
export function verifyAdminJwt(t: string) {
  try { return jwt.verify(t, process.env["JWT_SECRET"] || "key"); } catch { return null; }
}
export async function getAdminSecret(_id?: string) {
  /* Use the runtime-config module so a secret rotated via the rotate-secret
     endpoint takes effect immediately without a server restart. Falls back to
     the env var if the module is not yet seeded. */
  try {
    const { getAdminSecretRuntime } = await import("../lib/runtime-config.js");
    const runtime = getAdminSecretRuntime();
    if (runtime) return runtime;
  } catch { /* non-fatal — fall through */ }
  return process.env["ADMIN_SECRET"] || null;
}
export async function verifyAdminSecret(p: string, h: string) {
  try { return await bcrypt.compare(p, h); } catch { return p === h; }
}
export async function hashAdminSecret(s: string) { return await bcrypt.hash(s, 10); }

/* ── 2FA: real RFC-6238 verification (encrypted secret stored in DB) ── */
export async function verifyTotpToken(secret: string, token: string): Promise<boolean> {
  if (!secret || !token) return false;
  try {
    const plain = decryptTotpSecret(secret);
    return totpVerify(token, plain);
  } catch (err) {
    logger.error("[verifyTotpToken] failed:", err);
    return false;
  }
}

/**
 * The forced "must change password" gate has been removed. Tokens are
 * no longer minted with the `mpc` claim and admins are never blocked
 * because of it. The SPA now drives an OPTIONAL credentials popup off
 * the `defaultCredentials` flag returned with every auth response.
 *
 * The allow-list / `isForcedPasswordChangeAllowed` helper that used to
 * live here have been deleted along with the gate. Any legacy `mpc`
 * claim on previously-issued tokens is silently ignored below.
 */

/* ── adminAuth middleware (Bearer JWT) ──
   Verifies `Authorization: Bearer <jwt>` and attaches `req.admin`.
   Accepts BOTH legacy admin tokens (signed with JWT_SECRET) AND the new
   admin-auth-v2 access tokens (signed with ADMIN_ACCESS_TOKEN_SECRET).
   Rejects with 401 on missing/invalid/expired token. */
export const adminAuth = (req: AdminRequest, res: Response, next: NextFunction) => {
  try {
    const header = req.headers["authorization"] || req.headers["authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith("Bearer ") ? raw.slice(7).trim() : raw?.trim();
    if (!token) return res.status(401).json({ success: false, error: "Missing admin token" });

    // Try legacy verification first (adminId/role/name claims)
    let decoded: any = verifyAdminJwt(token);
    if (decoded && typeof decoded === "object" && (decoded.adminId || decoded.sub)) {
      const adminId = decoded.adminId ?? decoded.sub ?? null;
      const role    = decoded.role ?? "manager";
      const name    = decoded.name;
      const perms: string[] = Array.isArray(decoded.perms) ? decoded.perms : [];
      req.admin = { adminId, role, name, permissions: perms };
      req.adminId = adminId ?? undefined;
      req.adminRole = role;
      req.adminName = name;
      req.adminPermissions = perms;
      req.adminIp = (req.ip || (req.headers["x-forwarded-for"] as string) || "").split(",")[0]?.trim();
      // The legacy `mpc` (must-change-password) gate has been removed.
      // Any pre-existing claim on already-issued tokens is ignored — the
      // SPA decides whether to surface the optional credentials popup
      // based on the `defaultCredentials` flag in auth responses.
      return next();
    }

    // Fall back to new admin-auth-v2 access token (sub/role/name/perms claims)
    try {
      const payload = verifyAccessToken(token);
      const perms: string[] = Array.isArray(payload.perms) ? payload.perms : [];
      req.admin = {
        adminId: payload.sub ?? null,
        role: payload.role ?? "manager",
        name: payload.name,
        permissions: perms,
      };
      req.adminId = payload.sub ?? undefined;
      req.adminRole = payload.role;
      req.adminName = payload.name;
      req.adminPermissions = perms;
      req.adminIp = (req.ip || (req.headers["x-forwarded-for"] as string) || "").split(",")[0]?.trim();
      // See note above: the forced password-change gate has been
      // removed. Legacy `mpc` claims are silently ignored.
      return next();
    } catch {
      return res.status(401).json({ success: false, error: "Invalid or expired admin token" });
    }
  } catch (err) {
    logger.error("[adminAuth] failed:", err);
    return res.status(401).json({ success: false, error: "Auth failure" });
  }
};

/* ══════════════════════════════════════════════════════════════
   PLATFORM SETTINGS — single source of truth for runtime flags.
   30s in-memory cache + DB fallback to last-known on read failure.
══════════════════════════════════════════════════════════════ */
const PLATFORM_SETTINGS_TTL_MS = 30_000;
let _settingsCache: Record<string, string> = {};
let _settingsCacheExpiry = 0;

export async function getPlatformSettings(): Promise<Record<string, string>> {
  try {
    const rows = await db
      .select({ key: platformSettingsTable.key, value: platformSettingsTable.value })
      .from(platformSettingsTable);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  } catch (err) {
    logger.error("[getPlatformSettings] DB read failed:", err);
    return _settingsCache;
  }
}

export async function getCachedSettings(_k?: string): Promise<Record<string, string>> {
  if (Date.now() < _settingsCacheExpiry && Object.keys(_settingsCache).length > 0) return _settingsCache;
  const fresh = await getPlatformSettings();
  if (Object.keys(fresh).length > 0) {
    _settingsCache = fresh;
    _settingsCacheExpiry = Date.now() + PLATFORM_SETTINGS_TTL_MS;
  }
  return _settingsCache;
}
export function invalidateSettingsCache() { _settingsCacheExpiry = 0; }
export const invalidatePlatformSettingsCache = invalidateSettingsCache;

/* ══════════════════════════════════════════════════════════════
   USER HELPERS
══════════════════════════════════════════════════════════════ */
const SENSITIVE_USER_FIELDS = [
  "passwordHash",
  "totpSecret",
  "otpCode",
  "otpExpiry",
  "otpUsed",
  "emailOtpCode",
  "emailOtpExpiry",
  "walletPinHash",
] as const;

/** Remove security-sensitive columns before returning a user row to a client. */
export function stripUser<T extends Record<string, any> | null | undefined>(u: T): T {
  if (!u || typeof u !== "object") return u;
  const out: Record<string, any> = { ...u };
  for (const f of SENSITIVE_USER_FIELDS) delete out[f];
  return out as T;
}

/** Read the user's preferred language from `user_settings`, or fall back. */
export async function getUserLanguage(userId: string | { id?: string } | null | undefined): Promise<Language> {
  const id = typeof userId === "string" ? userId : userId?.id;
  if (!id) return DEFAULT_LANGUAGE;
  try {
    const [row] = await db
      .select({ language: userSettingsTable.language })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, id))
      .limit(1);
    const lang = row?.language as Language | undefined;
    if (lang) return lang;
  } catch (err) {
    logger.error("[getUserLanguage] failed:", err);
  }
  return DEFAULT_LANGUAGE;
}

export type TranslationKey = string;

/** i18n with `{var}` interpolation. Falls back to the key if no translation exists. */
export function t(key: string, lang?: string, params?: Record<string, any>): string {
  let out: string;
  try {
    out = i18nT(key as I18nKey, (lang as Language) || DEFAULT_LANGUAGE) || key;
  } catch {
    out = key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
   AUDIT LOG — persisted to `auth_audit_log` table.
══════════════════════════════════════════════════════════════ */
interface AuditPayload {
  action?: string;
  event?: string;
  userId?: string | null;
  adminId?: string | null;
  ip?: string;
  userAgent?: string;
  details?: any;
  metadata?: any;
  result?: string;
  severity?: string;
  [extra: string]: any;
}

export function auditLog(data: AuditPayload | string, ..._rest: unknown[]): { id: string } {
  const id = "audit_" + randomBytes(6).toString("hex");
  try {
    const payload: AuditPayload = typeof data === "string" ? { event: data } : (data ?? {});
    const event = payload.action || payload.event || "unknown";
    const meta: Record<string, any> = {};
    if (payload.details !== undefined) meta["details"] = payload.details;
    if (payload.metadata !== undefined) Object.assign(meta, payload.metadata);
    if (payload.result !== undefined) meta["result"] = payload.result;
    if (payload.adminId !== undefined) meta["adminId"] = payload.adminId;
    // Fire-and-forget; never block the caller.
    db.insert(authAuditLogTable).values({
      id,
      userId: payload.userId ?? null,
      event,
      ip: payload.ip || "unknown",
      userAgent: payload.userAgent ?? null,
      metadata: Object.keys(meta).length ? JSON.stringify(meta) : null,
    }).catch((err: unknown) => logger.error("[auditLog] insert failed:", err));
  } catch (err) {
    logger.error("[auditLog] failed:", err);
  }
  return { id };
}
export const addAuditEntry = auditLog;

/** Persist a security event using the same audit log table (event prefixed `security:`). */
export async function addSecurityEvent(d: AuditPayload & { type?: string }): Promise<{ id: string }> {
  const event = `security:${d.type || d.action || d.event || "event"}`;
  return auditLog({ ...d, event });
}

/* ══════════════════════════════════════════════════════════════
   REQUEST IP — handles x-forwarded-for / cf-connecting-ip / req.ip.
══════════════════════════════════════════════════════════════ */
export function getClientIp(req: Request | any): string {
  try {
    const h = req?.headers || {};
    const cf = h["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const xff = h["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
    const xreal = h["x-real-ip"];
    if (typeof xreal === "string" && xreal) return xreal;
    if (typeof req?.ip === "string" && req.ip) return req.ip.replace(/^::ffff:/, "");
    const sock = req?.socket?.remoteAddress;
    if (typeof sock === "string" && sock) return sock.replace(/^::ffff:/, "");
  } catch {}
  return "0.0.0.0";
}

/* ══════════════════════════════════════════════════════════════
   USER NOTIFICATIONS — persisted to `notifications` table.
══════════════════════════════════════════════════════════════ */
export async function sendUserNotification(
  userId: string,
  titleOrData: string | { title: string; body?: string; type?: string; icon?: string; link?: string },
  body?: string,
  type?: string,
  icon?: string,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const isObj = typeof titleOrData === "object" && titleOrData !== null;
    const title = isObj ? titleOrData.title : titleOrData;
    const finalBody = isObj ? (titleOrData.body ?? "") : (body ?? "");
    const finalType = isObj ? (titleOrData.type ?? "system") : (type ?? "system");
    const finalIcon = isObj ? (titleOrData.icon ?? "notifications-outline") : (icon ?? "notifications-outline");
    const finalLink = isObj ? titleOrData.link : undefined;
    await db.insert(notificationsTable).values({
      id: generateId("notif"),
      userId,
      title: String(title || ""),
      body: String(finalBody),
      type: finalType,
      icon: finalIcon,
      link: finalLink ?? null,
      isRead: false,
    });
    return true;
  } catch (err) {
    logger.error("[sendUserNotification] failed:", err);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   SESSIONS — soft-revoke all active sessions for a user.
══════════════════════════════════════════════════════════════ */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await db
      .update(userSessionsTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessionsTable.userId, userId), isNull(userSessionsTable.revokedAt)));
  } catch (err) {
    logger.error("[revokeAllUserSessions] failed:", err);
  }
}

/* ══════════════════════════════════════════════════════════════
   PASSTHROUGH SHAPERS — kept as identity functions because the DB
   rows already match the wire format these consumers expect.
══════════════════════════════════════════════════════════════ */
export function serializeSosAlert(a: any): any { return a; }
export function formatSvc(s: any): any { return s; }

/* ══════════════════════════════════════════════════════════════
   SCHEMA MIGRATION HELPERS — Drizzle's `db push` already manages
   schema. These functions remain as no-ops to preserve their
   API for legacy callers; they intentionally return without DDL.
══════════════════════════════════════════════════════════════ */
export async function ensureAuthMethodColumn() { return true; }
export async function ensureRideBidsMigration() { return true; }
export async function ensureOrdersGpsColumns() { return true; }
export async function ensurePromotionsTables() { return true; }
export async function ensureSupportMessagesTable() { return true; }
export async function ensureDefaultRideServices() { return; }
export async function ensureDefaultLocations() { return; }
export async function ensureFaqsTable() { return true; }
export async function ensureCommunicationTables() { return true; }
export async function ensureVendorLocationColumns() { return true; }
export async function ensureVanServiceUpgrade() { return true; }
export async function ensureWalletP2PColumns() { return true; }
export async function ensureComplianceTables() { return true; }
export const DEFAULT_RIDE_SERVICES: any[] = [];
