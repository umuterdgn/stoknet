"use server";

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

export interface SaveToSheetsResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function saveToSheets(
  markaOrPayload: string | { marka: string; urunAdi: string; stok: number },
  urunAdiArg?: string,
  stokArg?: number
): Promise<SaveToSheetsResponse> {
  let marka: string;
  let urunAdi: string;
  let stok: number;

  if (typeof markaOrPayload === "object" && markaOrPayload !== null) {
    marka = markaOrPayload.marka || "";
    urunAdi = markaOrPayload.urunAdi || "";
    stok = Number(markaOrPayload.stok) || 0;
  } else {
    marka = markaOrPayload || "";
    urunAdi = urunAdiArg || "";
    stok = Number(stokArg) || 0;
  }

  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!serviceAccountEmail || !rawPrivateKey || !sheetId) {
    console.warn("Google Sheets kimlik değişkenleri eksik:", {
      hasEmail: Boolean(serviceAccountEmail),
      hasKey: Boolean(rawPrivateKey),
      hasSheetId: Boolean(sheetId),
    });

    return {
      success: false,
      error:
        "Google Sheets kimlik bilgileri eksik. Lütfen GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY ve GOOGLE_SHEET_ID çevre değişkenlerini .env.local dosyasına ekleyin.",
    };
  }

  // Ensure \\n in private key is correctly converted to actual newlines
  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");

  try {
    const serviceAccountAuth = new JWT({
      email: serviceAccountEmail,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);

    // Load document metadata and sheets
    await doc.loadInfo();

    // Access the first sheet (index 0)
    const sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      return {
        success: false,
        error: "Google Tablosunda ilk çalışma sayfası (index 0) bulunamadı.",
      };
    }

    // Timestamp formatted according to Turkish locale
    const timestamp = new Date().toLocaleString("tr-TR");

    // Ensure header row is loaded or set if sheet is blank
    try {
      await sheet.loadHeaderRow();
    } catch {
      // If sheet has no header row yet, initialize Column A, B, C, D headers
      await sheet.setHeaderRow(["Marka", "Ürün Adı", "Stok", "Zaman Damgası"]);
    }

    // Append row mapping exactly: Column A = marka, Column B = urunAdi, Column C = stok, Column D = timestamp
    await sheet.addRow([marka, urunAdi, stok, timestamp]);

    return {
      success: true,
      message: "Veriler başarıyla Google E-Tabloya kaydedildi.",
    };
  } catch (error: unknown) {
    console.error("Google Sheets save error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Google E-Tabloya kaydedilirken bir hata oluştu.";
    return {
      success: false,
      error: errorMessage,
    };
  }
}

