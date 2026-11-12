"use server";

import { auth } from "~/lib/auth";
import { headers } from "next/headers";

import { env } from "~/env";
import { db } from "~/server/db";
import { cache } from "react";

const USE_LOCAL_TTS_PROXY = true;

function buildUploadEndpoint(): string {
  const base = env.TTS_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";
  return `${base}/upload-voice`;
}

function buildVoiceAudioUrl(
  urlFromBackend: string,
  filePathFromBackend?: string,
): string {
  if (urlFromBackend && urlFromBackend.startsWith("http")) {
    return urlFromBackend;
  }
  if (USE_LOCAL_TTS_PROXY) {
    const rel = (urlFromBackend || filePathFromBackend || "")
      .replace(/^\/audio\//, "")
      .replace(/^\//, "");
    return `/audio/${rel}`;
  }
  const base = env.TTS_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";
  if (urlFromBackend) {
    return `${base}${urlFromBackend.startsWith("/") ? urlFromBackend : `/${urlFromBackend}`}`;
  }
  if (filePathFromBackend) {
    return `${base}/audio/${filePathFromBackend.replace(/^\//, "")}`;
  }
  return "";
}

interface UploadVoiceResult {
  success: boolean;
  id?: string;
  s3Key?: string;
  url?: string;
  error?: string;
}

export async function uploadVoice(
  formData: FormData,
): Promise<UploadVoiceResult> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized" };
    }

    const file = formData.get("voice") as File;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    if (!file.type.startsWith("audio/")) {
      return { success: false, error: "File must be audio" };
    }

    if (file.size > 10 * 1024 * 1024) {
      return { success: false, error: "File must be under 10MB" };
    }

    const backendForm = new FormData();
    backendForm.append("voice", file, file.name);
    backendForm.append("user_id", session.user.id);

    const endpoint = buildUploadEndpoint();

    const response = await fetch(endpoint, {
      method: "POST",
      body: backendForm,
    });

    if (!response.ok) {
      let errorMsg = "Failed to upload voice file";
      try {
        const err = await response.json();
        if (err?.detail) {
          errorMsg = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
        }
      } catch {
        // ignore parse error
      }
      return { success: false, error: errorMsg };
    }

    const result = (await response.json()) as {
      file_path: string;
      url: string;
      file_name: string;
    };

    const s3Key = result.file_path;
    const finalUrl = buildVoiceAudioUrl(result.url, result.file_path);

    const uploadedVoice = await db.uploadedVoice.create({
      data: {
        name: file.name,
        s3Key,
        url: finalUrl,
        userId: session.user.id,
      },
    });
    return {
      success: true,
      id: uploadedVoice.id,
      s3Key,
      url: finalUrl,
    };
  } catch (error) {
    console.error("Voice upload error:", error);
    return { success: false, error: "Failed to upload voice file" };
  }
}

export const getUserUploadedVoices = cache(async () => {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized", voices: [] };
    }

    const uploadedVoices = await db.uploadedVoice.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return { success: true, voices: uploadedVoices };
  } catch (error) {
    console.error("Error fetching uploaded voices:", error);
    return {
      success: false,
      error: "Failed to fetch uploaded voices",
      voices: [],
    };
  }
});
