"use client";

import React, { useState, useRef, useEffect, useCallback, useTransition } from "react";
import Image from "next/image";
import {
  Camera,
  RotateCcw,
  Check,
  X,
  FlipHorizontal,
  Zap,
  ZapOff,
  Image as ImageIcon,
  AlertCircle,
  Plus,
  Minus,
  Sparkles,
  Loader2,
  ScanLine,
  Barcode,
  Layers,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeft,
} from "lucide-react";
import { processImage } from "@/actions/process-image";
import { saveToSheets } from "@/actions/save-to-sheets";

type AppState = "camera" | "form";

interface FormData {
  brand: string;
  productName: string;
  barcode: string;
  stockQuantity: string;
}

interface BatchItem {
  id: string;
  fileName: string;
  thumbnail: string;
  marka: string;
  urunAdi: string;
  barkod: string;
  stok: string;
  status: "success" | "error";
  errorMessage?: string;
  saved: boolean;
}

// Kamera görüntüsünü veya video akışını yakaladığında şu sıkıştırma fonksiyonunu çalıştır:
const compressImage = (imageSrc: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      
      // Maksimum boyutları 640x480 piksele sabitle
      const MAX_WIDTH = 640;
      const MAX_HEIGHT = 480;
      
      if (width > height) {
        if (width > MAX_WIDTH) {
          height *= MAX_WIDTH / width;
          width = MAX_WIDTH;
        }
      } else {
        if (height > MAX_HEIGHT) {
          width *= MAX_HEIGHT / height;
          height = MAX_HEIGHT;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      
      // Kaliteyi %50'ye düşürerek ham veriyi 100 KB altına indir
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.5);
      resolve(compressedDataUrl);
    };
    img.onerror = () => {
      reject(new Error('Görsel sıkıştırma sırasında yüklenemedi veya dosya bozuk.'));
    };
    img.src = imageSrc;
  });
};

// Her işlem için benzersiz Request ID üretir
const generateRequestId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Server Action çağrısını 15s zaman aşımı ile sınırlar (Fail-Fast, tekil çağrı)
const processImageWithTimeout = async (
  base64Image: string,
  requestId: string,
  timeoutMs = 15000
) => {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      const timeoutErr = new Error("ZAMAN_ASIMI");
      timeoutErr.name = "TimeoutError";
      reject(timeoutErr);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      processImage(base64Image, requestId),
      timeoutPromise,
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
};

