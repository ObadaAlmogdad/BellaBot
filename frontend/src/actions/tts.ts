"use server";

import { headers } from "next/headers";
import { cache } from "react";
import { env } from "~/env";
import { auth } from "~/lib/auth";
import { db } from "~/server/db";

interface GenerateSpeechData {
  text: string;
  voice_S3_key: string;
  language: string;
  exaggeration: number;
  cfg_weight: number;
}

interface GenerateSpeechResult {
  success: boolean;
  s3_key?: string;
  audioUrl?: string;
  projectId?: string;
  error?: string;
}

const USE_LOCAL_TTS_PROXY = true;

function buildTtsEndpoint(path: string): string {
  const base = env.TTS_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildAudioUrl(audioPath: string, s3KeyFromBackend?: string): string {
  if (audioPath && audioPath.startsWith("http")) {
    return audioPath;
  }
  if (audioPath) {
    return USE_LOCAL_TTS_PROXY
      ? `/audio/${audioPath.replace(/^\/audio\//, "").replace(/^\//, "")}`
      : `${env.TTS_API_URL?.replace(/\/$/, "")}${audioPath.startsWith("/") ? audioPath : `/${audioPath}`}`;
  }
  if (s3KeyFromBackend) {
    return USE_LOCAL_TTS_PROXY
      ? `/audio/${s3KeyFromBackend.replace(/^\//, "")}`
      : `${env.TTS_API_URL?.replace(/\/$/, "")}/audio/${s3KeyFromBackend.replace(/^\//, "")}`;
  }
  return "";
}

export async function generateSpeech(
  data: GenerateSpeechData,
): Promise<GenerateSpeechResult> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized" };
    }
    if (!data.text || !data.language) {
      return { success: false, error: "Missing required fields" };
    }

    const creditsNeeded = Math.max(1, Math.ceil(data.text.length / 100));

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { credits: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    if (user.credits < creditsNeeded) {
      return {
        success: false,
        error: `Insufficient credits. Need ${creditsNeeded}, have ${user.credits}`,
      };
    }

    const endpoint = buildTtsEndpoint("/generate-speech");

    const requestBody: Record<string, unknown> = {
      text: data.text,
      language: data.language,
      exaggeration: data.exaggeration ?? 0.5,
      cfg_weight: data.cfg_weight ?? 0.5,
    };

    if (data.voice_S3_key && data.voice_S3_key.trim().length > 0) {
      requestBody.voice_s3_key = data.voice_S3_key;
      requestBody.voice_path = data.voice_S3_key;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorMsg = "Failed to generate speech";
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
      s3_Key: string;
      audio_url?: string;
    };

    const s3Key = result.s3_Key;
    const audioUrl = buildAudioUrl(result.audio_url ?? "", s3Key);

    await db.user.update({
      where: { id: session.user.id },
      data: { credits: { decrement: creditsNeeded } },
    });

    const audioProject = await db.audioProject.create({
      data: {
        text: data.text,
        audioUrl,
        s3Key,
        language: data.language,
        voiceS3Key: data.voice_S3_key ?? "",
        exaggeration: data.exaggeration,
        cfgWeight: data.cfg_weight,
        userId: session.user.id,
      },
    });

    return {
      success: true,
      s3_key: s3Key,
      audioUrl,
      projectId: audioProject.id,
    };
  } catch (error) {
    console.error("Speech generation error:", error);
    return { success: false, error: "Internal server error" };
  }
}

export const getUserAudioProjects = cache(async () => {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized" };
    }

    const audioProjects = await db.audioProject.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return { success: true, audioProjects };
  } catch (error) {
    console.error("Error fetching audio projects:", error);
    return { success: false, error: "Failed to fetch audio projects" };
  }
});

export const getUserCredits = cache(async () => {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized", credits: 0 };
    }

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { credits: true },
    });

    if (!user) {
      return { success: false, error: "User not found", credits: 0 };
    }

    return { success: true, credits: user.credits };
  } catch (error) {
    console.error("Error fetching user credits:", error);
    return { success: false, error: "Failed to fetch credits", credits: 0 };
  }
});

export async function deleteAudioProject(id: string) {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { success: false, error: "Unauthorized" };
    }

    const project = await db.audioProject.findUnique({
      where: { id },
    });

    if (!project || project.userId !== session.user.id) {
      return { success: false, error: "Not found or unauthorized" };
    }

    await db.audioProject.delete({
      where: { id },
    });

    return { success: true };
  } catch (error) {
    console.error("Error deleting audio project:", error);
    return { success: false, error: "Failed to delete audio project" };
  }
}
