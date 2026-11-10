'use server';
import { GoogleGenAI } from "@google/genai";

export async function processImage(base64Image: string) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY bulunamadı.');

    // SDK istemcisini başlat (Varsayılan olarak kararlı v1'e bağlanır)
    const client = new GoogleGenAI({ apiKey: apiKey });

    // Frontend'den gelen base64 başlığını temizle
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const prompt = 'Sen bir hırdavat depo asistanısın. Bu fotoğraftaki hırdavat ürününün etiketini ve varsa barkodunu oku. Bana sadece JSON formatında şu üç bilgiyi dön: {"marka": "...", "urunAdi": "...", "barkod": "Resimde okunabilir bir barkod numarası varsa buraya yaz, yoksa boş bırak"}';

    // Kararlı olan models.generateContent kullanıyoruz
    const response = await client.models.generateContent({
        model: "gemini-3.8-flash",
        contents: [
            prompt,
            {
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg"
                }
            }
        ]
    });

    // SDK versiyon farklılıklarına karşı güvenli metin okuma
    const resAny = response as any;
    const responseText = typeof resAny?.text === 'function' ? resAny.text() : resAny?.text;
    if (!responseText) throw new Error('Yapay zeka boş yanıt döndürdü.');

    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedText);

  } catch (error: any) {
    console.error('GenAI SDK generateContent Hatası:', error);
    throw new Error(error.message || 'Görüntü işlenirken bir hata oluştu.');
  }
}
