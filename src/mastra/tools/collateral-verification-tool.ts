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

export const collateralVerificationTool = createTool({
  id: "collateral-verification",
  description: "担保謄本から担保企業情報を抽出（事実のみ、照合はPhase 4で実施）",

  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    collateralDocuments: z.array(z.object({
      fileName: z.string(),
      text: z.string(),
      pageCount: z.number(),
      confidence: z.number(),
      documentType: z.string().optional(),
      extractedFacts: z.record(z.any()).optional(),
    })).describe("Google Vision OCRで抽出した担保書類データ"),
    model: z.enum(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo-preview", "gpt-4"]).optional().default("gpt-4o"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    keyFindings: z.array(z.string()).describe("担保書類から抽出された重要な発見事項"),
  }),
  
  execute: async ({ context }) => {
    const { recordId, collateralDocuments, model } = context;
    
    try {
      // 1. 担保ファイルがない場合の早期リターン
      if (!collateralDocuments || collateralDocuments.length === 0) {
        console.log(`[担保検証] 担保ファイルなし - recordId: ${recordId}`);
        return {
          success: true,
          keyFindings: [],
        };
      }
      
      // 2. OCRテキストと分類情報を結合
      const combinedText = collateralDocuments
        .map(doc => {
          let info = `【${doc.fileName}】\n`;
          if (doc.documentType) {
            info += `文書種別: ${doc.documentType}\n`;
          }
          if (doc.extractedFacts && Object.keys(doc.extractedFacts).length > 0) {
            info += `抽出済み情報: ${JSON.stringify(doc.extractedFacts, null, 2)}\n`;
          }
          info += `OCRテキスト:\n${doc.text}`;
          return info;
        })
        .join("\n\n---\n\n");

      // 3. AI分析の実行（事実抽出のみ）
      const analysisPrompt = `担保情報フィールドから添付された資料を分析し、担保に関する情報を抽出してください。

【担保フィールドの資料】
${combinedText}

以下のJSON形式で出力してください：
{
  "documents": [
    {
      "fileName": "ファイル名",
      "documentType": "資料の種類（登記簿謄本、請求書、契約書など）",
      "extractedInfo": {
        "会社名": "〇〇",
        "その他の情報": "..."
      }
    }
  ],
  "companies": [
    {
      "name": "会社名",
      "registrationNumber": "法人番号",
      "capital": 資本金（数値）,
      "establishedDate": "設立年月日",
      "representatives": ["代表者1", "代表者2"],
      "address": "本店所在地",
      "businessType": "事業内容"
    }
  ],
  "totalCompanies": 担保として識別された企業数,
  "keyFindings": ["ファイル名: 資料の種類 - 何が書いてあったか"]
}

【重要】
- 担保フィールドのファイルは全て担保情報として扱う
- 各ファイルが何の資料で、何が書いてあったかを明記
- 登記簿謄本以外（請求書、契約書など）も担保情報として記録
- 事実のみを抽出（照合や判定は不要）`;

      const result = await generateText({
        model: openai(model),
        prompt: analysisPrompt,
        temperature: 0,
      });

      console.log(`[担保情報抽出] AI応答:`, result.text?.substring(0, 500));

      // 4. JSON解析
      let structuredData: {
        documents: any[];
        companies: any[];
        totalCompanies: number;
        keyFindings: string[];
      } = {
        documents: [],
        companies: [],
        totalCompanies: 0,
        keyFindings: [],
      };

      try {
        const jsonMatch = result.text?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          structuredData = {
            documents: parsed.documents || [],
            companies: parsed.companies || [],
            totalCompanies: parsed.totalCompanies || (parsed.companies || []).length,
            keyFindings: parsed.keyFindings || [],
          };
        } else {
          console.error("JSON解析エラー: JSONが見つかりませんでした");
          structuredData.keyFindings = ["JSONが見つかりませんでした"];
        }
      } catch (e) {
        console.error("JSON解析エラー:", e);
        structuredData.keyFindings = ["データ抽出に失敗しました"];
      }

      // 5. 結果を返す（keyFindingsのみ）
      console.log(`[担保検証] 完了 - 発見事項: ${structuredData.keyFindings?.length || 0}件`);

      return {
        success: true,
        keyFindings: structuredData.keyFindings || [],
      };
      
    } catch (error: any) {
      console.error("[担保情報抽出] エラー:", error);

      return {
        success: false,
        keyFindings: [`エラー: ${error.message}`],
      };
    }
  },
});