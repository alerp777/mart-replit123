import { db } from "@workspace/db";
import { userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getPlatformSettings } from "../routes/admin-shared.js";
import type { Language } from "@workspace/i18n";

const VALID_LANGUAGES: Language[] = ["en", "ur", "roman", "en_roman", "en_ur"];

export async function getPlatformDefaultLanguage(): Promise<Language> {
  try {
    const s = await getPlatformSettings();
    const lang = s["default_language"] as Language | undefined;
    if (lang && VALID_LANGUAGES.includes(lang)) return lang;
  } catch {}
  return "en";
}

export async function getUserLanguage(userId: string): Promise<Language> {
  try {
    const [settings] = await db
      .select({ language: userSettingsTable.language })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);

    if (settings?.language && VALID_LANGUAGES.includes(settings.language as Language)) {
      return settings.language as Language;
    }
  } catch {}

  return getPlatformDefaultLanguage();
}
