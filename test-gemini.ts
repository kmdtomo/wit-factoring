import "dotenv/config";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

async function testGemini() {
  try {
    console.log("Gemini API テスト開始...\n");

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    // Test 1: Gemini 2.0 Flash
    console.log("=== Test 1: Gemini 2.0 Flash ===");
    const result1 = await generateText({
      model: google("gemini-2.0-flash-exp"),
      prompt: "こんにちは！簡単な自己紹介をしてください。",
    });
    console.log("✓ Gemini 2.0 Flash 成功！");
    console.log(result1.text.substring(0, 100) + "...\n");

    // Test 2: Gemini 2.5 Flash
    console.log("=== Test 2: Gemini 2.5 Flash ===");
    try {
      const result2 = await generateText({
        model: google("gemini-2.5-flash"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 2.5 Flash 成功！");
      console.log(result2.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 2.5 Flash 失敗:", e.message);
    }

    // Test 3: Gemini 2.5 Flash-Lite
    console.log("=== Test 3: Gemini 2.5 Flash-Lite ===");
    try {
      const result3 = await generateText({
        model: google("gemini-2.5-flash-lite"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 2.5 Flash-Lite 成功！");
      console.log(result3.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 2.5 Flash-Lite 失敗:", e.message);
    }

    // Test 4: Gemini 1.5 Flash
    console.log("=== Test 4: Gemini 1.5 Flash ===");
    try {
      const result4 = await generateText({
        model: google("gemini-1.5-flash"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 1.5 Flash 成功！");
      console.log(result4.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 1.5 Flash 失敗:", e.message);
    }

    // Test 5: Gemini 2.5 Pro (stable)
    console.log("=== Test 5: Gemini 2.5 Pro (stable) ===");
    try {
      const result5 = await generateText({
        model: google("gemini-2.5-pro"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 2.5 Pro 成功！");
      console.log(result5.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 2.5 Pro 失敗:", e.message);
    }

    // Test 6: Gemini 2.5 Pro Experimental
    console.log("=== Test 6: Gemini 2.5 Pro Experimental ===");
    try {
      const result6 = await generateText({
        model: google("gemini-2.5-pro-exp-03-25"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 2.5 Pro Experimental 成功！");
      console.log(result6.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 2.5 Pro Experimental 失敗:", e.message);
    }

    // Test 7: Gemini 2.5 Pro Preview
    console.log("=== Test 7: Gemini 2.5 Pro Preview ===");
    try {
      const result7 = await generateText({
        model: google("gemini-2.5-pro-preview-05-06"),
        prompt: "こんにちは！簡単な自己紹介をしてください。",
      });
      console.log("✓ Gemini 2.5 Pro Preview 成功！");
      console.log(result7.text.substring(0, 100) + "...\n");
    } catch (e: any) {
      console.log("✗ Gemini 2.5 Pro Preview 失敗:", e.message);
    }

    console.log("\n=== テスト完了 ===");

  } catch (error: any) {
    console.error("✗ エラー発生:");
    console.error(error.message);
    if (error.cause) {
      console.error("詳細:", error.cause);
    }
  }
}

testGemini();
