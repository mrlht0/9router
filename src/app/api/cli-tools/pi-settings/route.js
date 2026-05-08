"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const getConfigDir = () =>
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const getModelsPath = () => path.join(getConfigDir(), "models.json");
const getSettingsPath = () => path.join(getConfigDir(), "settings.json");
const getModelId = (model) => (typeof model === "string" ? model : model?.id);

const checkPiInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where pi" : "which pi";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

export async function GET() {
  try {
    const installed = await checkPiInstalled();
    const modelsPath = getModelsPath();
    const settingsPath = getSettingsPath();
    const modelsConfig = await readJson(modelsPath);
    const settingsConfig = await readJson(settingsPath);

    const providerConfig = modelsConfig?.providers?.["9router"];
    const piModels = providerConfig?.models || [];
    const activeModel =
      settingsConfig?.defaultProvider === "9router"
        ? settingsConfig.defaultModel || null
        : null;

    return NextResponse.json({
      installed,
      has9Router: !!providerConfig,
      modelsPath,
      settingsPath,
      pi: {
        models: piModels.map(getModelId).filter(Boolean),
        activeModel,
        baseURL: providerConfig?.baseUrl || null,
      },
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json(
      { error: "Failed to check Pi settings" },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, activeModel } = await request.json();

    const modelsArray = Array.isArray(models) ? models : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json(
        { error: "baseUrl and at least one model are required" },
        { status: 400 }
      );
    }

    const configDir = getConfigDir();
    const modelsPath = getModelsPath();
    const settingsPath = getSettingsPath();

    await fs.mkdir(configDir, { recursive: true });

    const modelsConfig = (await readJson(modelsPath)) || {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_9router";

    if (!modelsConfig.providers) modelsConfig.providers = {};
    modelsConfig.providers["9router"] = {
      baseUrl: normalizedBaseUrl,
      api: "openai-completions",
      apiKey: keyToUse,
      models: modelsArray.map((model) => ({
        id: model,
        name: model.split("/").pop() || model,
      })),
    };

    await fs.writeFile(modelsPath, JSON.stringify(modelsConfig, null, 2));

    if (activeModel === "") {
      const settingsConfig = (await readJson(settingsPath)) || {};
      if (settingsConfig.defaultProvider === "9router") {
        delete settingsConfig.defaultProvider;
        delete settingsConfig.defaultModel;
        await fs.writeFile(settingsPath, JSON.stringify(settingsConfig, null, 2));
      }
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        const settingsConfig = {
          ...((await readJson(settingsPath)) || {}),
          defaultProvider: "9router",
          defaultModel: finalActive,
        };

        await fs.writeFile(settingsPath, JSON.stringify(settingsConfig, null, 2));
      }
    }

    return NextResponse.json({
      success: true,
      message: "Pi settings applied successfully!",
      modelsPath,
    });
  } catch (error) {
    console.log("Error applying pi settings:", error);
    return NextResponse.json(
      { error: "Failed to apply settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const settingsPath = getSettingsPath();

    const settingsConfig = await readJson(settingsPath);

    if (clearActiveModel && settingsConfig?.defaultProvider === "9router") {
      delete settingsConfig.defaultProvider;
      delete settingsConfig.defaultModel;
      await fs.writeFile(settingsPath, JSON.stringify(settingsConfig, null, 2));
    }

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching pi settings:", error);
    return NextResponse.json(
      { error: "Failed to patch settings" },
      { status: 500 }
    );
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const modelsPath = getModelsPath();
    const settingsPath = getSettingsPath();

    const modelsConfig = await readJson(modelsPath);

    if (!modelsConfig?.providers?.["9router"]) {
      return NextResponse.json({
        success: true,
        message: "No 9router configuration to remove",
      });
    }

    const settingsConfig = await readJson(settingsPath);
    let shouldWriteSettings = false;

    if (modelToRemove) {
      const modelList = modelsConfig.providers["9router"].models || [];
      modelsConfig.providers["9router"].models = modelList.filter(
        (model) => getModelId(model) !== modelToRemove
      );

      if (modelsConfig.providers["9router"].models.length === 0) {
        delete modelsConfig.providers["9router"];
        if (settingsConfig?.defaultProvider === "9router") {
          delete settingsConfig.defaultProvider;
          delete settingsConfig.defaultModel;
          shouldWriteSettings = true;
        }
      } else if (
        settingsConfig?.defaultProvider === "9router" &&
        settingsConfig.defaultModel === modelToRemove
      ) {
        settingsConfig.defaultModel = getModelId(modelsConfig.providers["9router"].models[0]);
        shouldWriteSettings = true;
      }
    } else {
      delete modelsConfig.providers["9router"];
      if (Object.keys(modelsConfig.providers).length === 0) {
        delete modelsConfig.providers;
      }
      if (settingsConfig?.defaultProvider === "9router") {
        delete settingsConfig.defaultProvider;
        delete settingsConfig.defaultModel;
        shouldWriteSettings = true;
      }
    }

    await fs.writeFile(modelsPath, JSON.stringify(modelsConfig, null, 2));

    if (shouldWriteSettings) {
      await fs.writeFile(settingsPath, JSON.stringify(settingsConfig, null, 2));
    }

    return NextResponse.json({
      success: true,
      message: modelToRemove
        ? `Model "${modelToRemove}" removed`
        : "9Router settings removed from Pi",
    });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json(
      { error: "Failed to reset Pi settings" },
      { status: 500 }
    );
  }
}
