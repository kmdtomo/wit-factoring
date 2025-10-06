import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

// 環境変数から設定を取得する関数
const getEnvConfig = () => ({
  KINTONE_DOMAIN: process.env.KINTONE_DOMAIN || "",
  KINTONE_API_TOKEN: process.env.KINTONE_API_TOKEN || "",
  APP_ID: process.env.KINTONE_APP_ID || "37"
});

export const purchaseVerificationToolMinimal = createTool({
  id: "purchase-verification-minimal",
  description: "買取請求書のOCR結果とKintone買取データを照合（最小版）",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    purchaseDocuments: z.array(z.object({
      fileName: z.string(),
      text: z.string(),
      pageCount: z.number(),
      confidence: z.number(),
    })).describe("Google Vision OCRで抽出した買取書類データ"),
    model: z.string().optional().default("gpt-4o"),
  }),
  
  outputSchema: z.object({
    success: z.boolean(),
    verificationResult: z.enum(["一致", "部分一致", "不一致"]).describe("Kintone照合結果"),
  }),
  
  execute: async ({ context }) => {
    const { recordId, purchaseDocuments, model } = context;
    console.log(`[購入検証-最小] 開始 - recordId: ${recordId}`);
    
    try {
      // 1. Kintoneから買取情報を取得
      const config = getEnvConfig();
      const recordUrl = `https://${config.KINTONE_DOMAIN}/k/v1/records.json?app=${config.APP_ID}&query=$id="${recordId}"`;
      
      const recordResponse = await axios.get(recordUrl, {
        headers: {
          "X-Cybozu-API-Token": config.KINTONE_API_TOKEN,
        },
      });
      
      if (recordResponse.data.records.length === 0) {
        throw new Error(`レコードID: ${recordId} が見つかりません`);
      }
      
      const record = recordResponse.data.records[0];
      const buyInfo = record.買取情報?.value || [];
      
      // Kintoneデータの整形
      const kintoneData = {
        purchases: buyInfo.map((item: any) => ({
          company: item.value?.会社名_第三債務者_買取?.value || "",
          amount: parseInt(item.value?.総債権額?.value || "0"),
        })),
        applicant: record.屋号?.value || record.会社名?.value || "",
        totalAmount: buyInfo.reduce((sum: number, item: any) => 
          sum + parseInt(item.value?.総債権額?.value || "0"), 0),
      };
      
      console.log(`[購入検証-最小] Kintoneデータ取得完了 - 買取情報: ${kintoneData.purchases.length}件`);
      
      // 2. OCRテキストを結合
      const combinedText = purchaseDocuments
        .map(doc => `【${doc.fileName}】\n${doc.text}`)
        .join("\n\n---\n\n");
      
      // 3. プロンプト（申込者企業を除外）
      const analysisPrompt = `請求書から第三債務者（請求先企業）の企業名と金額を抽出してください。

【重要】申込者企業（${kintoneData.applicant}）は第三債務者として抽出しないでください。

OCRテキスト:
${combinedText.substring(0, 3000)}

Kintone登録データ（第三債務者）:
${kintoneData.purchases.map((p: any) => `${p.company}: ¥${p.amount.toLocaleString()}`).join('\n')}

以下のJSON形式で返答してください:
{
  "match": "yes" または "no" または "partial",
  "companies": [
    {"name": "第三債務者の企業名", "amount": 金額（数値）}
  ]
}

注意: 申込者企業（${kintoneData.applicant}）は除外してください。`;

      console.log(`[購入検証-最小] AI分析開始`);
      const startTime = Date.now();
      
      const result = await generateText({
        model: openai(model),
        prompt: analysisPrompt,
        temperature: 0,
      });
      
      const analysisTime = Date.now() - startTime;
      console.log(`[購入検証-最小] AI分析完了 - 処理時間: ${analysisTime}ms`);
      
      // 4. 結果の解析（超シンプル）
      let match: "yes" | "no" | "partial" = "no";
      let companies: any[] = [];
      
      try {
        const jsonMatch = result.text?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const matchValue = parsed.match || "no";
          match = (matchValue === "yes" || matchValue === "partial") ? matchValue : "no";
          companies = parsed.companies || [];
        }
      } catch (e) {}
      
      // 5. コスト計算
      const ocrCost = purchaseDocuments.reduce((sum, doc) => 
        sum + (doc.pageCount * 0.0015), 0);
      
      // 実際の使用トークン数からコスト計算
      const inputTokens = result.usage?.totalTokens || 0;
      const outputTokens = result.usage?.totalTokens || 0;
      const analysisCost = (inputTokens * 0.000003) + (outputTokens * 0.000015);
      
      // 6. 結果を返す（照合結果のみ）
      const verificationResult = match === "yes" ? "一致" as const : match === "partial" ? "部分一致" as const : "不一致" as const;

      console.log(`[購入検証-最小] 完了 - 照合結果: ${verificationResult}`);

      return {
        success: true,
        verificationResult,
      };
      
    } catch (error: any) {
      console.error("[購入検証-最小] エラー:", error.message);

      return {
        success: false,
        verificationResult: "不一致" as const,
      };
    }
  },
});