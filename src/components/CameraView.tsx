"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Camera,
  FlipHorizontal,
  Zap,
  ZapOff,
  Image as ImageIcon,
  AlertCircle,
} from "lucide-react";

interface CameraViewProps {
  onCapture: (base64Image: string) => void;
  isProcessing: boolean;
}

export default function CameraView({ onCapture, isProcessing }: CameraViewProps) {
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [shutterEffect, setShutterEffect] = useState(false);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let isMounted = true;
    let localStream: MediaStream | null = null;

    async function initCamera() {
      setCameraError(null);
      setTorchOn(false);

      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        if (isMounted) {
          setCameraError("Bu tarayıcı veya cihaz kamera erişimini desteklemiyor.");
        }
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
        if (!isMounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStream = stream;
        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Torch capability check
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && typeof videoTrack.getCapabilities === "function") {
          const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
          };
          if (isMounted) {
            setHasTorch(Boolean(capabilities?.torch));
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg =
            err instanceof Error ? err.message : "Kamera başlatılamadı.";
          console.warn("Kamera erişim hatası:", msg);
          setCameraError(
            "Kamera akışı başlatılamadı. Lütfen kamera izinlerini verin veya dosya seçin."
          );
        }
      }
    }

    initCamera();

    return () => {
      isMounted = false;
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [facingMode, retryTrigger]);

  // Capture screenshot from video stream scaled to max 640x480 with 0.5 quality
  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video) return;

    // Trigger visual shutter flash
    setShutterEffect(true);
    setTimeout(() => setShutterEffect(false), 150);

    const canvas = canvasRef.current || document.createElement("canvas");
    canvasRef.current = canvas;

    const rawWidth = video.videoWidth || 640;
    const rawHeight = video.videoHeight || 480;

    // Scale down keeping aspect ratio (max width 640, max height 480)
    const MAX_WIDTH = 640;
    const MAX_HEIGHT = 480;
    let targetWidth = rawWidth;
    let targetHeight = rawHeight;

    if (targetWidth > MAX_WIDTH || targetHeight > MAX_HEIGHT) {
      const ratio = Math.min(MAX_WIDTH / targetWidth, MAX_HEIGHT / targetHeight);
      targetWidth = Math.round(targetWidth * ratio);
      targetHeight = Math.round(targetHeight * ratio);
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      if (facingMode === "user") {
        ctx.translate(targetWidth, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      // High compression (0.5 quality) keeps payload under 100-200 KB
      const base64Image = canvas.toDataURL("image/jpeg", 0.5);

      // Stop stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      onCapture(base64Image);
    }
  };

  // Toggle flashlight / torch
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track) {
      try {
        const nextState = !torchOn;
        await (track as MediaStreamTrack & {
          applyConstraints: (c: unknown) => Promise<void>;
        }).applyConstraints({
          advanced: [{ torch: nextState }],
        });
        setTorchOn(nextState);
      } catch (e) {
        console.warn("Torch not supported", e);
      }
    }
  };

  // Flip camera
  const toggleCameraFacing = () => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  // File upload fallback with compression (max 640x480, quality 0.5)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      if (result) {
        const img = new window.Image();
        img.onload = () => {
          const canvas = canvasRef.current || document.createElement("canvas");
          let targetWidth = img.width;
          let targetHeight = img.height;
          const MAX_WIDTH = 640;
          const MAX_HEIGHT = 480;

          if (targetWidth > MAX_WIDTH || targetHeight > MAX_HEIGHT) {
            const ratio = Math.min(MAX_WIDTH / targetWidth, MAX_HEIGHT / targetHeight);
            targetWidth = Math.round(targetWidth * ratio);
            targetHeight = Math.round(targetHeight * ratio);
          }

          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
            const compressed = canvas.toDataURL("image/jpeg", 0.5);
            if (streamRef.current) {
              streamRef.current.getTracks().forEach((track) => track.stop());
              streamRef.current = null;
            }
            onCapture(compressed);
          } else {
            onCapture(result);
          }
        };
        img.src = result;
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="relative w-full h-full flex flex-col justify-between bg-black overflow-hidden">
      {/* Offscreen Canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileUpload}
      />

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

        {/* Viewfinder Reticle */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <div className="relative w-full max-w-xs aspect-square border border-white/10 rounded-2xl">
            {/* Reticle Corners (Gold) */}
            <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-amber-400/90 rounded-tl-lg" />
            <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-amber-400/90 rounded-tr-lg" />
            <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-amber-400/90 rounded-bl-lg" />
            <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-amber-400/90 rounded-br-lg" />

            {/* Crosshair */}
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

      {/* Camera Header */}
      <header className="relative z-20 flex items-center justify-between px-5 pt-safe pt-4 pb-3 bg-gradient-to-b from-black/90 via-black/50 to-transparent backdrop-blur-xs">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
          <span className="font-mono text-xs font-bold tracking-wider text-zinc-200">
            STOK<span className="text-amber-400">NET</span>
          </span>
          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-zinc-900/90 border border-zinc-800 text-zinc-400">
            PWA
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

          {/* Flip camera */}
          <button
            type="button"
            onClick={toggleCameraFacing}
            aria-label="Kamerayı Döndür"
            className="p-3 rounded-full bg-zinc-900/80 text-zinc-300 border border-zinc-800 hover:border-zinc-700 active:scale-95 transition-all"
          >
            <FlipHorizontal className="w-5 h-5" />
          </button>

          {/* Fallback upload */}
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

      {/* Camera Error Fallback Card */}
      {cameraError && (
        <div className="relative z-30 mx-4 my-auto p-6 rounded-2xl bg-zinc-950/95 border border-red-500/30 text-center shadow-2xl backdrop-blur-md">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-white mb-2">Kamera Akışı Başlatılamadı</h3>
          <p className="text-xs text-zinc-400 mb-6 leading-relaxed">{cameraError}</p>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setRetryTrigger((c) => c + 1)}
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
            disabled={isProcessing}
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
  );
}

