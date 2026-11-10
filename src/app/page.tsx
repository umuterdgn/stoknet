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

// Kamera görüntüsünü veya video akışını yakaladığında şu sıkıştırma fonksiyonunu çalıştır:
const compressImage = (imageSrc: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.src = imageSrc;
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
  });
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

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stockInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    if (mounted && currentState === "camera" && !isAiProcessing) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [mounted, currentState, isAiProcessing, startCamera, stopCamera]);

  // Auto-focus stock quantity input immediately upon rendering Form State (Safe: no setState)
  useEffect(() => {
    if (currentState === "form") {
      const timer = setTimeout(() => {
        if (stockInputRef.current) {
          stockInputRef.current.focus();
          stockInputRef.current.select();
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [currentState]);

  // Process image with Gemini Vision via Server Action
  const runAiVisionProcessing = async (base64Image: string) => {
    setIsAiProcessing(true);
    setAiErrorNotice(null);
    setAiDetected(false);
    setSaveError(null);

    try {
      const result = await processImage(base64Image);

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
      console.error("AI Vision invocation error:", err);
      const cleanMsg =
        err?.message ||
        "Görüntü analiz edilirken bir hata oluştu. Bilgileri manuel olarak doldurabilirsiniz.";
      setAiErrorNotice(cleanMsg);
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
  // Video akışından görüntüyü yakalar, compressImage ile sıkıştırır ve processImage'e gönderir.
  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video) return;

    // Deklanşör flaş animasyonu
    setShutterEffect(true);
    setTimeout(() => setShutterEffect(false), 150);

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
    const compressedImage = await compressImage(rawImageSrc);

    // Kamera donanımını kapat ve önizlemeyi kaydet
    stopCamera();
    setCapturedImage(compressedImage);

    // Dönen sıkıştırılmış base64 string Server Action'a (processImage) verilsin
    startTransition(() => {
      runAiVisionProcessing(compressedImage);
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
        const compressed = await compressImage(result);
        stopCamera();
        setCapturedImage(compressed);
        startTransition(() => {
          runAiVisionProcessing(compressed);
        });
      }
    };
    reader.readAsDataURL(file);
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
      {currentState === "camera" && (
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
              </div>
            </div>
          )}

          {/* Bottom Fixed Action Bar: MASSIVE 'FOTOĞRAF ÇEK' BUTTON */}
          <div className="relative z-20 w-full p-5 pb-safe pb-8 bg-gradient-to-t from-black via-black/80 to-transparent">
            <div className="w-full max-w-md mx-auto">
              <button
                type="button"
                onClick={capturePhoto}
                disabled={isAiProcessing}
                className="group relative w-full h-20 sm:h-22 rounded-3xl bg-zinc-900 border-2 border-amber-400/80 hover:border-amber-400 active:scale-[0.97] transition-all duration-150 flex items-center justify-center gap-4 shadow-[0_8px_32px_rgba(217,119,6,0.28)] overflow-hidden cursor-pointer disabled:opacity-50"
              >
                {/* Subtle gold ambient glow background */}
                <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-400/20 to-amber-500/10 group-hover:from-amber-500/20 group-hover:to-amber-500/20 transition-colors" />

                {/* Shutter Button Ring Icon */}
                <div className="relative flex items-center justify-center w-12 h-12 rounded-full border-2 border-amber-400 bg-amber-400/20 shadow-inner group-active:scale-90 transition-transform">
                  <div className="w-8 h-8 rounded-full bg-amber-400 flex items-center justify-center text-black">
                    <Camera className="w-5 h-5 fill-black stroke-black" />
                  </div>
                </div>

                {/* Button Text */}
                <span className="relative text-xl sm:text-2xl font-black tracking-wider text-amber-300 font-mono uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
                  FOTOĞRAF ÇEK
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          STATE 2: FORM STATE (Inputs: Marka, Ürün Adı, Barkod, Massive Stok Miktarı + Sheets Save)
          ========================================================================= */}
      {currentState === "form" && (
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

              {/* AI Warning / Error notice */}
              {aiErrorNotice && (
                <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5 animate-in fade-in duration-200">
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-mono font-bold text-amber-300 mb-0.5">
                      Yapay Zeka Etiket Okuma Bildirimi
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
    </main>
  );
}