export default function InventoryPage() {
  const [mounted, setMounted] = useState(false);
  const [currentState, setCurrentState] = useState<AppState>("camera");
  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  // Form state management (no mock data)
  const [formData, setFormData] = useState<FormData>({
    brand: "",
    productName: "",
    barcode: "",
    stockQuantity: "",
  });

  // AI & Processing state
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [aiErrorNotice, setAiErrorNotice] = useState<string | null>(null);
  const [aiErrorType, setAiErrorType] = useState<"timeout" | "api" | null>(null);
  const [aiDetected, setAiDetected] = useState(false);
  const [, startTransition] = useTransition();

  // Sheets Saving & Toast state
  const [isSaving, setIsSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Camera UI state
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [shutterEffect, setShutterEffect] = useState(false);

  // Batch Processing (Toplu İşlem) state
  const [isBatchView, setIsBatchView] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [batchCurrentImage, setBatchCurrentImage] = useState<string | null>(null);
  const [batchWaitingCooldown, setBatchWaitingCooldown] = useState(false);
  const [batchStatusText, setBatchStatusText] = useState<string>("");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchErrorLogs, setBatchErrorLogs] = useState<string[]>([]);
  const [isBatchSavingAll, setIsBatchSavingAll] = useState(false);

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stockInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const batchFileInputRef = useRef<HTMLInputElement | null>(null);
  const batchCancelRef = useRef(false);

  // Prevent SSR locking by waiting for client-side mount
  useEffect(() => {
    setMounted(true);
  }, []);

  // Stop camera tracks cleanly
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Start camera stream with optimized constraints (640x480 for fast processing)
  const startCamera = useCallback(async () => {
    stopCamera();
    setCameraError(null);
    setTorchOn(false);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Bu cihazda kamera erişimi desteklenmiyor.");
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // Check if torch is supported
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.getCapabilities === "function") {
        const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & {
          torch?: boolean;
        };
        setHasTorch(Boolean(capabilities?.torch));
      }
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : "Kamera başlatılamadı.";
      console.warn("Kamera erişim hatası:", errorMsg);
      setCameraError(
        "Kamera erişimi sağlanamadı. Lütfen kamera izinlerini kontrol edin veya cihaz kamerasını etkinleştirin."
      );
    }
  }, [facingMode, stopCamera]);

  // Manage camera lifecycle based on state
  useEffect(() => {
    if (mounted && currentState === "camera" && !isAiProcessing && !isBatchView) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [mounted, currentState, isAiProcessing, isBatchView, startCamera, stopCamera]);

  // Auto-focus stock quantity input immediately upon rendering Form State (Safe: no setState)
  useEffect(() => {
    if (currentState === "form" && !isBatchView) {
      const timer = setTimeout(() => {
        if (stockInputRef.current) {
          stockInputRef.current.focus();
          stockInputRef.current.select();
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [currentState, isBatchView]);

  // Process image with Gemini Vision via Server Action (15s kontrollü timeout, unique requestId, performance measurement)
  const runAiVisionProcessing = async (base64Image: string, requestId: string) => {
    setIsAiProcessing(true);
    setAiErrorNotice(null);
    setAiErrorType(null);
    setAiDetected(false);
    setSaveError(null);

    const startTime = performance.now();
    console.log(`[RequestID: ${requestId}] Frontend: İstek başlatıldı (15s zaman aşımı kontrolü). Boyut: ~${Math.round(base64Image.length / 1024)} KB`);

    try {
      // Fail-Fast + 15s Timeout: API çağrısı için while veya retry döngüsü yok, tekil istek
      const result = await processImageWithTimeout(base64Image, requestId);

      const duration = Math.round(performance.now() - startTime);
      console.log(`[RequestID: ${requestId}] Gerçek işleme süresi: ${duration} ms`);

      const brand = typeof result?.marka === "string" ? result.marka.trim() : "";
      const product = typeof result?.urunAdi === "string" ? result.urunAdi.trim() : "";
      const barcode = typeof result?.barkod === "string" ? result.barkod.trim() : "";

      if (brand || product || barcode) {
        setFormData({
          brand: brand || "Bilinmiyor",
          productName: product || "",
          barcode: barcode || "",
          stockQuantity: "",
        });
        setAiDetected(true);
      } else {
        setFormData({
          brand: "",
          productName: "",
          barcode: "",
          stockQuantity: "",
        });
      }
    } catch (err: any) {
      const duration = Math.round(performance.now() - startTime);
      console.log(`[RequestID: ${requestId}] Gerçek işleme süresi: ${duration} ms`);

      // Hata Ayrıştırması: 'Zaman Aşımı (Timeout)' mu yoksa 'Google API / Sunucu Hatası' mı?
      const isTimeout =
        err?.name === "TimeoutError" ||
        err?.message === "ZAMAN_ASIMI" ||
        err?.message?.toLowerCase().includes("timeout") ||
        err?.message?.toLowerCase().includes("zaman aşımı");

      if (isTimeout) {
        setAiErrorType("timeout");
        setAiErrorNotice(
          "İstek 15 saniye içinde tamamlanamadı ve zaman aşımına uğradı. Sunucu veya internet bağlantısı geç yanıt verdi. 'Yeniden Çek' butonuyla tekrar deneyebilir veya bilgileri elle doldurabilirsiniz."
        );
      } else {
        setAiErrorType("api");
        const detailMsg = err?.message || "Google API yanıt vermedi veya geçersiz yanıt döndü.";
        setAiErrorNotice(
          `Google API / Sunucu Hatası: ${detailMsg}. Bilgileri elle doldurabilir veya 'Yeniden Çek' butonu ile yeni fotoğraf deneyebilirsiniz.`
        );
      }

      setFormData({
        brand: "",
        productName: "",
        barcode: "",
        stockQuantity: "",
      });
    } finally {
      setIsAiProcessing(false);
      setCurrentState("form");
    }
  };

  // 'FOTOĞRAF ÇEK' BUTONU ONCLICK FONKSİYONU:
  // Benzersiz RequestID üretir, video karesini alır, compressImage ile sıkıştırır ve processImage'e gönderir.
  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video) return;

    // Deklanşör flaş animasyonu
    setShutterEffect(true);
    setTimeout(() => setShutterEffect(false), 150);

    // Her işlemde benzersiz Request ID (crypto.randomUUID)
    const requestId = generateRequestId();

    // Video akışından ham görüntüyü bir canvas üzerine aktar
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = video.videoWidth || 640;
    tempCanvas.height = video.videoHeight || 480;
    const ctx = tempCanvas.getContext("2d");
    if (!ctx) return;

    if (facingMode === "user") {
      ctx.translate(tempCanvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    const rawImageSrc = tempCanvas.toDataURL("image/jpeg", 0.95);

    // İstemci tarafında kesin sıkıştırma fonksiyonunu çalıştır (maksimum 640x480, %50 JPEG kalitesi)
    let compressedImage = rawImageSrc;
    try {
      compressedImage = await compressImage(rawImageSrc);
    } catch (err) {
      console.warn("Kamera görüntüsü sıkıştırma uyarısı, ham veri ile devam ediliyor:", err);
    }

    // Kamera donanımını kapat ve önizlemeyi kaydet
    stopCamera();
    setCapturedImage(compressedImage);

    // Dönen sıkıştırılmış base64 string ve Request ID Server Action'a verilsin
    startTransition(() => {
      runAiVisionProcessing(compressedImage, requestId);
    });
  };

  // Toggle flashlight / torch
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track) {
      try {
        const newTorchState = !torchOn;
        await (track as MediaStreamTrack & {
          applyConstraints: (c: unknown) => Promise<void>;
        }).applyConstraints({
          advanced: [{ torch: newTorchState }],
        });
        setTorchOn(newTorchState);
      } catch (e) {
        console.warn("Torch not supported", e);
      }
    }
  };

  // Flip camera between environment and user
  const toggleCameraFacing = () => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  // Fallback: File upload when camera is unavailable (sıkıştırma köprüsünü çalıştırır)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const result = event.target?.result as string;
      if (result) {
        const requestId = generateRequestId();

        try {
          const compressed = await compressImage(result);
          stopCamera();
          setCapturedImage(compressed);
          startTransition(() => {
            runAiVisionProcessing(compressed, requestId);
          });
        } catch (err) {
          console.error("Dosya sıkıştırma hatası:", err);
          setAiErrorType("api");
          setAiErrorNotice("Seçilen görsel işlenemedi veya dosya bozuk.");
          setCurrentState("form");
        }
      }
    };
    reader.readAsDataURL(file);
  };

  // Helper: Dosyayı Base64 DataURL formatında oku
  const readFileAsDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`Dosya okunamadı: ${file.name}`));
      reader.readAsDataURL(file);
    });
  };

  // TOPLU İŞLEM (BATCH PROCESSING) - ASLA PES ETMEYEN (INFINITE RETRY) MANTIĞI:
  // Zaman aşımı yok; 503/yoğunluk hatalarında fotoğrafı asla atlamaz.
  // 5 saniye bekleyip aynı fotoğrafı yeniden dener, Google Sheets'e kaydedilince sıradakine geçer.
  const handleBatchUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    stopCamera();
    batchCancelRef.current = false;
    setIsBatchView(true);
    setIsBatchProcessing(true);
    setBatchItems([]);
    setBatchErrorLogs([]);
    setBatchWaitingCooldown(false);
    setBatchStatusText("Durum: Kuyruk başlatılıyor...");
    setBatchCurrentImage(null);
    setBatchProgress({ current: 0, total: files.length });

    let index = 0;

    for (const file of files) {
      if (batchCancelRef.current) {
        setBatchStatusText(`Durum: İşlem kullanıcı tarafından durduruldu.`);
        break;
      }

      index += 1;
      setBatchProgress({ current: index, total: files.length });

      // 1. Resmi oku ve mevcut compressImage fonksiyonu ile sıkıştır (640x480, %50 JPEG)
      let compressedBase64 = "";
      try {
        setBatchStatusText(`Durum: "${file.name}" sıkıştırılıyor...`);
        const rawDataUrl = await readFileAsDataURL(file);
        compressedBase64 = await compressImage(rawDataUrl);
        setBatchCurrentImage(compressedBase64);
      } catch (fileErr: any) {
        console.error(`Dosya okuma/sıkıştırma hatası [${file.name}]:`, fileErr);
        setBatchErrorLogs((prev) => [
          ...prev,
          `#${index} [${file.name}]: Dosya okunamadı/bozuk (${fileErr?.message || "hata"})`,
        ]);
        continue;
      }

      let success = false;
      let attempt = 0;

      // İnatçı Tekrar Döngüsü: Fotoğraf Google Sheets'e kaydedilene kadar asla pes etmez
      while (!success) {
        if (batchCancelRef.current) {
          setBatchStatusText(`Durum: İşlem kullanıcı tarafından durduruldu.`);
          break;
        }

        attempt += 1;
        const requestId = generateRequestId();
        const startTime = performance.now();

        try {
          setBatchStatusText(
            attempt === 1
              ? `Durum: "${file.name}" analiz ediliyor (zaman aşımı yok)...`
              : `Durum: "${file.name}" yeniden deneniyor (Deneme #${attempt})...`
          );

          console.log(
            `[RequestID: ${requestId}] Batch (${index}/${files.length}, Deneme #${attempt}): "${file.name}" (~${Math.round(compressedBase64.length / 1024)} KB) gönderiliyor (Timeout yok)...`
          );

          // Zaman Aşımını Kaldır: Promise.race veya timeout yok, istek ne kadar sürerse sürsün bekler
          const result = await processImage(compressedBase64, requestId);

          const duration = Math.round(performance.now() - startTime);
          console.log(
            `[RequestID: ${requestId}] Gerçek işleme süresi: ${duration} ms (Batch ${index}/${files.length}, Deneme #${attempt})`
          );

          const brand = typeof result?.marka === "string" ? result.marka.trim() : "";
          const product = typeof result?.urunAdi === "string" ? result.urunAdi.trim() : "";
          const barcode = typeof result?.barkod === "string" ? result.barkod.trim() : "";

          // Google Sheets'e kaydet
          setBatchStatusText(`Durum: "${brand || file.name}" Google Sheets'e kaydediliyor...`);
          const sheetsRes = await saveToSheets(
            brand || "Bilinmiyor",
            product || "İsimsiz Ürün",
            barcode || "",
            1
          );

          if (!sheetsRes.success) {
            throw new Error(sheetsRes.error || "Google E-Tabloya kaydedilemedi.");
          }

          // Başarı Durumu: Google Sheets'e başarıyla kaydedilince success = true yapıp döngüyü bitir
          success = true;
          setBatchStatusText(`Durum: "${brand || file.name}" Google Sheets'e başarıyla kaydedildi!`);

          setBatchItems((prev) => [
            ...prev,
            {
              id: requestId,
              fileName: file.name,
              thumbnail: compressedBase64,
              marka: brand || "Bilinmiyor",
              urunAdi: product || "",
              barkod: barcode || "",
              stok: "1",
              status: "success",
              saved: true,
            },
          ]);
        } catch (err: any) {
          // Fotoğrafı atlama (skip etme)! 5 saniye bekle ve AYNI fotoğrafı tekrar dene.
          const duration = Math.round(performance.now() - startTime);
          const errMsg = err?.message || "Google API / Sunucu hatası";

          console.warn(
            `[RequestID: ${requestId}] Batch (${index}/${files.length}, Deneme #${attempt}) HATA (${duration} ms): ${errMsg} -> 5sn sonra aynı fotoğraf tekrar denenecek.`
          );

          setBatchStatusText("Durum: Google sunucuları yoğun, 5 saniye sonra tekrar deneniyor...");
          setBatchErrorLogs((prev) => [
            ...prev.slice(-29),
            `#${index} [${file.name} - Deneme #${attempt}]: ${errMsg} (5sn sonra tekrar)`,
          ]);

          setBatchWaitingCooldown(true);
          await new Promise((res) => setTimeout(res, 5000));
          setBatchWaitingCooldown(false);
        }
      }

      if (batchCancelRef.current) break;

      // Bir sonraki fotoğrafa geçmeden önce API limit koruması (3s bekleme)
      if (index < files.length) {
        setBatchStatusText("Durum: Sıradaki fotoğraf için 3 saniye bekleniyor...");
        setBatchWaitingCooldown(true);
        await new Promise((res) => setTimeout(res, 3000));
        setBatchWaitingCooldown(false);
      }
    }

    setIsBatchProcessing(false);
    setBatchWaitingCooldown(false);
    setBatchCurrentImage(null);
    if (!batchCancelRef.current) {
      setBatchStatusText("Durum: Tüm fotoğraflar Google Sheets'e kaydedildi!");
    }
  };

  // Batch item field updater
  const updateBatchItem = (id: string, field: "marka" | "urunAdi" | "barkod" | "stok", value: string) => {
    setBatchItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  // Save a single batch item to Google Sheets
  const handleSaveBatchItem = async (id: string) => {
    const target = batchItems.find((item) => item.id === id);
    if (!target || target.saved || target.status !== "success") return;

    const stockNum = parseInt(target.stok, 10);
    const validStock = isNaN(stockNum) ? 0 : stockNum;

    try {
      const res = await saveToSheets(
        target.marka || "Bilinmiyor",
        target.urunAdi || "İsimsiz Ürün",
        target.barkod || "",
        validStock
      );
      if (res.success) {
        setBatchItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, saved: true } : item))
        );
        setToastMessage(`Kaydedildi: ${target.marka}`);
        setTimeout(() => setToastMessage(null), 2500);
      } else {
        setBatchErrorLogs((prev) => [
          ...prev,
          `Kayıt Hatası [${target.fileName}]: ${res.error || "Bilinmeyen hata"}`,
        ]);
      }
    } catch (err: any) {
      setBatchErrorLogs((prev) => [
        ...prev,
        `Kayıt Hatası [${target.fileName}]: ${err?.message || "Sunucu hatası"}`,
      ]);
    }
  };

  // Save all unsaved successful batch items sequentially to Google Sheets
  const handleSaveAllBatchItems = async () => {
    if (isBatchSavingAll || isBatchProcessing) return;
    const unsaved = batchItems.filter((item) => item.status === "success" && !item.saved);
    if (unsaved.length === 0) return;

    setIsBatchSavingAll(true);
    let savedCount = 0;

    for (const item of unsaved) {
      const stockNum = parseInt(item.stok, 10);
      const validStock = isNaN(stockNum) ? 0 : stockNum;

      try {
        const res = await saveToSheets(
          item.marka || "Bilinmiyor",
          item.urunAdi || "İsimsiz Ürün",
          item.barkod || "",
          validStock
        );
        if (res.success) {
          savedCount += 1;
          setBatchItems((prev) =>
            prev.map((curr) => (curr.id === item.id ? { ...curr, saved: true } : curr))
          );
        } else {
          setBatchErrorLogs((prev) => [
            ...prev,
            `Sheets Hatası [${item.fileName}]: ${res.error || "Kaydedilemedi"}`,
          ]);
        }
      } catch (err: any) {
        setBatchErrorLogs((prev) => [
          ...prev,
          `Sheets Hatası [${item.fileName}]: ${err?.message || "Bağlantı hatası"}`,
        ]);
      }
    }

    setIsBatchSavingAll(false);
    if (savedCount > 0) {
      setToastMessage(`Başarılı: ${savedCount} ürün E-Tabloya kaydedildi!`);
      setTimeout(() => setToastMessage(null), 3200);
    }
  };

  // Close Batch View and return to Camera State
  const handleCloseBatchView = () => {
    if (isBatchProcessing) {
      batchCancelRef.current = true;
    }
    setIsBatchView(false);
    setIsBatchProcessing(false);
    setBatchWaitingCooldown(false);
    setBatchStatusText("");
    setBatchCurrentImage(null);
    setCurrentState("camera");
  };

  // Quick quantity increment/decrement helpers for warehouse use
  const adjustQuantity = (amount: number) => {
    const current = parseInt(formData.stockQuantity, 10);
    const valid = isNaN(current) ? 0 : current;
    const next = Math.max(0, valid + amount);
    setFormData((prev) => ({ ...prev, stockQuantity: next.toString() }));
  };

  // Reset and return to camera state
  const handleCancelAndRetake = () => {
    setCapturedImage(null);
    setAiDetected(false);
    setAiErrorNotice(null);
    setAiErrorType(null);
    setSaveError(null);
    setFormData({ brand: "", productName: "", barcode: "", stockQuantity: "" });
    setCurrentState("camera");
  };

  // Save handler: Saves confirmed data to Google Sheets via Server Action
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return; // Prevent double clicks

    setIsSaving(true);
    setSaveError(null);

    const stockNumber = parseInt(formData.stockQuantity, 10);
    const validStock = isNaN(stockNumber) ? 0 : stockNumber;

    try {
      const res = await saveToSheets(
        formData.brand || "Bilinmiyor",
        formData.productName || "İsimsiz Ürün",
        formData.barcode || "",
        validStock
      );

      if (res.success) {
        // Quick 'Başarılı' toast message
        setToastMessage("Başarılı: E-Tabloya Kaydedildi!");

        // Reset all states
        setCapturedImage(null);
        setAiDetected(false);
        setAiErrorNotice(null);
        setAiErrorType(null);
        setFormData({ brand: "", productName: "", barcode: "", stockQuantity: "" });

        // Return directly to Camera State ready for the next item
        setTimeout(() => {
          setCurrentState("camera");
        }, 750);

        // Hide toast message after 3 seconds
        setTimeout(() => {
          setToastMessage(null);
        }, 3200);
      } else {
        setSaveError(res.error || "Google E-Tabloya kaydedilemedi.");
      }
    } catch (err: unknown) {
      console.error("Sheets save execution error:", err);
      const errMsg =
        err instanceof Error ? err.message : "Sunucuya bağlanırken bir hata oluştu.";
      setSaveError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // SSR Loading Placeholder
  if (!mounted) {
    return (
      <main className="w-full h-dvh bg-black flex flex-col items-center justify-center text-zinc-400 font-mono text-sm select-none">
        <Loader2 className="w-9 h-9 text-amber-400 animate-spin mb-3 stroke-[2.5]" />
        <span>Kamera Yükleniyor...</span>
      </main>
    );
  }

  return (
    <main className="relative w-full h-dvh bg-black text-zinc-100 flex flex-col overflow-hidden select-none">
      {/* Hidden canvas used for video snapshot extraction and 640x480 scale down */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Hidden file input for desktop / camera permission denied fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileUpload}
      />

      {/* Hidden multi-file input for Batch Processing ('Toplu Yükle') */}
      <input
        ref={batchFileInputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={handleBatchUpload}
      />

      {/* Floating Success Toast Message */}
      {toastMessage && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-zinc-900/95 border-2 border-amber-400 text-amber-300 font-mono text-sm font-bold shadow-[0_8px_32px_rgba(217,119,6,0.35)] backdrop-blur-md flex items-center gap-2.5 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="w-6 h-6 rounded-full bg-amber-400 text-black flex items-center justify-center">
            <Check className="w-4 h-4 stroke-[3]" />
          </div>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* =========================================================================
          LOADING SPINNER OVERLAY: AI Vision Analysis Active
          ========================================================================= */}
      {isAiProcessing && (
        <div className="absolute inset-0 z-50 bg-black/95 backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-200">
          {/* Thumbnail background glow */}
          {capturedImage && (
            <div className="relative w-48 h-48 rounded-3xl overflow-hidden border-2 border-amber-500/40 mb-8 shadow-[0_0_50px_rgba(217,119,6,0.25)]">
              <Image
                src={capturedImage}
                alt="İşlenen Görüntü"
                fill
                sizes="192px"
                className="object-cover opacity-60 filter blur-[1px]"
                unoptimized
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />

              {/* Scanning Laser Line Effect */}
              <div className="absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent shadow-[0_0_15px_#f59e0b] animate-bounce" />

              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-amber-400 animate-spin stroke-[2.5]" />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-mono mb-3">
            <ScanLine className="w-4 h-4 text-amber-400 animate-pulse" />
            Gemini Flash Vision
          </div>

          <h2 className="text-xl font-bold font-mono tracking-wide text-zinc-100 mb-2">
            Etiket ve Barkod Okunuyor...
          </h2>
          <p className="text-xs text-zinc-400 max-w-xs leading-relaxed font-mono">
            Hırdavat ürününün marka, model ve barkod bilgileri yapay zeka tarafından analiz ediliyor.
          </p>
        </div>
      )}

      {/* =========================================================================
          STATE 1: CAMERA STATE (Full screen environment camera + massive button)
          ========================================================================= */}
      {!isBatchView && currentState === "camera" && (
        <div className="relative w-full h-full flex flex-col justify-between bg-black overflow-hidden">
          {/* Shutter flash animation effect */}
          {shutterEffect && (
            <div className="absolute inset-0 bg-white z-50 pointer-events-none animate-out fade-out duration-150" />
          )}

          {/* Fullscreen Video Stream */}
          <div className="absolute inset-0 w-full h-full bg-zinc-950 flex items-center justify-center overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${
                facingMode === "user" ? "scale-x-[-1]" : ""
              }`}
            />

            {/* Subtle Hardware Viewfinder / Reticle overlay */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
              <div className="relative w-full max-w-xs aspect-square border border-white/10 rounded-2xl">
                {/* Corner reticle accents (Subtle Gold) */}
                <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-amber-400/90 rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-amber-400/90 rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-amber-400/90 rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-amber-400/90 rounded-br-lg" />

                {/* Center crosshair */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
                  <div className="w-4 h-[1px] bg-amber-400/40" />
                  <div className="h-4 w-[1px] bg-amber-400/40 absolute" />
                </div>

                <div className="absolute -bottom-8 left-0 right-0 text-center">
                  <span className="text-[11px] font-mono tracking-widest text-zinc-400 uppercase bg-black/60 px-2.5 py-1 rounded-full border border-zinc-800 backdrop-blur-md">
                    Ürün Etiketini Hizalayın
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Camera Header (Controls & Branding) */}
          <header className="relative z-20 flex items-center justify-between px-5 pt-safe pt-4 pb-3 bg-gradient-to-b from-black/90 via-black/50 to-transparent backdrop-blur-xs">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
              <span className="font-mono text-xs font-bold tracking-wider text-zinc-200">
                STOK<span className="text-amber-400">NET</span>
              </span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-zinc-900/90 border border-zinc-800 text-zinc-400">
                HIZLI TARAMA
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Torch toggle if available */}
              {hasTorch && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-label="Fener Aç/Kapa"
                  className={`p-3 rounded-full border transition-all active:scale-95 ${
                    torchOn
                      ? "bg-amber-400 text-black border-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.5)]"
                      : "bg-zinc-900/80 text-zinc-300 border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  {torchOn ? <Zap className="w-5 h-5 fill-current" /> : <ZapOff className="w-5 h-5" />}
                </button>
              )}

              {/* Flip camera toggle */}
              <button
                type="button"
                onClick={toggleCameraFacing}
                aria-label="Kamerayı Döndür"
                className="p-3 rounded-full bg-zinc-900/80 text-zinc-300 border border-zinc-800 hover:border-zinc-700 active:scale-95 transition-all"
              >
                <FlipHorizontal className="w-5 h-5" />
              </button>

              {/* Fallback image upload trigger */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Galeriden Fotoğraf Seç"
                className="p-3 rounded-full bg-zinc-900/80 text-zinc-300 border border-zinc-800 hover:border-zinc-700 active:scale-95 transition-all"
              >
                <ImageIcon className="w-5 h-5" />
              </button>
            </div>
          </header>

          {/* Camera Error / Permission Fallback Card */}
          {cameraError && (
            <div className="relative z-30 mx-4 my-auto p-6 rounded-2xl bg-zinc-950/95 border border-red-500/30 text-center shadow-2xl backdrop-blur-md">
              <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-white mb-2">Kamera Akışı Başlatılamadı</h3>
              <p className="text-xs text-zinc-400 mb-6 leading-relaxed">{cameraError}</p>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={startCamera}
                  className="w-full py-3.5 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium text-sm transition-colors border border-zinc-700"
                >
                  Kamerayı Yeniden Dene
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-all shadow-lg shadow-amber-500/20"
                >
                  Cihazdan Fotoğraf Yükle
                </button>
                <button
                  type="button"
                  onClick={() => batchFileInputRef.current?.click()}
                  className="w-full py-3.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-amber-300 font-mono font-bold text-sm transition-all border border-amber-400/40 flex items-center justify-center gap-2"
                >
                  <Layers className="w-4 h-4" />
                  Toplu Yükle (Çoklu Fotoğraf)
                </button>
              </div>
            </div>
          )}

          {/* Bottom Fixed Action Bar: MASSIVE 'FOTOĞRAF ÇEK' BUTTON + SLEEK 'Toplu Yükle' BUTTON */}
          <div className="relative z-20 w-full p-5 pb-safe pb-8 bg-gradient-to-t from-black via-black/80 to-transparent">
            <div className="w-full max-w-md mx-auto flex items-stretch gap-3">
              <button
                type="button"
                onClick={capturePhoto}
                disabled={isAiProcessing}
                className="group relative flex-1 h-20 sm:h-22 rounded-3xl bg-zinc-900 border-2 border-amber-400/80 hover:border-amber-400 active:scale-[0.97] transition-all duration-150 flex items-center justify-center gap-3 sm:gap-4 shadow-[0_8px_32px_rgba(217,119,6,0.28)] overflow-hidden cursor-pointer disabled:opacity-50"
              >
                {/* Subtle gold ambient glow background */}
                <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-400/20 to-amber-500/10 group-hover:from-amber-500/20 group-hover:to-amber-500/20 transition-colors" />

                {/* Shutter Button Ring Icon */}
                <div className="relative flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-full border-2 border-amber-400 bg-amber-400/20 shadow-inner group-active:scale-90 transition-transform shrink-0">
                  <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-amber-400 flex items-center justify-center text-black">
                    <Camera className="w-4 h-4 sm:w-5 sm:h-5 fill-black stroke-black" />
                  </div>
                </div>

                {/* Button Text */}
                <span className="relative text-lg sm:text-2xl font-black tracking-wider text-amber-300 font-mono uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
                  FOTOĞRAF ÇEK
                </span>
              </button>

              {/* Sleek 'Toplu Yükle' Button */}
              <button
                type="button"
                onClick={() => batchFileInputRef.current?.click()}
                disabled={isAiProcessing}
                aria-label="Toplu Yükle"
                className="group relative shrink-0 w-24 sm:w-28 h-20 sm:h-22 rounded-3xl bg-zinc-900/95 border border-zinc-700/80 hover:border-amber-400/70 active:scale-[0.97] transition-all duration-150 flex flex-col items-center justify-center gap-1.5 shadow-lg cursor-pointer disabled:opacity-50"
              >
                <div className="w-9 h-9 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400 group-hover:bg-amber-400/20 transition-colors">
                  <Layers className="w-5 h-5" />
                </div>
                <span className="text-[10px] sm:text-[11px] font-mono font-bold tracking-wide text-zinc-200 group-hover:text-amber-300 uppercase">
                  Toplu Yükle
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          STATE 2: FORM STATE (Inputs: Marka, Ürün Adı, Barkod, Massive Stok Miktarı + Sheets Save)
          ========================================================================= */}
      {!isBatchView && currentState === "form" && (
        <div className="relative w-full h-full flex flex-col bg-black overflow-y-auto">
          {/* Header */}
          <header className="sticky top-0 z-20 flex items-center justify-between px-5 py-4 bg-black/90 backdrop-blur-md border-b border-zinc-900">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="font-mono text-sm font-bold tracking-wider text-zinc-100">
                STOK<span className="text-amber-400">NET</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              {aiDetected && (
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-full border border-amber-400/30">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  AI İle Dolduruldu
                </div>
              )}
              <div className="text-[11px] font-mono tracking-widest text-zinc-400 uppercase bg-zinc-900 px-3 py-1 rounded-full border border-zinc-800">
                Envanter Girişi
              </div>
            </div>
          </header>

          {/* Form Content */}
          <form
            onSubmit={handleSave}
            className="flex-1 w-full max-w-lg mx-auto flex flex-col justify-between p-5 gap-6"
          >
            <div className="flex flex-col gap-5">
              {/* Captured Photo Preview Card */}
              {capturedImage && (
                <div className="relative w-full rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800 shadow-xl group">
                  <div className="relative w-full h-36 bg-zinc-950 flex items-center justify-center">
                    <Image
                      src={capturedImage}
                      alt="Çekilen Ürün Fotoğrafı"
                      fill
                      sizes="(max-width: 768px) 100vw, 512px"
                      className="object-cover"
                      priority
                      unoptimized
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-black/40" />

                    {/* Badge */}
                    <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 backdrop-blur-md border border-zinc-700/60 text-[10px] font-mono text-zinc-300">
                      <Sparkles className="w-3 h-3 text-amber-400" />
                      Görüntü Analiz Edildi
                    </div>

                    {/* Quick Retake Photo Button on thumbnail */}
                    <button
                      type="button"
                      onClick={handleCancelAndRetake}
                      disabled={isSaving}
                      className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/80 hover:bg-black text-zinc-200 border border-zinc-700 text-xs font-medium transition-all active:scale-95 disabled:opacity-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Yeniden Çek
                    </button>
                  </div>
                </div>
              )}

              {/* AI Warning / Error notice: Hata Ayrıştırması (Timeout vs Google API / Sunucu Hatası) */}
              {aiErrorNotice && (
                <div
                  className={`p-3.5 rounded-2xl border text-xs flex items-start gap-2.5 animate-in fade-in duration-200 ${
                    aiErrorType === "timeout"
                      ? "bg-amber-500/10 border-amber-500/35 text-amber-200"
                      : "bg-red-500/15 border-red-500/40 text-red-200"
                  }`}
                >
                  <AlertCircle
                    className={`w-4 h-4 shrink-0 mt-0.5 ${
                      aiErrorType === "timeout" ? "text-amber-400" : "text-red-400"
                    }`}
                  />
                  <div className="flex-1">
                    <div
                      className={`font-mono font-bold mb-0.5 ${
                        aiErrorType === "timeout" ? "text-amber-300" : "text-red-300"
                      }`}
                    >
                      {aiErrorType === "timeout"
                        ? "⏱ İstek Zaman Aşımı (15s)"
                        : "⚠️ Google API / Sunucu Hatası"}
                    </div>
                    <div className="font-mono text-[11px] leading-relaxed text-zinc-300">
                      {aiErrorNotice}
                    </div>
                  </div>
                </div>
              )}

              {/* Save Error notice if Sheets API failed */}
              {saveError && (
                <div className="p-3.5 rounded-xl bg-red-500/15 border border-red-500/40 text-red-300 text-xs flex items-center gap-2.5 animate-in fade-in duration-200">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span className="font-mono leading-relaxed">{saveError}</span>
                </div>
              )}

              {/* Input 1: Marka (text - populated by Gemini AI, editable) */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between px-1">
                  <label
                    htmlFor="brand"
                    className="text-xs font-mono font-bold tracking-wider text-zinc-400 uppercase"
                  >
                    Marka
                  </label>
                  {aiDetected && formData.brand && (
                    <span className="text-[10px] font-mono text-amber-400/80">
                      Yapay Zeka Önerisi (Düzenlenebilir)
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="brand"
                    type="text"
                    value={formData.brand}
                    disabled={isSaving}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, brand: e.target.value }))
                    }
                    placeholder="Örn: Bosch, Makita, Kale Kilit..."
                    autoComplete="off"
                    className="w-full h-14 px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 focus:border-amber-400 focus:bg-zinc-900 text-zinc-100 placeholder:text-zinc-600 text-base font-medium outline-none transition-all shadow-inner disabled:opacity-60"
                  />
                  {formData.brand && !isSaving && (
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({ ...prev, brand: "" }))
                      }
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 active:scale-90"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Input 2: Ürün Adı (text - populated by Gemini AI, editable) */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between px-1">
                  <label
                    htmlFor="productName"
                    className="text-xs font-mono font-bold tracking-wider text-zinc-400 uppercase"
                  >
                    Ürün Adı
                  </label>
                  {aiDetected && formData.productName && (
                    <span className="text-[10px] font-mono text-amber-400/80">
                      Yapay Zeka Önerisi (Düzenlenebilir)
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="productName"
                    type="text"
                    value={formData.productName}
                    disabled={isSaving}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        productName: e.target.value,
                      }))
                    }
                    placeholder="Örn: Darbeli Matkap 750W, Çelik Dübel 10mm..."
                    autoComplete="off"
                    className="w-full h-14 px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 focus:border-amber-400 focus:bg-zinc-900 text-zinc-100 placeholder:text-zinc-600 text-base font-medium outline-none transition-all shadow-inner disabled:opacity-60"
                  />
                  {formData.productName && !isSaving && (
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({ ...prev, productName: "" }))
                      }
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 active:scale-90"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Input 3: Barkod (İsteğe Bağlı - populated by Gemini AI, editable) */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between px-1">
                  <label
                    htmlFor="barcode"
                    className="text-xs font-mono font-bold tracking-wider text-zinc-400 uppercase flex items-center gap-1.5"
                  >
                    <Barcode className="w-3.5 h-3.5 text-zinc-400" />
                    Barkod (İsteğe Bağlı)
                  </label>
                  {aiDetected && formData.barcode && (
                    <span className="text-[10px] font-mono text-amber-400/80">
                      Yapay Zeka Okudu (Düzenlenebilir)
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="barcode"
                    type="text"
                    value={formData.barcode}
                    disabled={isSaving}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        barcode: e.target.value,
                      }))
                    }
                    placeholder="Örn: 8690000000000 (Yoksa boş bırakılabilir)"
                    autoComplete="off"
                    className="w-full h-14 px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 focus:border-amber-400 focus:bg-zinc-900 text-zinc-100 placeholder:text-zinc-600 text-base font-mono outline-none transition-all shadow-inner disabled:opacity-60"
                  />
                  {formData.barcode && !isSaving && (
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({ ...prev, barcode: "" }))
                      }
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 active:scale-90"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Input 4: Stok Miktarı (MASSIVE, Auto-focus, Numeric Keypad) */}
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center justify-between px-1">
                  <label
                    htmlFor="stockQuantity"
                    className="text-xs font-mono font-bold tracking-wider text-amber-400 uppercase flex items-center gap-1.5"
                  >
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    Stok Miktarı (Adet)
                  </label>
                  <span className="text-[10px] font-mono text-amber-400/80 uppercase font-semibold">
                    ★ Manuel Giriş Odaklandı
                  </span>
                </div>

                {/* Massive Input Card */}
                <div className="relative rounded-2xl bg-zinc-900/95 border-2 border-amber-500/70 shadow-[0_0_24px_rgba(217,119,6,0.18)] p-4 flex flex-col items-center justify-center transition-all focus-within:border-amber-400 focus-within:shadow-[0_0_32px_rgba(217,119,6,0.3)]">
                  {/* Quick increment/decrement buttons flanking the massive number for mobile thumb reach */}
                  <div className="w-full flex items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => adjustQuantity(-1)}
                      className="w-14 h-14 rounded-xl bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-200 flex items-center justify-center active:scale-90 transition-all cursor-pointer disabled:opacity-50"
                      aria-label="1 Azalt"
                    >
                      <Minus className="w-6 h-6 stroke-[3]" />
                    </button>

                    <div className="flex-1 flex items-center justify-center">
                      <input
                        ref={stockInputRef}
                        id="stockQuantity"
                        type="number"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        autoFocus
                        disabled={isSaving}
                        value={formData.stockQuantity}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            stockQuantity: e.target.value,
                          }))
                        }
                        placeholder="0"
                        className="w-full text-center text-6xl sm:text-7xl font-mono font-black text-amber-400 bg-transparent outline-none tracking-tight placeholder:text-zinc-700 select-all disabled:opacity-60"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => adjustQuantity(1)}
                      className="w-14 h-14 rounded-xl bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-amber-400 flex items-center justify-center active:scale-90 transition-all cursor-pointer disabled:opacity-50"
                      aria-label="1 Artır"
                    >
                      <Plus className="w-6 h-6 stroke-[3]" />
                    </button>
                  </div>

                  {/* Quick Preset Buttons for rapid counting in hardware stores */}
                  <div className="w-full grid grid-cols-4 gap-2 mt-3 pt-3 border-t border-zinc-800/80">
                    {[5, 10, 25, 50].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        disabled={isSaving}
                        onClick={() => adjustQuantity(preset)}
                        className="py-1.5 rounded-lg bg-zinc-950/80 hover:bg-zinc-800/80 border border-zinc-800 text-[11px] font-mono text-zinc-400 hover:text-amber-300 active:scale-95 transition-all disabled:opacity-50"
                      >
                        +{preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Buttons: GIANT 'KAYDET' BUTTON & SECONDARY 'İPTAL / YENİDEN ÇEK' BUTTON */}
            <div className="flex flex-col gap-3 pt-4 pb-safe">
              {/* Giant Primary 'KAYDET' Button (Calls saveToSheets, with loading state & double click prevention) */}
              <button
                type="submit"
                disabled={isSaving || isAiProcessing}
                className="group relative w-full h-16 sm:h-18 rounded-2xl bg-gradient-to-r from-amber-400 via-amber-300 to-amber-500 text-black font-extrabold text-lg sm:text-xl font-mono tracking-wider shadow-[0_6px_28px_rgba(217,119,6,0.35)] hover:brightness-105 active:scale-[0.98] transition-all flex items-center justify-center gap-3 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-6 h-6 animate-spin text-black stroke-[3]" />
                    <span>E-TABLOYA KAYDEDİLİYOR...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-6 h-6 stroke-[3]" />
                    <span>KAYDET</span>
                  </>
                )}
              </button>

              {/* Secondary 'İPTAL / YENİDEN ÇEK' Button */}
              <button
                type="button"
                onClick={handleCancelAndRetake}
                disabled={isSaving || isAiProcessing}
                className="w-full h-14 rounded-xl bg-zinc-900 hover:bg-zinc-800/90 border border-zinc-800 hover:border-zinc-700 text-zinc-300 font-medium text-sm font-mono tracking-wide active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className="w-4 h-4 text-zinc-400" />
                İPTAL / YENİDEN ÇEK
              </button>
            </div>
          </form>
        </div>
      )}

      {/* =========================================================================
          BATCH PROCESSING VIEW (Toplu İşlem Modülü: Sıralı Kuyruk + 3s Bekleme + Hata Logu)
          ========================================================================= */}
      {isBatchView && (
        <div className="relative w-full h-full flex flex-col bg-black overflow-y-auto">
          {/* Header */}
          <header className="sticky top-0 z-20 flex items-center justify-between px-5 py-4 bg-black/95 backdrop-blur-md border-b border-zinc-900">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleCloseBatchView}
                aria-label="Kameraya Dön"
                className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-700 active:scale-95 transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="font-mono text-sm font-bold tracking-wider text-zinc-100">
                  STOK<span className="text-amber-400">NET</span>
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] font-mono tracking-wider text-amber-300 uppercase bg-amber-400/10 px-3 py-1 rounded-full border border-amber-400/30">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              Toplu İşlem
            </div>
          </header>

          <div className="flex-1 w-full max-w-lg mx-auto flex flex-col p-5 gap-5">
            {/* Progress Card ('İşleniyor: X / Y') */}
            <div className="rounded-2xl bg-zinc-900/95 border border-zinc-800 p-4 shadow-xl flex flex-col gap-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  {isBatchProcessing ? (
                    <Loader2 className="w-5 h-5 text-amber-400 animate-spin stroke-[2.5]" />
                  ) : (
                    <CheckCircle2 className="w-5 h-5 text-amber-400" />
                  )}
                  <span className="font-mono text-base sm:text-lg font-extrabold text-zinc-100">
                    {isBatchProcessing
                      ? `İşleniyor: ${batchProgress.current} / ${batchProgress.total}`
                      : `Tamamlandı: ${batchProgress.current} / ${batchProgress.total}`}
                  </span>
                </div>

                {isBatchProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      batchCancelRef.current = true;
                    }}
                    className="px-3 py-1.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300 font-mono text-xs font-bold active:scale-95 transition-all"
                  >
                    Durdur
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2.5 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 via-amber-400 to-amber-300 transition-all duration-300"
                  style={{
                    width: `${
                      batchProgress.total > 0
                        ? Math.round((batchProgress.current / batchProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>

              {/* Status Counters & Cooldown */}
              <div className="flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-3">
                  <span className="text-emerald-400 font-bold">
                    ✓ Kaydedildi: {batchItems.filter((i) => i.saved).length}
                  </span>
                  <span className="text-amber-300/90 font-bold">
                    ↻ Tekrar: {batchErrorLogs.length}
                  </span>
                </div>

                {batchWaitingCooldown && (
                  <div className="flex items-center gap-1.5 text-amber-300 animate-pulse">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Bekleniyor...</span>
                  </div>
                )}
              </div>

              {/* Live Status Banner (Displays exact retry status on 503/errors) */}
              {batchStatusText && (
                <div
                  className={`px-3 py-2 rounded-xl border font-mono text-xs leading-relaxed ${
                    batchStatusText.includes("yoğun")
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-300 font-bold"
                      : "bg-zinc-950/90 border-zinc-800 text-zinc-200"
                  }`}
                >
                  {batchStatusText}
                </div>
              )}

              {/* Current Processing Thumbnail */}
              {isBatchProcessing && batchCurrentImage && (
                <div className="flex items-center gap-3 pt-2 border-t border-zinc-800/80">
                  <div className="relative w-12 h-12 rounded-xl overflow-hidden border border-amber-400/40 shrink-0">
                    <Image
                      src={batchCurrentImage}
                      alt="İşlenen ürün"
                      fill
                      sizes="48px"
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-mono text-amber-300 font-semibold truncate">
                      {batchStatusText || "Etiket ve barkod okunuyor..."}
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500">
                      640x480 sıkıştırma aktif • İnatçı tekrar (while) kuyruğu
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Retry Log Box (Fault Tolerance - Never Skip) */}
            {batchErrorLogs.length > 0 && (
              <div className="rounded-2xl bg-amber-950/20 border border-amber-500/30 p-3.5 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs font-mono font-bold text-amber-300">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Tekrar Deneme Logu ({batchErrorLogs.length})</span>
                </div>
                <div className="max-h-28 overflow-y-auto flex flex-col gap-1 pr-1">
                  {batchErrorLogs.map((log, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-mono text-amber-200/85 bg-black/40 px-2.5 py-1.5 rounded-lg border border-amber-500/15"
                    >
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Processed Items List */}
            <div className="flex flex-col gap-3">
              {batchItems.map((item, idx) => (
                <div
                  key={item.id}
                  className={`rounded-2xl border p-3.5 transition-all ${
                    item.status === "error"
                      ? "bg-zinc-950/80 border-red-500/25 opacity-80"
                      : item.saved
                        ? "bg-zinc-900/60 border-emerald-500/40"
                        : "bg-zinc-900/95 border-zinc-800"
                  }`}
                >
                  {item.status === "error" ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-mono font-bold text-zinc-200 truncate">
                            #{idx + 1} • {item.fileName}
                          </div>
                          <div className="text-[11px] font-mono text-red-300 truncate">
                            Es Geçildi: {item.errorMessage}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-3">
                        {item.thumbnail && (
                          <div className="relative w-14 h-14 rounded-xl overflow-hidden border border-zinc-700 shrink-0">
                            <Image
                              src={item.thumbnail}
                              alt={item.fileName}
                              fill
                              sizes="56px"
                              className="object-cover"
                              unoptimized
                            />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-zinc-400 truncate">
                              #{idx + 1} • {item.fileName}
                            </span>
                            {item.saved ? (
                              <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/30 shrink-0">
                                Kaydedildi ✓
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSaveBatchItem(item.id)}
                                disabled={isBatchSavingAll}
                                className="text-[10px] font-mono font-bold text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 px-2.5 py-1 rounded-lg border border-amber-400/30 active:scale-95 transition-all shrink-0 disabled:opacity-50"
                              >
                                Kaydet
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={item.marka}
                          disabled={item.saved || isBatchSavingAll}
                          onChange={(e) => updateBatchItem(item.id, "marka", e.target.value)}
                          placeholder="Marka"
                          className="h-10 px-3 rounded-xl bg-zinc-950 border border-zinc-800 focus:border-amber-400 text-zinc-100 text-xs font-medium outline-none disabled:opacity-60"
                        />
                        <input
                          type="text"
                          value={item.urunAdi}
                          disabled={item.saved || isBatchSavingAll}
                          onChange={(e) => updateBatchItem(item.id, "urunAdi", e.target.value)}
                          placeholder="Ürün Adı"
                          className="h-10 px-3 rounded-xl bg-zinc-950 border border-zinc-800 focus:border-amber-400 text-zinc-100 text-xs font-medium outline-none disabled:opacity-60"
                        />
                        <input
                          type="text"
                          value={item.barkod}
                          disabled={item.saved || isBatchSavingAll}
                          onChange={(e) => updateBatchItem(item.id, "barkod", e.target.value)}
                          placeholder="Barkod (İsteğe Bağlı)"
                          className="h-10 px-3 rounded-xl bg-zinc-950 border border-zinc-800 focus:border-amber-400 text-zinc-100 text-xs font-mono outline-none disabled:opacity-60"
                        />
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono font-bold text-amber-400 uppercase shrink-0">
                            Stok:
                          </span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={item.stok}
                            disabled={item.saved || isBatchSavingAll}
                            onChange={(e) => updateBatchItem(item.id, "stok", e.target.value)}
                            placeholder="1"
                            className="w-full h-10 px-3 rounded-xl bg-zinc-950 border border-amber-500/50 focus:border-amber-400 text-amber-400 text-sm font-mono font-bold outline-none disabled:opacity-60"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Bottom Actions for Batch View */}
            {!isBatchProcessing && (
              <div className="flex flex-col gap-3 pt-2 pb-safe pb-6">
                {batchItems.some((item) => item.status === "success" && !item.saved) && (
                  <button
                    type="button"
                    onClick={handleSaveAllBatchItems}
                    disabled={isBatchSavingAll}
                    className="w-full h-16 rounded-2xl bg-gradient-to-r from-amber-400 via-amber-300 to-amber-500 text-black font-extrabold text-base sm:text-lg font-mono tracking-wider shadow-[0_6px_28px_rgba(217,119,6,0.35)] hover:brightness-105 active:scale-[0.98] transition-all flex items-center justify-center gap-3 cursor-pointer disabled:opacity-50"
                  >
                    {isBatchSavingAll ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-black stroke-[3]" />
                        <span>E-TABLOYA KAYDEDİLİYOR...</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-5 h-5 stroke-[3]" />
                        <span>
                          TÜMÜNÜ E-TABLOYA KAYDET (
                          {batchItems.filter((i) => i.status === "success" && !i.saved).length})
                        </span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => batchFileInputRef.current?.click()}
                  disabled={isBatchSavingAll}
                  className="w-full h-14 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-amber-400/40 text-amber-300 font-bold text-sm font-mono tracking-wide active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Layers className="w-4 h-4" />
                  YENİ TOPLU YÜKLEME YAP
                </button>

                <button
                  type="button"
                  onClick={handleCloseBatchView}
                  disabled={isBatchSavingAll}
                  className="w-full h-14 rounded-xl bg-zinc-900 hover:bg-zinc-800/90 border border-zinc-800 text-zinc-300 font-medium text-sm font-mono tracking-wide active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-4 h-4 text-zinc-400" />
                  KAMERAYA DÖN
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
